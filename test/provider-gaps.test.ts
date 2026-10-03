/**
 * モデルとのやりとりの抜け（14 回目の調査）。
 *
 * - 検問所と判じ手は、手元のモデルがあればそれだけを使う（候補を逆順にして雲を先頭にしていた）
 * - 時間切れ・上限で途中まで書かれた検問所の答えを、判定として読まない
 * - そのモデルが無い（404）なら、次の候補へ回す
 * - 番号（index）の無いツールの呼び出しを、一つに混ぜない
 * - 同じ塊に載った失敗の文を、本文として流さない（流すと、やり直しも次の候補への切り替えもしない）
 * - baseUrl の利用者名・パスワードを、失敗の文に出さない
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { hideAasEnv } from './env.ts';
import { OpenAiCompatibleProvider } from '../src/providers/openai-compatible.ts';
import { ProviderRegistry } from '../src/core/registry.ts';
import { ChatOrchestrator, type ChatEvent } from '../src/core/orchestrator.ts';
import { quietCandidates } from '../src/core/session.ts';
import { createModelJudge } from '../src/core/inspector-setup.ts';
import { Inspector } from '../src/harness/inspector.ts';
import { hideUrlCredentials } from '../src/runtime/net-why.ts';
import { loadConfig, ConfigBroken } from '../src/config.ts';
import { startFakeServer } from './fake-server.ts';

const servers: Server[] = [];
after(() => { for (const s of servers) { s.closeAllConnections(); s.close(); } });

/** 決めた SSE の行を返す口。`hold` なら流したあと閉じない（時間切れの形）。 */
async function sse(lines: string[], opts: { hold?: boolean } = {}): Promise<string> {
  const server = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const l of lines) res.write(`data: ${l}\n\n`);
    if (!opts.hold) res.end();
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
}

