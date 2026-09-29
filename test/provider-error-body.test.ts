/**
 * 相手が失敗の頭（5xx）だけ返して本文を止めたとき、本文を待ち続けない。
 *
 * 見張りの時計を止めてから本文を読んでいたので、最大で数分待っていた（Node の fetch の既定の時間切れまで）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { OpenAiCompatibleProvider } from '../src/providers/openai-compatible.ts';

test('失敗の本文が届かないとき、つなぐときの時間切れで打ち切って失敗として返す', async () => {
  const held: import('node:http').ServerResponse[] = [];
  const server: Server = createServer((_req, res) => {
    res.writeHead(503, { 'content-type': 'text/plain' });
    res.write('busy');
    held.push(res); // 本文を終えない
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as { port: number }).port;
  try {
    const provider = new OpenAiCompatibleProvider({
      id: 'stuck', baseUrl: `http://127.0.0.1:${port}/v1`, locality: 'cloud', connectTimeoutMs: 300,
    });
    const started = Date.now();
    const run = (async () => {
      for await (const _ of provider.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, new AbortController().signal)) { /* 読み捨て */ }
    })();
    await assert.rejects(Promise.race([
      run,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('本文を待ち続けている')), 10_000).unref()),
    ]), (e: unknown) => !/本文を待ち続けている/.test((e as Error).message));
    assert.ok(Date.now() - started < 10_000);
  } finally {
    for (const res of held) res.destroy();
    await new Promise<void>((ok) => server.close(() => ok()));
  }
});
