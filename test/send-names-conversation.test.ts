/**
 * 送り先の会話は、送った画面が言う。本体の「見ている会話」で決めない。
 *
 * 本体の「見ている会話」は一つで、別のタブで選び直す・見回りがやり残しを再開する、のどちらでも書き換わる。
 * それで送り先を決めていたので、打った会話ではない会話に入り、その答えが今の欄に描かれていた。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { tempDir } from './tmp.ts';
import { until } from './until.ts';
import { startFakeServer } from './fake-server.ts';

const dir = await tempDir('aas-send-names-');
process.env.AAS_HOME = dir;
process.env.AAS_STATE_DIR = join(dir, 'state');
const { UiServer } = await import('../src/ui/server.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');

const talks = join(dir, 'state', 'conversations');
const X = 'c20260101-000000-0001';
const Y = 'c20260101-000000-0002';

async function conversation(id: string, title: string): Promise<void> {
  await mkdir(talks, { recursive: true });
  const at = new Date().toISOString();
  await writeFile(join(talks, `${id}.jsonl`), [
    JSON.stringify({ t: 'meta', id, title, createdAt: at }),
    JSON.stringify({ t: 'msg', at, m: { role: 'user', content: `${title}の始まり` } }),
  ].join('\n') + '\n');
}

async function start() {
  const fake = await startFakeServer({ kind: 'echo' });
  const server = new UiServer({
    port: 0,
    config: {
      ...DEFAULT_CONFIG,
      providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: fake.baseUrl, locality: 'local', models: ['m'] }],
      candidates: ['local:m'],
      runtime: { kind: 'ollama' },
      agent: { root: dir, approval: 'auto' },
      initiative: { enabled: false },
    } as typeof DEFAULT_CONFIG,
  });
  const base = (await server.start()).replace(/\/$/, '');
  const post = (p: string, body: unknown) => fetch(base + p, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const current = async () => ((await (await fetch(`${base}/api/conversations`)).json()) as { current: string | null }).current;
  const idle = async () => !((await (await fetch(`${base}/api/conversations`)).json()) as { running: string | null }).running;
  return { fake, server, base, post, current, idle };
}

test('別のタブで選び直されても、送った画面が言った会話に入る', async () => {
  await conversation(X, '会話X');
  await conversation(Y, '会話Y');
  const { fake, server, post, idle } = await start();
  try {
    assert.equal((await post('/api/conversations/select', { id: X })).status, 200);
    // 別のタブが Y を選ぶ
    assert.equal((await post('/api/conversations/select', { id: Y })).status, 200);
    const r = await post('/api/send', { text: 'X への依頼', conversationId: X });
    const body = await r.json() as { conversationId?: string };
    assert.equal(body.conversationId, X, `打った会話ではない所へ入った: ${JSON.stringify(body)}`);
    await until(async () => (await readFile(join(talks, `${X}.jsonl`), 'utf8')).includes('X への依頼') && await idle(),
      'X の記録に入る', { timeoutMs: 15_000, everyMs: 100 });
    assert.doesNotMatch(await readFile(join(talks, `${Y}.jsonl`), 'utf8'), /X への依頼/);
  } finally {
    await server.stop();
    await fake.close();
  }
});

test('会話の名前の形が違えば 400、無い会話なら 404、null はトップ（新しい会話）', async () => {
  await conversation(X, '会話X');
  const { fake, server, post, idle } = await start();
  try {
    assert.equal((await post('/api/send', { text: 'a', conversationId: '../x' })).status, 400);
    assert.equal((await post('/api/send', { text: 'a', conversationId: 'c20991231-000000-0009' })).status, 404);
    assert.equal((await post('/api/conversations/select', { id: X })).status, 200);
    const r = await (await post('/api/send', { text: 'トップからの依頼', conversationId: null })).json() as { conversationId?: string };
    assert.ok(r.conversationId && r.conversationId !== X, `トップから送ったのに見ている会話へ入った: ${JSON.stringify(r)}`);
    await until(idle, '終わる', { timeoutMs: 15_000, everyMs: 100 });
  } finally {
    await server.stop();
    await fake.close();
  }
});

test('見回りがやり残しを再開しても、見ている会話は替えない', async () => {
  await conversation(X, '会話X');
  await conversation(Y, '会話Y');
  const item = {
    id: 'u1', request: 'Y の続き', why: 'maxTurns', note: 'maxTurns', conversationId: Y,
    root: resolve(dir), attempts: 0, nextAt: 0, createdAt: new Date().toISOString(),
  };
  await mkdir(join(dir, 'state'), { recursive: true });
  await writeFile(join(dir, 'state', 'unfinished.jsonl'), `${JSON.stringify({ t: 'add', item })}\n`);
  const { fake, server, post, current, idle } = await start();
  try {
    assert.equal((await post('/api/conversations/select', { id: X })).status, 200);
    const session = await server.session();
    assert.equal(await server.idleTick(session), 'RESUMED');
    assert.equal(await current(), X, '再開した会話へ、見ている会話が黙って移った');
    await until(idle, '再開した分が終わる', { timeoutMs: 15_000, everyMs: 100 });
    assert.match(await readFile(join(talks, `${Y}.jsonl`), 'utf8'), /Y の続き/, '再開は Y で走っていない');
  } finally {
    await server.stop();
    await fake.close();
  }
});
