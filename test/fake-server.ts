/** OpenAI互換サーバの最小モック。契約テスト用。 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type Behavior =
  | { kind: 'stream'; text: string }
  /**
   * 頼まれた文の最後の行を「答え: …」として、少し遅れて返す。
   * どの会話への答えかを見分けたいとき（手が一つで口が複数）に使う。
   * 指摘かどうかの問いには NONE と即答する。
   */
  | { kind: 'echo'; delayMs?: number; /** 一文字ずつ、この間隔で流す（途中までを見る試験のため） */ trickleMs?: number }
  /** 最初は道具を呼び、道具の結果が履歴に載って戻ってきたら then を答える。 */
  | { kind: 'toolcall'; name: string; args: Record<string, unknown>; then: string }
  /**
   * 道具を順に呼ぶ。呼び終えたら then を答える。
   *
   * 一つしか呼べないと、**読んでから書く**のような、規則が求める並びを試せない。
   * 実際に、読まずに書いて弾かれる形しか通していなかった。
   */
  | { kind: 'steps'; calls: Array<{ name: string; args: Record<string, unknown> }>; then: string }
  /**
   * 道具を呼んだあと、**終わりの合図を書かずに手を止める。**
   *
   * ローカルの小さいモデルが実際にする止まり方。「では、このあと直します」
   * と言って返してくる。押し戻しても同じことを言う。
   */
  | { kind: 'stalls'; name: string; args: Record<string, unknown>; then: string }
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

/**
 * 道具を使い終えたあとの答えには、終わりの合図を付ける。
 *
 * 本物のモデルには決まり（system）で「やり終えたら TASK_DONE だけの行を
 * 書く」と渡している。ここで付けないと、**決まりに従わないモデル**を
 * 相手にした試験になり、押し戻しの側だけを見ることになる。
 * 従うモデルが素直に終われることも、対で見る。
 */
function withDone(text: string): string {
  return `${text}\nTASK_DONE\n`;
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
        for (const ch of withDone(behavior.then)) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: ch } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    if (behavior.kind === 'stalls') {
      const messages = (body as { messages?: { role?: string }[] } | undefined)?.messages ?? [];
      const answered = messages.some((m) => m.role === 'tool');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (!answered) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: behavior.name, arguments: JSON.stringify(behavior.args) } }] } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
      } else {
        // **合図を書かない。**押し戻されても、同じことを言う。
        for (const ch of behavior.then) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: ch } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    if (behavior.kind === 'steps') {
      const messages = (body as { messages?: { role?: string }[] } | undefined)?.messages ?? [];
      // 返ってきた道具の結果の数＝いま何段目か。
      const done = messages.filter((m) => m.role === 'tool').length;
      const next = behavior.calls[done];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (next) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${done + 1}`, function: { name: next.name, arguments: JSON.stringify(next.args) } }] } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
      } else {
        for (const ch of withDone(behavior.then)) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: ch } }] })}\n\n`);
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

    if (behavior.kind === 'echo') {
      const messages = (body as { messages?: { role?: string; content?: string }[] } | undefined)?.messages ?? [];
      const asked = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
      const judge = /指摘・不満・注意かどうか|CODE:/.test(asked);
      const text = judge ? 'NONE' : `答え: ${asked.trim().split('\n').pop() ?? ''}`;
      const wait = judge ? 0 : (behavior.delayMs ?? 0);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const finish = () => {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      };
      const chunk = (ch: string) => res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: ch } }] })}\n\n`);
      const trickle = judge ? 0 : (behavior.trickleMs ?? 0);
      setTimeout(() => {
        if (!trickle) { for (const ch of text) chunk(ch); finish(); return; }
        const chars = [...text];
        const tick = () => { const ch = chars.shift(); if (ch === undefined) return finish(); chunk(ch); setTimeout(tick, trickle); };
        tick();
      }, wait);
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
