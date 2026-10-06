/**
 * 画面の本体の口の不具合（62 回目の調査）。
 *
 * - 送り先の会話が一時的に読めないだけで 404 を返し、画面は消されたと読んで会話から抜けた
 *
 * プレビューを同時に開くと `127.0.0.1:0` を返した件は、同時に投げても直す前の版で再現しなかったので試験にしていない。
 * やり残しの続きを始める間に本体の手を押さえていなかった件・段取りの口が候補の無い本体を組み直さなかった件・段取りの後に順番待ちを
 * 流さなかった件は、遅らせる偽物と読み込みの模型が要るので試験を書いていない（確かめていない）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { tempDir } from './tmp.ts';
import { startFakeServer } from './fake-server.ts';

const dir = await tempDir('aas-server-front-');
process.env.AAS_HOME = dir;
process.env.AAS_STATE_DIR = join(dir, 'state');
const { UiServer } = await import('../src/ui/server.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');

const talks = join(dir, 'state', 'conversations');

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
  return { fake, server, base, post };
}

test('**読めないだけの会話へ送っても、無いとは言わない**', async () => {
  const { fake, server, post } = await start();
  try {
    // 会話のファイルの場所にフォルダを置く（読むと EISDIR。在るが読めない）
    await mkdir(join(talks, 'c20260101-000000-0005.jsonl'), { recursive: true });
    const r = await post('/api/send', { text: 'こんにちは', conversationId: 'c20260101-000000-0005' });
    assert.notEqual(r.status, 404, '読めないだけなのに「無い」と返した');
    // 本当に無い会話は 404（対）
    const gone = await post('/api/send', { text: 'こんにちは', conversationId: 'c20260101-000000-0009' });
    assert.equal(gone.status, 404);
  } finally {
    await server.stop();
    await fake.close();
  }
});
