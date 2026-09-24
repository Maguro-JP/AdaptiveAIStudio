/**
 * 外のツール（MCP）だけで書いて終わった回も、確かめる。
 *
 * 作業後の確かめは、この場所のツールで書く手前に作業前の成否を測った回だけ
 * 回っていた。MCP で書いて終わった回は、何も確かめずに「完了」になっていた。
 *
 * 作業場が変わっていたら、一度だけ確かめる（直させない）。読むだけの回では
 * 走らせない。どちらも、テストが走った跡（走るたびに1行増えるファイル）で見る。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { startFakeServer, type FakeServer } from './fake-server.ts';
import { Session, type SessionEvent } from '../src/core/session.ts';
import { DEFAULT_CONFIG, type AasConfig } from '../src/config.ts';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'writer-mcp.mjs');

let fake: FakeServer;
before(async () => { fake = await startFakeServer({ kind: 'stream', text: 'はい。' }); });
after(async () => { await fake.close(); });

/**
 * 作業場を一つ作る。テストは「走ったことを一つ上のファイルに1行足し、FAIL が在れば落ちる」だけ。
 * **そのファイルは作業場の外に置く。**中に置くと、テストが走ったこと自体が作業場の変化になる。
 */
async function workspace(opts: { git: boolean; failing?: boolean }): Promise<{ root: string; marker: string }> {
  const home = await tempDir('aas-outside-');
  const root = join(home, 'project');
  const marker = join(home, 'ran.txt');
  await mkdir(join(root, 'test'), { recursive: true });
  await writeFile(join(root, 'test', 'a.test.ts'), "test('one', () => {});\ntest('two', () => {});\n");
  await writeFile(join(root, 'note.txt'), 'もとの中身\n');
  // 作業の前から落ちている作業場（対を作るため）。
  if (opts.failing) await writeFile(join(root, 'FAIL'), 'x');
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'x', version: '1.0.0',
    scripts: { test: `node -e "require('fs').appendFileSync('../ran.txt','x\\n');if(require('fs').existsSync('FAIL'))process.exit(1)"` },
  }));
  if (opts.git) {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    git('init', '-q');
    git('add', '-A');
    git('-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  }
  return { root, marker };
}

async function ranCount(marker: string): Promise<number> {
  const raw = await readFile(marker, 'utf8').catch(() => '');
  return raw.split('\n').filter((l) => l.length > 0).length;
}

function config(root: string, extra: { maxRounds?: number } = {}): AasConfig {
  return {
    ...DEFAULT_CONFIG,
    providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: fake.baseUrl, locality: 'local', models: ['m'] }],
    candidates: ['local:m'],
    agent: { root, approval: 'auto', ...(extra.maxRounds ? { verify: { maxRounds: extra.maxRounds } } : {}) },
    mcp: { servers: { w: { command: process.execPath, args: [FIXTURE], startupTimeoutMs: 20_000 } } },
  } as AasConfig;
}

/** MCP のツールが揃うまで待つ。繋がる前に送ると、模型の呼んだ名前が無い。 */
async function ready(session: Session): Promise<void> {
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    if (session.toolPool.mcp.some((t) => t.schema.name === 'w__write')) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('MCP のツールが揃いませんでした');
}

async function ask(session: Session, text: string): Promise<SessionEvent[]> {
  const seen: SessionEvent[] = [];
  for await (const ev of session.send(text)) seen.push(ev);
  return seen;
}

async function turn(
  root: string, behavior: Parameters<FakeServer['setBehavior']>[0], extra: { maxRounds?: number } = {},
): Promise<SessionEvent[]> {
  fake.setBehavior(behavior);
  const session = await Session.create(config(root, extra), { approve: () => Promise.resolve(true) });
  try {
    await ready(session);
    return await ask(session, 'やって');
  } finally { await session.close(); }
}

const verifyTypes = (seen: SessionEvent[]) =>
  seen.flatMap((e) => (e.type === 'verify' ? [e.event.type] : []));
const outside = (seen: SessionEvent[]) =>
  seen.find((e): e is Extract<SessionEvent, { type: 'outsideChanged' }> => e.type === 'outsideChanged');

