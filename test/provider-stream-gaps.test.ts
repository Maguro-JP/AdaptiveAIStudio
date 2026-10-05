/**
 * OpenAI 互換の流れの読みの抜け（32 回目の調査、DECISIONS 10-05）。
 *
 * - 同じ番号で振り直した後、元の id の続きの欠片を、振り直した先へ送らない
 * - 改行の来ない流れを、上限なしに溜めない
 * - 終わりの合図（finish_reason）の後に閉じない相手でも、言い終えた答えを時間切れにしない
 * - 流れの中で物として来た引数を壊さない
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { OpenAiCompatibleProvider } from '../src/providers/openai-compatible.ts';
import { ProviderError } from '../src/providers/errors.ts';

const servers: Server[] = [];
after(() => { for (const s of servers) { s.closeAllConnections(); s.close(); } });

/** 決めた SSE の行を返す口。`hold` なら流したあと閉じない。`raw` はそのまま書く（行に区切らない）。 */
async function sse(lines: string[], opts: { hold?: boolean; raw?: () => string } = {}): Promise<string> {
  const server = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const l of lines) res.write(`data: ${l}\n\n`);
    if (opts.raw) res.write(opts.raw());
    if (!opts.hold) res.end();
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
}

type Out = { text: string; calls: Array<{ name: string; args: unknown }>; done?: string; error?: ProviderError };

async function run(provider: OpenAiCompatibleProvider): Promise<Out> {
  const out: Out = { text: '', calls: [] };
  try {
    for await (const ch of provider.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, new AbortController().signal)) {
      if (ch.type === 'text') out.text += ch.delta;
      if (ch.type === 'toolCall') out.calls.push({ name: ch.call.name, args: ch.call.args });
      if (ch.type === 'done') out.done = ch.finishReason;
    }
  } catch (e) {
    if (!(e instanceof ProviderError)) throw e;
    out.error = e;
  }
  return out;
}

const chunk = (delta: unknown, finish?: string) => JSON.stringify({ choices: [{ delta, ...(finish ? { finish_reason: finish } : {}) }] });

describe('流れの読み', () => {
  test('同じ番号で振り直した後も、id の続きの欠片はその id の呼び出しへ繋ぐ', async () => {
    const url = await sse([
      chunk({ tool_calls: [{ index: 0, id: 'A', function: { name: 'f', arguments: '{"a":' } }] }),
      chunk({ tool_calls: [{ index: 0, id: 'B', function: { name: 'g', arguments: '{"b":' } }] }),
      chunk({ tool_calls: [{ index: 0, id: 'A', function: { arguments: '1}' } }] }),
      chunk({ tool_calls: [{ index: 0, id: 'B', function: { arguments: '2}' } }] }),
      chunk({}, 'tool_calls'), '[DONE]',
    ]);
    const out = await run(new OpenAiCompatibleProvider({ id: 'p', baseUrl: url, locality: 'local' }));
    assert.deepEqual(out.calls, [{ name: 'f', args: { a: 1 } }, { name: 'g', args: { b: 2 } }]);
  });

  test('流れの中で引数が物として来ても、そのまま引数にする', async () => {
    const url = await sse([
      chunk({ tool_calls: [{ index: 0, id: 'A', function: { name: 'read_file', arguments: { path: 'a.txt' } } }] }),
      chunk({}, 'tool_calls'), '[DONE]',
    ]);
    const out = await run(new OpenAiCompatibleProvider({ id: 'p', baseUrl: url, locality: 'local' }));
    assert.deepEqual(out.calls, [{ name: 'read_file', args: { path: 'a.txt' } }]);
  });

  test('終わりの合図の後に閉じない相手でも、言い終えた答えを時間切れにしない', async () => {
    const url = await sse([chunk({ content: '言い終えました' }), chunk({}, 'stop')], { hold: true });
    const started = Date.now();
    const out = await run(new OpenAiCompatibleProvider({
      id: 'p', baseUrl: url, locality: 'local', stallTimeoutMs: 20_000, endGraceMs: 200,
    }));
    assert.equal(out.error, undefined, `言い終えたのに失敗にした: ${out.error?.message}`);
    assert.equal(out.text, '言い終えました');
    assert.equal(out.done, 'stop');
    assert.ok(Date.now() - started < 10_000, '終わりの合図の後、停滞の長さまで待った');
  });

  test('終わりの合図が無く黙ったものは、今までどおり時間切れ（対）', async () => {
    const url = await sse([chunk({ content: '途中まで' })], { hold: true });
    const out = await run(new OpenAiCompatibleProvider({
      id: 'p', baseUrl: url, locality: 'local', stallTimeoutMs: 300, endGraceMs: 200,
    }));
    assert.equal(out.error?.kind, 'timeout');
  });

  test('改行の来ない流れを、上限なしに溜めない', async () => {
    const url = await sse([chunk({ content: 'はじめ' })], { raw: () => 'x'.repeat(9 * 1024 * 1024) });
    const out = await run(new OpenAiCompatibleProvider({ id: 'p', baseUrl: url, locality: 'local' }));
    assert.ok(out.error, '上限を超えても読み続けた');
    assert.match(out.error.message, /大きすぎ/);
  });
});
