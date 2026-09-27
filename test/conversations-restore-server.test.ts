/**
 * 画面から消した会話を、画面から戻す。立ち上げ直すと本当に消える。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { tempDir } from './tmp.ts';
import { until } from './until.ts';
import { startFakeServer } from './fake-server.ts';

const dir = await tempDir('aas-conv-restore-srv-');
process.env.AAS_HOME = dir;
process.env.AAS_STATE_DIR = join(dir, 'state');
const { UiServer } = await import('../src/ui/server.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');

test('**消した会話は画面から戻せる。立ち上げ直すと本当に消え、戻せないと言う**', async () => {
  const fake = await startFakeServer({ kind: 'echo' });
  const config = {
    ...DEFAULT_CONFIG,
    providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: fake.baseUrl, locality: 'local', models: ['m'] }],
    candidates: ['local:m'],
    runtime: { kind: 'ollama' },
    agent: { root: dir, approval: 'auto' },
    initiative: { enabled: false },
  } as typeof DEFAULT_CONFIG;
  const talks = join(dir, 'state', 'conversations');
  const id = 'c20260101-000000-0007';
  const trashed = join(talks, 'trash', `${id}.jsonl`);
  let server = new UiServer({ port: 0, config });
  let base = (await server.start()).replace(/\/$/, '');
  try {
    await mkdir(talks, { recursive: true });
    const at = new Date().toISOString();
    await writeFile(join(talks, `${id}.jsonl`), [
      JSON.stringify({ t: 'meta', id, title: '残したい話', createdAt: at }),
      JSON.stringify({ t: 'msg', at, m: { role: 'user', content: '大事なこと' } }),
    ].join('\n') + '\n');
    const ids = async () => ((await (await fetch(`${base}/api/conversations`)).json()) as { list: { id: string }[] }).list.map((h) => h.id);
    const restore = () => fetch(`${base}/api/conversations/restore`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }),
    });

    assert.equal((await fetch(`${base}/api/conversations?id=${id}`, { method: 'DELETE' })).status, 200);
    assert.deepEqual(await ids(), []);
    assert.equal((await restore()).status, 200);
    assert.deepEqual(await ids(), [id], '戻していない');

    assert.equal((await fetch(`${base}/api/conversations?id=${id}`, { method: 'DELETE' })).status, 200);
    await server.stop();
    server = new UiServer({ port: 0, config });
    base = (await server.start()).replace(/\/$/, '');
    await until(async () => !(await stat(trashed).then(() => true, () => false)), '立ち上げたときに消した会話を消す', { timeoutMs: 5000, everyMs: 20 });
    const gone = await restore();
    assert.equal(gone.status, 404);
    assert.equal(((await gone.json()) as { gone?: boolean }).gone, true, '戻せないのに、戻す口を下げさせない');
    assert.deepEqual(await ids(), []);
  } finally {
    await server.stop();
    await fake.close();
  }
});

test('**動いている会話は、別の会話を開いてからでも消せない**（消すと、終わった答えが切れ端の会話を作る）', async () => {
  const fake = await startFakeServer({ kind: 'echo', delayMs: 1500 });
  const config = {
    ...DEFAULT_CONFIG,
    providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: fake.baseUrl, locality: 'local', models: ['m'] }],
    candidates: ['local:m'],
    runtime: { kind: 'ollama' },
    agent: { root: dir, approval: 'auto' },
    initiative: { enabled: false },
  } as typeof DEFAULT_CONFIG;
  const server = new UiServer({ port: 0, config });
  const base = (await server.start()).replace(/\/$/, '');
  const post = (p: string, body: unknown) => fetch(base + p, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    const a = await (await post('/api/send', { text: 'A の依頼' })).json() as { conversationId: string };
    assert.ok(a.conversationId, JSON.stringify(a));
    const other = await (await post('/api/conversations', {})).json() as { id?: string };
    if (other.id) await post('/api/conversations/select', { id: other.id });
    const del = await fetch(`${base}/api/conversations?id=${a.conversationId}`, { method: 'DELETE' });
    assert.equal(del.status, 409, '動いている会話を、別の会話を開いてから消せた');
  } finally {
    await server.stop();
    await fake.close();
  }
});
