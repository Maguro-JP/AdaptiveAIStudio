/**
 * 地元の口（Ollama・llama-server）は、最初のトークンが出るまでヘッダを返さない。
 *
 * ヘッダまでを「繋がるまで」の 10 秒で見切っていたので、モデルの読み込みと入力の読み取りが 10 秒を
 * 超えると「接続に失敗」で落ちた（地元の時間切れはやり直さない）。繋がるかは短く見て、繋がったら長く待つ。
 *
 * 相手は、こちらの「繋がるまで」の時計（500ms）より**後に**仕掛けた、より長い時計（1,500ms）でヘッダを返す。
 * 同じプロセスの時計は早く切れる方から順に鳴るので、直す前の版は必ず先に見切る。「繋がるまで」を短くしすぎると、
 * 直した版の TCP の確かめまで混んだ機械で見切られるので、余裕を持たせる。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { OpenAiCompatibleProvider } from '../src/providers/openai-compatible.ts';
import { ProviderError } from '../src/providers/errors.ts';

async function lateHeaders(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: '2' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
      }, 1_500);
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/v1`, close: () => new Promise<void>((ok) => server.close(() => ok())) };
}

async function collect(p: OpenAiCompatibleProvider): Promise<string> {
  let text = '';
  for await (const c of p.chat({ model: 'm', messages: [{ role: 'user', content: '1+1=' }] }, new AbortController().signal)) {
    if (c.type === 'text') text += c.delta;
  }
  return text;
}

describe('地元の口: ヘッダを待つ長さ', () => {
  test('繋がっていれば、ヘッダが「繋がるまで」の上限より遅くても待つ', async () => {
    const s = await lateHeaders();
    try {
      const p = new OpenAiCompatibleProvider({ id: 'ollama', baseUrl: s.url, locality: 'local', connectTimeoutMs: 500 });
      assert.equal(await collect(p), '2');
    } finally { await s.close(); }
  });

  test('繋がらない相手は、すぐ落ちたと言う（対）', async () => {
    const s = await lateHeaders();
    const url = s.url;
    await s.close(); // 誰も居ない口
    const p = new OpenAiCompatibleProvider({ id: 'ollama', baseUrl: url, locality: 'local', connectTimeoutMs: 20 });
    const err = await collect(p).then(() => undefined, (e: unknown) => e);
    assert.ok(err instanceof ProviderError);
    // 断りが即座に返るか（linux）、数秒かかって先に見切るか（Windows の localhost）は機械で変わる。どちらも「繋がらない」
    assert.ok(err.kind === 'unavailable' || err.kind === 'timeout', err.kind);
    assert.match(err.message, /接続に失敗/);
  });

  test('雲は、これまで通りヘッダを「繋がるまで」の上限で見切る（対）', async () => {
    const s = await lateHeaders();
    try {
      const p = new OpenAiCompatibleProvider({ id: 'cloud', baseUrl: s.url, locality: 'cloud', connectTimeoutMs: 500 });
      const err = await collect(p).then(() => undefined, (e: unknown) => e);
      assert.ok(err instanceof ProviderError);
      assert.equal(err.kind, 'timeout');
    } finally { await s.close(); }
  });
});
