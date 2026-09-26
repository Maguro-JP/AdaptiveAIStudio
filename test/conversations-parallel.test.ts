/**
 * 一つの作業場で、二つの会話を同時に動かしても混ざらない（DECISIONS 09-26 の 2c）。
 *
 * 画面で二つの会話を同時に動かすと、どちらも同じ `Session`（共有の作業場）を通る。履歴・差分・
 * 規則の積み重ね・協議が会話ごとに分かれていないと、片方の会話の言葉がもう片方の続きとして
 * モデルに渡り、協議も別の会話の分で通ってしまう。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { startFakeServer, type FakeServer } from './fake-server.ts';
import { Conversation } from '../src/core/conversation.ts';
import { Forum, requiresDeliberation } from '../src/harness/deliberation.ts';
import type { RuleContext } from '../src/harness/rules.ts';
import { Harness } from '../src/harness/harness.ts';
import { HarnessMetrics } from '../src/harness/metrics.ts';
import { readBeforeWrite } from '../src/harness/builtin-rules.ts';
import { readFileTool, writeFileTool } from '../src/agent/tools/fs.ts';
import { writeFile } from 'node:fs/promises';

process.env.AAS_STATE_DIR = await tempDir('aas-conv-parallel-state-');
const { Session } = await import('../src/core/session.ts');

let fake: FakeServer;
// 答えるまで待たせて、二つの依頼を確実に重ねる。答えは最後に言われたことをそのまま返す。
before(async () => { fake = await startFakeServer({ kind: 'echo', delayMs: 400 }); });
after(async () => { await fake.close(); });

async function open() {
  const root = join(await tempDir('aas-conv-parallel-'), 'project');
  await mkdir(root, { recursive: true });
  return Session.create({
    providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: fake.baseUrl, locality: 'local', models: ['m'] }],
    candidates: ['local:m'],
    runtime: { kind: 'none' },
    agent: { root, approval: 'auto', verify: { enabled: false }, maxTurns: 3 },
    initiative: { enabled: false },
  } as never, { approve: () => Promise.resolve(true) });
}

const texts = (c: Conversation) => c.history.map((m) => (typeof m.content === 'string' ? m.content : '')).join(' / ');

describe('一つの作業場で、二つの会話を同時に動かす', { timeout: 60_000 }, () => {
  test('同時に送っても、それぞれの履歴には自分のやりとりだけが入る', async () => {
    const session = await open();
    try {
      const a = new Conversation();
      const b = new Conversation();
      const drain = async (conv: Conversation, text: string) => {
        const seen: string[] = [];
        for await (const ev of session.send(text, { conversation: conv })) seen.push(ev.type);
        return seen;
      };
      fake.resetMaxInFlight();
      const both = Promise.all([drain(a, 'りんごの話'), drain(b, 'みかんの話')]);
      await new Promise((r) => setTimeout(r, 100));
      // 既定でない会話が走っている間も「どれかが走っている」（暇な思考はこれで断る）。
      assert.equal(session.anyBusy, true, '走っている会話を数えていない');
      assert.equal(session.busy, false, '既定の会話まで走っていることになった');
      const [sa, sb] = await both;
      assert.equal(session.anyBusy, false, '終わっても走っていることになっている');
      assert.ok(sa.includes('settled') && sb.includes('settled'), `終わっていない: ${sa.join(',')} | ${sb.join(',')}`);
      // 同時に走った（モデルの口が二本同時に受けた）。時間で見ると負荷で揺れるので、重なりを数える。
      assert.ok(fake.maxInFlight >= 2, `順番に走っている: 同時に受けたのは ${fake.maxInFlight} 本`);
      assert.match(texts(a), /りんご/);
      assert.doesNotMatch(texts(a), /みかん/, `A にみかんが混ざった: ${texts(a)}`);
      assert.match(texts(b), /みかん/);
      assert.doesNotMatch(texts(b), /りんご/, `B にりんごが混ざった: ${texts(b)}`);
      // 既定の会話は触っていない。
      assert.equal(session.history.length, 0, '既定の会話に積まれた');
    } finally {
      await session.close();
    }
  });

  test('同じ会話に二つ目を送ると、断る（会話の中では一つずつ）', async () => {
    const session = await open();
    try {
      const a = new Conversation();
      const first = (async () => { for await (const _ of session.send('一つ目', { conversation: a })) { /* 流す */ } })();
      await new Promise((r) => setTimeout(r, 50));
      const logs: string[] = [];
      for await (const ev of session.send('二つ目', { conversation: a })) if (ev.type === 'log') logs.push(ev.text);
      assert.ok(logs.some((t) => t.includes('別の作業')), `断っていない: ${logs.join(' / ')}`);
      await first;
    } finally {
      await session.close();
    }
  });
});

