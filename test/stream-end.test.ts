/**
 * 終わりの合図が無いまま閉じた流れを、言い終えたことにしない。
 *
 * 相手（Ollama・llama-server・中継）が途中で落ちると、[DONE] も finish_reason も無いまま本文が閉じる。
 * それを完了として、途中までの文を返事として残していた。流れの途中で `data: {"error": ...}` が来たときも同じ。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { OpenAiCompatibleProvider } from '../src/providers/openai-compatible.ts';
import { AnthropicProvider } from '../src/providers/anthropic.ts';
import { ProviderError } from '../src/providers/errors.ts';

const sdkMissing = await (async () => {
  try { await import('@anthropic-ai/sdk'); return false; } catch { return true; }
})();

/** 決まった行を返して閉じる相手。 */
async function serve(lines: string[]): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(lines.join(''));
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((ok) => server.close(() => ok())) };
}

const chunk = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

async function run(lines: string[]): Promise<{ texts: string[]; error?: unknown }> {
  const s = await serve(lines);
  const texts: string[] = [];
  try {
    const p = new OpenAiCompatibleProvider({ id: 'local', baseUrl: `${s.url}/v1`, locality: 'local' });
    for await (const c of p.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, new AbortController().signal)) {
      if (c.type === 'text') texts.push(c.delta);
    }
    return { texts };
  } catch (error) {
    return { texts, error };
  } finally {
    await s.close();
  }
}

describe('OpenAI 互換: 終わりの合図', () => {
  test('合図の無いまま閉じたら、落ちたと言う（途中までの文を完了にしない）', async () => {
    const got = await run([chunk({ choices: [{ delta: { content: '途中' } }] })]);
    assert.deepEqual(got.texts, ['途中']);
    assert.ok(got.error instanceof ProviderError, '途中で切れたものを完了として返した');
    assert.equal(got.error.kind, 'unavailable');
  });

  test('流れの途中の data: {"error"} を読み飛ばさない', async () => {
    const got = await run([
      chunk({ choices: [{ delta: { content: '途中' } }] }),
      chunk({ error: { message: 'llama runner process has terminated' } }),
    ]);
    assert.ok(got.error instanceof ProviderError, '途中の失敗を読み飛ばした');
    assert.match(got.error.message, /runner process has terminated/);
  });

  test('[DONE] で終われば成功（対）', async () => {
    const got = await run([chunk({ choices: [{ delta: { content: 'ok' } }] }), 'data: [DONE]\n\n']);
    assert.equal(got.error, undefined);
  });

  test('finish_reason だけで終わっても成功（[DONE] を送らない相手。対）', async () => {
    const got = await run([chunk({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })]);
    assert.equal(got.error, undefined);
  });
});

describe('Claude: 終わりの合図', () => {
  test('message_stop の無いまま閉じたら、落ちたと言う', { skip: sdkMissing && '@anthropic-ai/sdk が未導入' }, async () => {
    const ev = (e: string, d: unknown) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`;
    const s = await serve([
      ev('message_start', { type: 'message_start', message: { id: 'm1', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }),
      ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '途中' } }),
    ]);
    process.env.ANTHROPIC_BASE_URL = s.url;
    try {
      const p = new AnthropicProvider({ apiKey: 'test-key' });
      const err = await (async () => {
        for await (const _ of p.chat({ model: 'claude-opus-5', messages: [{ role: 'user', content: 'hi' }] }, new AbortController().signal)) { /* 読み捨て */ }
      })().then(() => undefined, (e: unknown) => e);
      assert.ok(err instanceof ProviderError, '途中で切れたものを完了として返した');
      assert.equal(err.kind, 'unavailable');
    } finally {
      delete process.env.ANTHROPIC_BASE_URL;
      await s.close();
    }
  });
});
