import { OpenAiCompatibleProvider } from '@aas/provider-openai-compatible';
import type { ProviderRequest } from '@aas/provider-contract';
import { runChatProviderContract } from './chatProviderContract.js';

function sseResponse(lines: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const l of lines) controller.enqueue(enc.encode(`data: ${l}\n\n`));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const CHUNKS = [
  JSON.stringify({ choices: [{ delta: { content: 'こんに' } }] }),
  JSON.stringify({ choices: [{ delta: { content: 'ちは' }, finish_reason: 'stop' }] }),
];
const USAGE = JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 5 } });

function provider(handler: (init?: RequestInit) => Response | Promise<Response>) {
  return new OpenAiCompatibleProvider({
    id: 'ollama',
    baseUrl: 'http://localhost:11434/v1',
    locality: 'local',
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'qwen2.5-coder:7b' }] }), { status: 200 });
      }
      init?.signal?.throwIfAborted();
      return handler(init);
    }) as typeof fetch,
  });
}

const request = (): ProviderRequest => ({
  modelId: 'ollama:qwen2.5-coder:7b',
  system: 'あなたは開発補助AIです',
  messages: [{ role: 'user', content: 'こんにちは' }],
  params: { temperature: 0.2 },
});

runChatProviderContract('openai-compatible', {
  request,
  ok: () => provider(() => sseResponse([...CHUNKS, USAGE, '[DONE]'])),
  withoutUsage: () => provider(() => sseResponse([...CHUNKS, '[DONE]'])),
  rateLimited: () =>
    provider(
      () =>
        new Response('rate limit exceeded', { status: 429, headers: { 'retry-after': '3' } }),
    ),
  contextTooLong: () =>
    provider(() => new Response('maximum context length exceeded', { status: 400 })),
  hanging: () =>
    provider((init) => {
      // 実 fetch と同様、abort でボディストリームを打ち切る。
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener(
            'abort',
            () => controller.error(new DOMException('aborted', 'AbortError')),
            { once: true },
          );
        },
      });
      return new Response(stream, { status: 200 });
    }),
});