describe('外のツールだけで書いた回', { timeout: 60_000 }, () => {
  test('作業場が変わったら、一度だけ確かめる', async () => {
    const { root, marker } = await workspace({ git: true });
    const seen = await turn(root, {
      kind: 'toolcall', name: 'w__write',
      args: { path: join(root, 'new.txt'), content: 'MCP で書いた\n' }, then: '書きました。',
    });
    assert.deepEqual(outside(seen)?.paths, ['new.txt'], `変わったファイルを挙げていない: ${JSON.stringify(outside(seen))}`);
    assert.equal(await ranCount(marker), 1, '確かめが一度だけ走っていない');
    assert.deepEqual(verifyTypes(seen), ['running', 'passed']);
  });

  test('読むだけなら、走らせない（対）', async () => {
    const { root, marker } = await workspace({ git: true });
    const seen = await turn(root, { kind: 'toolcall', name: 'w__look', args: {}, then: '見ました。' });
    assert.equal(outside(seen), undefined, '変わっていないのに変わったと言っている');
    assert.equal(await ranCount(marker), 0, '読んだだけでテストが走っている');
    assert.deepEqual(verifyTypes(seen), []);
  });

  test('落ちても直させない。落ちたとは言う', async () => {
    const { root, marker } = await workspace({ git: true });
    const seen = await turn(root, {
      kind: 'toolcall', name: 'w__write',
      args: { path: join(root, 'FAIL'), content: 'x' }, then: '書きました。',
    });
    assert.deepEqual(verifyTypes(seen), ['running', 'failed'], '直させている、または落ちたと言っていない');
    assert.equal(await ranCount(marker), 1);
    const settled = seen.find((e) => e.type === 'settled') as { checked?: string } | undefined;
    assert.equal(settled?.checked, 'failed', '落ちたのに、結末が落ちたになっていない');
  });

  test('テストを消して通したら、通ったとは言わない', async () => {
    const { root } = await workspace({ git: true });
    const seen = await turn(root, {
      kind: 'toolcall', name: 'w__remove',
      args: { path: join(root, 'test', 'a.test.ts') }, then: '消しました。',
    });
    assert.deepEqual(verifyTypes(seen), ['running', 'tampered'], `消したのに通っている: ${verifyTypes(seen).join(',')}`);
  });

  test('比べられない作業場では、比べられないと言い、走らせない', async () => {
    const { root, marker } = await workspace({ git: false });
    const seen = await turn(root, {
      kind: 'toolcall', name: 'w__write',
      args: { path: join(root, 'new.txt'), content: 'x' }, then: '書きました。',
    });
    const ev = outside(seen);
    assert.ok(ev, '比べられないのに黙っている');
    assert.equal(ev.paths, undefined);
    assert.equal(await ranCount(marker), 0);
  });
});

/*
 * 外のツールが先に作業場を変え、そのあとこの場所のツールで書く回。
 *
 * 作業前の成否は、この場所のツールで書く手前で測る。外のツールの後に測ると、
 * 外のツールが落とした分まで「作業前から落ちていた」と読み、直させなかった。
 */
describe('外のツールが先に変えてから、この場所で書いた回', { timeout: 60_000 }, () => {
  const writeHere = [
    { name: 'read_file', args: { path: 'note.txt' } },
    { name: 'write_file', args: { path: 'note.txt', content: '書き換えました\n' } },
  ];

  test('外のツールが落とした分を、作業前からとは言わない', async () => {
    const { root } = await workspace({ git: true });
    const seen = await turn(root, {
      kind: 'steps',
      calls: [{ name: 'w__write', args: { path: join(root, 'FAIL'), content: 'x' } }, ...writeHere],
      then: '書きました。',
    }, { maxRounds: 1 });
    const ev = outside(seen);
    assert.ok(ev?.beforeBaseline, `先に変わったことを言っていない: ${JSON.stringify(ev)}`);
    assert.deepEqual(ev.paths, ['FAIL']);
    assert.ok(!seen.some((e) => e.type === 'baseline'), '外のツールの後に「作業前」を測っている');
    assert.ok(!verifyTypes(seen).includes('preexisting'), `外のツールが落とした分を、作業前からと言っている: ${verifyTypes(seen).join(',')}`);
    assert.ok(verifyTypes(seen).includes('failed'), '落ちたと言っていない');
  });

  test('外のツールが読んだだけなら、これまでどおり作業前を測る（対）', async () => {
    const { root } = await workspace({ git: true, failing: true });
    const seen = await turn(root, {
      kind: 'steps',
      calls: [{ name: 'w__look', args: {} }, ...writeHere],
      then: '書きました。',
    }, { maxRounds: 1 });
    assert.equal(outside(seen), undefined, '変わっていないのに変わったと言っている');
    assert.ok(seen.some((e) => e.type === 'baseline'), '作業前を測っていない');
    assert.ok(verifyTypes(seen).includes('preexisting'), `元から落ちていたものを、元からと言っていない: ${verifyTypes(seen).join(',')}`);
  });
});
