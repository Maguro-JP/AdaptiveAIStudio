/** OpenAI互換サーバの最小モック。契約テスト用。 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type Behavior =
  | { kind: 'stream'; text: string }
  | { kind: 'status'; status: number; body?: string; retryAfter?: string }
  | { kind: 'hang' };

export interface FakeServer {
  baseUrl: string;
  requests: number;
  setBehavior(b: Behavior): void;
  close(): Promise<void>;
}

export async function startFakeServer(initial: Behavior): Promise<FakeServer> {
  let behavior = initial;
  const state = { requests: 0 };

  const server: Server = createServer((req, res) => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }));
      return;
    }

    state.requests += 1;

    if (behavior.kind === 'hang') return; // 応答しない

    if (behavior.kind === 'status') {
      const headers: Record<string, string> = { 'content-type': 'text/plain' };
      if (behavior.retryAfter) headers['retry-after'] = behavior.retryAfter;
      res.writeHead(behavior.status, headers);
      res.end(behavior.body ?? 'error');
      return;
    }

    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const ch of behavior.text) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: ch } }] })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: behavior.text.length } })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    get requests() { return state.requests; },
    setBehavior(b: Behavior) { behavior = b; },
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}
