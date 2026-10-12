/**
 * 画像を読めるモデルのときだけ、添えた画像そのものを渡す（DECISIONS 10-11、画像を渡す仕組み）。
 *
 * 画面で添えた PNG を送ると、Ollama の `/api/show` が `vision` を返すモデルには `image_url`（data URL）として届く。
 * 読めないモデルには画像を渡さず、添えたことと保存先を文で伝える。会話の記録には画像のデータを残さない。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { until } from './until.ts';
import { startFakeServer } from './fake-server.ts';

const state = await tempDir('aas-attach-image-');
process.env.AAS_STATE_DIR = state;
const { UiServer } = await import('../src/ui/server.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');

// 1x1 の PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

async function sendImage(vision: boolean): Promise<{ sent: string }> {
  const root = await tempDir('aas-attach-image-root-');
  const fake = await startFakeServer({ kind: 'stream', text: '見ました。' }, { vision });
  const server = new UiServer({
    port: 0,
    config: {
      ...DEFAULT_CONFIG,
      providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: fake.baseUrl, locality: 'local', models: ['m'] }],
      candidates: ['local:m'],
      runtime: { kind: 'ollama' },
      agent: { ...(DEFAULT_CONFIG as { agent?: object }).agent, approval: 'auto', root },
      initiative: { enabled: false },
    } as typeof DEFAULT_CONFIG,
  });
  const base = (await server.start()).replace(/\/$/, '');
  try {
    const put = await fetch(`${base}/api/attach?name=shot.png`, { method: 'POST', body: PNG });
    const putText = await put.text();
    assert.equal(put.status, 200, putText);
    const { id } = JSON.parse(putText) as { id: string };
    const r = await fetch(`${base}/api/send`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'この画面を見て', attachments: [id] }),
    });
    assert.ok(r.status < 300, await r.text());
    await until(() => /この画面を見て/.test(JSON.stringify(fake.bodies)), '依頼がモデルに届く', { timeoutMs: 30_000 });
    return { sent: JSON.stringify(fake.bodies) };
  } finally {
    await server.stop();
    await fake.close();
  }
}

test('画像を読めるモデルには、添えた画像を image_url として渡す', async () => {
  const { sent } = await sendImage(true);
  assert.match(sent, /"type":"image_url"/, '画像を渡していない');
  assert.match(sent, new RegExp(`data:image/png;base64,${PNG.toString('base64').slice(0, 20).replace(/[+/]/g, (c) => `\\${c}`)}`));
  // 会話の記録には画像のデータを残さない
  const dir = join(state, 'conversations');
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith('.jsonl'));
  for (const f of files) assert.doesNotMatch(await readFile(join(dir, f), 'utf8'), /iVBORw0KGgo/, '会話の記録に画像のデータが残った');
});

test('画像を読めないモデルには渡さず、読めないと文で伝える（対）', async () => {
  const { sent } = await sendImage(false);
  assert.doesNotMatch(sent, /image_url/);
  assert.match(sent, /いまのモデルは画像を読めません/);
});
