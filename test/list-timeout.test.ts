/**
 * モデル一覧の上限。
 *
 * 相手が黙って落とす形（LAN の向こう、塞がれた口）だと、拒否が返らない。
 * ここは 5 秒で固定されていたので、`Session.create` は毎回そのぶん止まり、
 * 最初の送信が待たされた。生成の上限とは別物として、短く、変えられる形にする。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { OpenAiCompatibleProvider } from '../src/providers/openai-compatible.ts';

/** 受け取るが、何も返さない相手。拒否が返らないので、上限だけが効く。 */
async function silentServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const sockets = new Set<import('node:net').Socket>();
  const server = createServer(() => { /* 返さない */ });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    // **開いたものを閉じてから抜ける。**閉じないとテストの走り自体が終わらない。
    close: () => new Promise<void>((ok) => {
      for (const s of sockets) s.destroy();
      server.close(() => ok());
    }),
  };
}

test('返らない相手でも、指定した上限で切り上げる', async () => {
  const { url, close } = await silentServer();
  try {
    const p = new OpenAiCompatibleProvider({
      id: 'mute', baseUrl: url, locality: 'local',
      fallbackModels: ['a'], listTimeoutMs: 200,
    });
    const models = await p.listModels();
    assert.equal(models.length, 1);
    assert.equal(models[0]!.verified, false);
    assert.equal((await p.health()).ok, false);
  } finally {
    await close();
  }
});

test('既定の上限は、生成の上限とは別に短い', async () => {
  const { url, close } = await silentServer();
  try {
    const p = new OpenAiCompatibleProvider({
      id: 'mute', baseUrl: url, locality: 'local', fallbackModels: ['a'],
    });
    const at = Date.now();
    await p.listModels();
    const took = Date.now() - at;
    // 既定は 2 秒。以前の 5 秒固定なら、ここで落ちる。
    // 遅い機械でも通るよう 4 秒に取ってある（2 秒の余裕）。
    assert.ok(took < 4_000, `${took}ms かかりました`);
  } finally {
    await close();
  }
});
