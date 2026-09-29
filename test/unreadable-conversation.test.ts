/**
 * 読めない会話を、中身の無い会話として本体に載せない・別の会話で続けない。
 *
 * 読めなさは、会話のファイルの場所にフォルダを置いて作る（権限に頼らない。root でも同じ結果になる）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir, rename, rmdir } from 'node:fs/promises';
import { tempDir } from './tmp.ts';
import { until } from './until.ts';
import { startFakeServer, type FakeServer } from './fake-server.ts';

const { UiServer } = await import('../src/ui/server.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');
const { UnfinishedWork } = await import('../src/core/unfinished.ts');
const { Conversations } = await import('../src/core/conversations.ts');

/** この試験だけの状態のフォルダに切り替える。器を作る前に呼ぶ。 */
async function ownState(name: string): Promise<string> {
  const d = await tempDir(`aas-unreadable-conv-${name}-`);
  process.env.AAS_STATE_DIR = d;
  return d;
}

function serverFor(fake: FakeServer, root: string) {
  return new UiServer({
    port: 0,
    config: {
      ...DEFAULT_CONFIG,
      providers: [{ id: 'p', kind: 'openai-compatible', baseUrl: fake.baseUrl, locality: 'local', models: ['m'] }],
      candidates: ['p:m'],
      runtime: { kind: 'ollama' },
      agent: { root, approval: 'auto' },
      initiative: { enabled: false },
    } as typeof DEFAULT_CONFIG,
  });
}

const fileOf = (state: string, id: string) => join(state, 'conversations', `${id}.jsonl`);
async function block(state: string, id: string): Promise<void> {
  await rename(fileOf(state, id), `${fileOf(state, id)}.away`);
  await mkdir(fileOf(state, id));
}
async function unblock(state: string, id: string): Promise<void> {
  await rmdir(fileOf(state, id));
  await rename(`${fileOf(state, id)}.away`, fileOf(state, id));
}
const post = (base: string, p: string, body?: unknown) => fetch(base + p, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
});
async function sendAndWait(base: string, text: string): Promise<string> {
  const r = await (await post(base, '/api/send', { text })).json() as { conversationId: string };
  await until(async () => {
    const c = await (await fetch(`${base}/api/conversations`)).json() as { running: string | null; runningAll: string[] };
    return c.running === null && c.runningAll.length === 0;
  }, `「${text}」が終わる`, { timeoutMs: 15_000, everyMs: 50 });
  return r.conversationId;
}
const allText = (fake: FakeServer) => JSON.stringify(fake.bodies);

test('本体を組むときに読めなかった会話は「載っていない」ままにし、次に送るときに読み直す', async () => {
  const state = await ownState('session');
  const root = await tempDir('aas-unreadable-conv-root-');
  const fake = await startFakeServer({ kind: 'echo' });
  try {
    // 一つ目の本体で会話を作って話しておく
    const first = serverFor(fake, root);
    const base1 = (await first.start()).replace(/\/$/, '');
    const id = await sendAndWait(base1, '一つ目の依頼（覚えておいて）');
    await first.stop();

    // 二つ目の本体。会話を選んでから（本体はまだ無い）、読めなくして本体を組む
    const second = serverFor(fake, root);
    const base2 = (await second.start()).replace(/\/$/, '');
    try {
      const sel = await post(base2, '/api/conversations/select', { id });
      assert.equal(sel.status, 200, await sel.text());
      await block(state, id);
      await second.session();
      await unblock(state, id);

      // 読めるようになってから送ると、前のやりとりを載せてから走る
      const before = fake.bodies.length;
      await sendAndWait(base2, '二つ目の依頼');
      const sent = JSON.stringify(fake.bodies.slice(before));
      assert.match(sent, /一つ目の依頼（覚えておいて）/, '読み直さず、前のやりとりを知らないまま続けた');
    } finally {
      await second.stop();
    }
  } finally {
    await fake.close();
  }
});

test('やり残しの会話を読めないときは、いま載っている別の会話で続きを走らせない', async () => {
  const state = await ownState('resume');
  const root = await tempDir('aas-unreadable-conv-root-');
  const fake = await startFakeServer({ kind: 'echo' });
  const server = serverFor(fake, root);
  const base = (await server.start()).replace(/\/$/, '');
  try {
    // 本体に載っている会話（別の会話）を作っておく
    const other = await sendAndWait(base, '別の会話の依頼');
    // やり残しの会話を作り、読めなくする
    const conversations = new Conversations(join(state, 'conversations'));
    const stuck = (await conversations.create()).id;
    await conversations.append(stuck, [{ role: 'user', content: 'やり残しの会話の中身' }]);
    const store = new UnfinishedWork(join(state, 'unfinished.jsonl'));
    const item = (await store.add({ request: 'やり残しの依頼', why: 'noProgress', note: 'x', conversationId: stuck }))!;
    await store.bump(item.id, Date.now() - 60 * 60_000);
    await block(state, stuck);

    const before = fake.bodies.length;
    const session = await server.session();
    await server.idleTick(session);
    await new Promise((r) => setTimeout(r, 300));
    assert.doesNotMatch(JSON.stringify(fake.bodies.slice(before)), /前回の続きです/, '読めない会話の続きを、別の会話で走らせた');
    const left = (await store.list()).find((u) => u.id === item.id);
    assert.ok(left, 'やり残しが消えた');
    const otherNow = await (await fetch(`${base}/api/conversations/messages?id=${other}`)).json() as { messages: { content: string }[] };
    assert.ok(!otherNow.messages.some((m) => m.content.includes('前回の続きです')), '別の会話のファイルへ続きを書いた');
    await unblock(state, stuck);
  } finally {
    await server.stop();
    await fake.close();
  }
});