describe('協議は会話ごと', () => {
  const write = (path: string) => ({ id: '', name: 'write_file', args: { path, content: 'x' } });
  const ctx = (forum?: Forum): RuleContext => ({
    root: process.cwd(), history: [], instruction: '', signal: new AbortController().signal,
    ...(forum ? { forum } : {}),
  });

  test('別の会話の協議では、この会話の守りの変更は通らない', async () => {
    const shared = new Forum();
    const rule = requiresDeliberation({ forum: shared });
    const mine = new Forum();
    const other = new Forum();
    other.add({ subject: 's', reason: 'r', impact: 'i', rollback: 'b', paths: ['src/harness/gate.ts'], at: Date.now() });
    assert.equal((await rule.pre!(write('src/harness/gate.ts'), ctx(mine))).kind, 'deny', '別の会話の協議で通った');
    mine.add({ subject: 's', reason: 'r', impact: 'i', rollback: 'b', paths: ['src/harness/gate.ts'], at: Date.now() });
    assert.equal((await rule.pre!(write('src/harness/gate.ts'), ctx(mine))).kind, 'allow', '自分の協議で通らない');
  });
});

describe('規則の積み重ねは会話ごと', () => {
  test('別の会話が読んだことで、この会話の上書きは通らない（読んでから書く規則）', async () => {
    const root = await tempDir('aas-conv-rules-');
    await writeFile(join(root, 'a.txt'), 'もと\n');
    const harness = new Harness({ rules: [readBeforeWrite] });
    const [read, write] = harness.wrapAll([readFileTool, writeFileTool], () => '');
    const a = new Conversation();
    const b = new Conversation();
    const ctx = (conv: Conversation) => ({
      root, signal: new AbortController().signal, approve: () => Promise.resolve(true as const), request: conv.request,
    });
    await read!.run({ path: 'a.txt' }, ctx(a));
    const byB = await write!.run({ path: 'a.txt', content: 'B\n' }, ctx(b));
    assert.equal(byB.isError, true, `A が読んだことで B の上書きが通った: ${byB.content}`);
    const byA = await write!.run({ path: 'a.txt', content: 'A\n' }, ctx(a));
    assert.equal(byA.isError, undefined, `自分で読んだのに通らない: ${byA.content}`);
  });
});

describe('規則の数えは既定の会話の分だけ', () => {
  test('数えない会話で規則が止めても、成績に数えない。数える会話なら数える', async () => {
    const root = await tempDir('aas-conv-metrics-');
    await writeFile(join(root, 'a.txt'), 'もと\n');
    const metrics = new HarnessMetrics();
    const harness = new Harness({ rules: [readBeforeWrite], metrics });
    const [, write] = harness.wrapAll([readFileTool, writeFileTool], () => '');
    const other = new Conversation();
    const main = new Conversation();
    main.counted = true;
    const ctx = (conv: Conversation) => ({
      root, signal: new AbortController().signal, approve: () => Promise.resolve(true as const), request: conv.request,
    });
    const denials = () => metrics.report(['read-before-write']).rules[0]!.denials;
    harness.beginTask();
    const byOther = await write!.run({ path: 'a.txt', content: 'x\n' }, ctx(other));
    assert.equal(byOther.isError, true, '前提: 止められていない');
    assert.equal(denials(), 0, 'ほかの会話で止めた回を数えた');
    await write!.run({ path: 'a.txt', content: 'x\n' }, ctx(main));
    assert.equal(denials(), 1, '既定の会話で止めた回を数えていない');
  });
});

describe('止めるときは全部の会話を止める', { timeout: 30_000 }, () => {
  test('abort は、既定でない会話が走っていても止める', async () => {
    fake.setBehavior({ kind: 'echo', delayMs: 3000 });
    const session = await open();
    try {
      const a = new Conversation();
      let reason: string | undefined;
      const run = (async () => {
        for await (const ev of session.send('ゆっくり答えて', { conversation: a })) if (ev.type === 'settled') reason = ev.reason;
      })();
      await new Promise((r) => setTimeout(r, 200));
      session.abort();
      await run;
      assert.notEqual(reason, 'completed', '止めたのに最後まで走った');
      assert.equal(session.anyBusy, false);
    } finally {
      fake.setBehavior({ kind: 'echo', delayMs: 400 });
      await session.close();
    }
  });
});

