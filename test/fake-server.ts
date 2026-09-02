/** OpenAI互換サーバの最小モック。契約テスト用。 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type Behavior =
  | { kind: 'stream'; text: string }
  /** 最初は道具を呼び、道具の結果が履歴に載って戻ってきたら then を答える。 */
  | { kind: 'toolcall'; name: string; args: Record<string, unknown>; then: string }
  | { kind: 'status'; status: number; body?: string; retryAfter?: string }
  | { kind: 'hang' };

export interface FakeServer {
  baseUrl: string;
  requests: number;
  /** 受け取った本文（新しい順ではなく届いた順）。何を渡されたかを検査で見る。 */
  bodies: unknown[];
  setBehavior(b: Behavior): void;
  close(): Promise<void>;
}

export async function startFakeServer(initial: Behavior): Promise<FakeServer> {
  let behavior = initial;
  const state = { requests: 0, bodies: [] as unknown[] };

  const server: Server = createServer((req, res) => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }));
      return;
    }

    state.requests += 1;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = undefined; }
      state.bodies.push(body);
      answer(body);
    });

    function answer(body: unknown): void {
    if (behavior.kind === 'hang') return; // 応答しない

    if (behavior.kind === 'toolcall') {
      const messages = (body as { messages?: { role?: string }[] } | undefined)?.messages ?? [];
      const answered = messages.some((m) => m.role === 'tool');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (!answered) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: behavior.name, arguments: JSON.stringify(behavior.args) } }] } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
      } else {
        for (const ch of behavior.then) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: ch } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

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
    }
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    get requests() { return state.requests; },
    get bodies() { return state.bodies; },
    setBehavior(b: Behavior) { behavior = b; },
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}
