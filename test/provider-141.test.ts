import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OpenAiCompatibleProvider } from '../src/providers/openai-compatible.ts';

// 偽の相手。道の名前で、返す中身を選ぶ
const cases: Record<string, { ct: string; parts: string[] }> = {
  thinking: { ct: 'application/json', parts: [JSON.stringify({ choices: [{ message: { content: [{ type: 'thinking', text: 'SECRET ' }, { type: 'text', text: 'answer' }] }, finish_reason: 'stop' }] })] },
  filtered: { ct: 'text/event-stream', parts: ['data: {"choices":[{"delta":{"content":"he"}}]}\n\n', 'data: {"choices":[{"delta":{"content":"llo"},"finish_reason":"content_filter"}]}\n\n'] },
  broken: { ct: 'text/event-stream', parts: ['data: {"choices":[{"delta":{"content":"a"}}]}\ndata: {"choices":[{"delta":{"con\ndata: {"choices":[{"delta":{"content":"b"}}]}\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\ndata: [DONE]\n'] },
};
const srv = createServer(async (req, res) => {
  const c = cases[req.url!.split('/')[1]!]!;
  res.writeHead(200, { 'content-type': c.ct });
  for (const p of c.parts) { res.write(p); await new Promise((r) => setTimeout(r, 10)); }
  res.end();
});
await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
const port = (srv.address() as AddressInfo).port;
after(() => srv.close());

const run = async (name: string) => {
  const p = new OpenAiCompatibleProvider({ id: 't', baseUrl: `http://127.0.0.1:${port}/${name}`, locality: 'local' } as never);
  const out: unknown[] = [];
  try {
    for await (const ch of p.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] } as never, new AbortController().signal)) out.push(ch);
  } catch (e) { out.push(`THROW ${(e as Error).message}`); }
  return out;
};

test('まとめて返す答えでも、考えの部分を本文に混ぜない', async () => {
  const out = await run('thinking');
  assert.deepEqual(out.filter((c) => (c as { type?: string }).type === 'text'), [{ type: 'text', delta: 'answer' }]);
});

test('相手の決まりで止められた返事を、言い終えた答えとして通さない', async () => {
  const out = await run('filtered');
  assert.match(String(out.at(-1)), /^THROW .*content_filter/);
});

test('空行で区切らない流れで壊れた一行があっても、その一行だけを捨てて続きを読む', async () => {
  const out = await run('broken');
  assert.deepEqual(out, [{ type: 'text', delta: 'a' }, { type: 'text', delta: 'b' }, { type: 'done', finishReason: 'stop' }]);
});