async function drain(gen: AsyncGenerator<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

describe('判じる・検める仕事の候補', () => {
  const registry = new ProviderRegistry();
  registry.register(new OpenAiCompatibleProvider({ id: 'inproc', baseUrl: 'http://127.0.0.1:1/v1', locality: 'local' }));
  registry.register(new OpenAiCompatibleProvider({ id: 'claude', baseUrl: 'http://127.0.0.1:1/v1', locality: 'cloud' }));
  test('手元のモデルがあれば、それだけを候補の順のまま使う（雲へ送らない）', () => {
    assert.deepEqual(quietCandidates(['inproc:a', 'claude:b', 'inproc:c'], registry), ['inproc:a', 'inproc:c']);
  });
  test('雲だけで使っているなら、そのまま（対）', () => {
    assert.deepEqual(quietCandidates(['claude:b'], registry), ['claude:b']);
  });
  test('設定で固定した候補（強い順）は、軽い方から使う', () => {
    assert.deepEqual(quietCandidates(['inproc:big', 'claude:b', 'inproc:small'], registry, { fixed: true }), ['inproc:small', 'inproc:big']);
    assert.deepEqual(quietCandidates(['claude:opus', 'claude:haiku'], registry, { fixed: true }), ['claude:haiku', 'claude:opus']);
  });
});

describe('言い終えていない検問所の答え', () => {
  test('PASS まで書いて止まった答えを、通すとは読まない', async () => {
    const url = await sse([JSON.stringify({ choices: [{ delta: { content: 'PASS\n' } }] })], { hold: true });
    const registry = new ProviderRegistry();
    registry.register(new OpenAiCompatibleProvider({ id: 'local', baseUrl: url, locality: 'local', stallTimeoutMs: 60_000 }));
    const inspector = new Inspector({ judge: createModelJudge(new ChatOrchestrator(registry), ['local:m']), timeoutMs: 300 });
    const got = await inspector.inspect('送る荷物', 'outbound');
    assert.equal(got.judgement, 'unknown', JSON.stringify(got));
  });
  test('上限で切れた答えも読まない', async () => {
    const url = await sse([
      JSON.stringify({ choices: [{ delta: { content: 'PASS\n' } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] }), '[DONE]',
    ]);
    const registry = new ProviderRegistry();
    registry.register(new OpenAiCompatibleProvider({ id: 'local', baseUrl: url, locality: 'local' }));
    const inspector = new Inspector({ judge: createModelJudge(new ChatOrchestrator(registry), ['local:m']), timeoutMs: 5000 });
    assert.equal((await inspector.inspect('送る荷物', 'outbound')).judgement, 'unknown');
  });
  test('言い終えた PASS は通す（対）', async () => {
    const url = await sse([
      JSON.stringify({ choices: [{ delta: { content: 'PASS\n' } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }), '[DONE]',
    ]);
    const registry = new ProviderRegistry();
    registry.register(new OpenAiCompatibleProvider({ id: 'local', baseUrl: url, locality: 'local' }));
    const inspector = new Inspector({ judge: createModelJudge(new ChatOrchestrator(registry), ['local:m']), timeoutMs: 5000 });
    assert.equal((await inspector.inspect('送る荷物', 'outbound')).judgement, 'pass');
  });
});

describe('次の候補へ回すか', () => {
  test('そのモデルが無い（404）なら、次の候補で答える', async () => {
    const missing = await startFakeServer({ kind: 'status', status: 404, body: 'model not found' });
    const backup = await startFakeServer({ kind: 'stream', text: '次で答えた' });
    try {
      const registry = new ProviderRegistry();
      // 雲の相手で見る（手元の相手は、もともと冷やさない）
      registry.register(new OpenAiCompatibleProvider({ id: 'a', baseUrl: missing.baseUrl, locality: 'cloud' }));
      registry.register(new OpenAiCompatibleProvider({ id: 'b', baseUrl: backup.baseUrl, locality: 'local' }));
      const events = await drain(new ChatOrchestrator(registry).run(
        { candidates: ['a:gone', 'b:m'], messages: [{ role: 'user', content: 'hi' }] }, new AbortController().signal));
      assert.equal(events.find((e) => e.type === 'done')?.modelId, 'b:m', JSON.stringify(events.filter((e) => e.type !== 'text')));
      assert.equal(registry.isAvailable('a'), true, '相手ごと冷やしている');
    } finally {
      await missing.close();
      await backup.close();
    }
  });

  test('モデルの話でない 404（道の打ち間違い）は、次の候補へ回さずに止める（対）', async () => {
    const wrong = await startFakeServer({ kind: 'status', status: 404, body: 'Cannot POST /chat/completions' });
    const backup = await startFakeServer({ kind: 'stream', text: '次で答えた' });
    try {
      const registry = new ProviderRegistry();
      registry.register(new OpenAiCompatibleProvider({ id: 'a', baseUrl: wrong.baseUrl, locality: 'local' }));
      registry.register(new OpenAiCompatibleProvider({ id: 'b', baseUrl: backup.baseUrl, locality: 'local' }));
      const events = await drain(new ChatOrchestrator(registry).run(
        { candidates: ['a:m', 'b:m'], messages: [{ role: 'user', content: 'hi' }] }, new AbortController().signal));
      assert.ok(events.some((e) => e.type === 'failed'));
      assert.ok(!events.some((e) => e.type === 'done'));
    } finally {
      await wrong.close();
      await backup.close();
    }
  });

  test('同じ塊に載った失敗の文を本文として流さず、次の候補へ回す', async () => {
    const broken = await sse([
      JSON.stringify({ choices: [{ delta: { content: '\n[止まりました: コンテキストウィンドウがあふれました]' }, finish_reason: 'error' }] }), '[DONE]',
    ]);
    const backup = await startFakeServer({ kind: 'stream', text: '次で答えた' });
    try {
      const registry = new ProviderRegistry();
      registry.register(new OpenAiCompatibleProvider({ id: 'a', baseUrl: broken, locality: 'local' }));
      registry.register(new OpenAiCompatibleProvider({ id: 'b', baseUrl: backup.baseUrl, locality: 'local' }));
      const events = await drain(new ChatOrchestrator(registry).run(
        { candidates: ['a:m', 'b:m'], messages: [{ role: 'user', content: 'hi' }] }, new AbortController().signal));
      const text = events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('');
      assert.doesNotMatch(text, /止まりました/);
      assert.equal(events.find((e) => e.type === 'done')?.modelId, 'b:m');
    } finally {
      await backup.close();
    }
  });
});

describe('番号の無いツールの呼び出し', () => {
  test('別の id が来たら、別の呼び出しとして分ける（名前も二重にしない）', async () => {
    const url = await sse([
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: 'a', function: { name: 'f', arguments: '{}' } }] } }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: 'b', function: { name: 'g', arguments: '{"x":1}' } }] } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }), '[DONE]',
    ]);
    const provider = new OpenAiCompatibleProvider({ id: 'p', baseUrl: url, locality: 'local' });
    const calls: { name: string; args: unknown }[] = [];
    for await (const ch of provider.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, new AbortController().signal)) {
      if (ch.type === 'toolCall') calls.push({ name: ch.call.name, args: ch.call.args });
    }
    assert.deepEqual(calls.map((c) => c.name), ['f', 'g']);
  });
  test('id が最初の欠片だけで、引数が後から欠片で来ても一つに繋ぐ。id 付きの欠片が交互に来ても混ぜない', async () => {
    const url = await sse([
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: 'a', function: { name: 'f', arguments: '{"x"' } }] } }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: 'b', function: { name: 'g', arguments: '{"y"' } }] } }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: 'a', function: { arguments: ':1}' } }] } }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: 'b', function: { arguments: ':2' } }] } }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ function: { arguments: '}' } }] } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }), '[DONE]',
    ]);
    const provider = new OpenAiCompatibleProvider({ id: 'p', baseUrl: url, locality: 'local' });
    const calls: { name: string; args: unknown }[] = [];
    for await (const ch of provider.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, new AbortController().signal)) {
      if (ch.type === 'toolCall') calls.push({ name: ch.call.name, args: ch.call.args });
    }
    assert.deepEqual(calls, [{ name: 'f', args: { x: 1 } }, { name: 'g', args: { y: 2 } }]);
  });
});

describe('baseUrl の利用者名とパスワード', () => {
  test('失敗の文の URL から利用者名とパスワードを伏せる', () => {
    assert.equal(hideUrlCredentials('cannot: https://user:secret@host/v1 x'), 'cannot: https://***@host/v1 x');
    assert.equal(hideUrlCredentials('see https://host/v1'), 'see https://host/v1');
    // 符号化していない @ をパスワードに含んでも、残りを見せない
    assert.equal(hideUrlCredentials('https://user:p@ss@host/v1'), 'https://***@host/v1');
  });
  test('利用者名・パスワード付きの baseUrl は、設定で断る', async () => {
    const restore = hideAasEnv();
    try {
      const dir = await tempDir('aas-cfg-cred-');
      await writeFile(join(dir, 'aas.config.json'), JSON.stringify({
        providers: [{ id: 'relay', kind: 'openai-compatible', locality: 'cloud', baseUrl: 'https://u:secret@relay.example/v1', enabled: true }],
      }), 'utf8');
      assert.throws(() => loadConfig(dir), (e: unknown) => e instanceof ConfigBroken && /利用者名やパスワード/.test(e.message) && !e.message.includes('secret'));
    } finally {
      restore();
    }
  });
});
