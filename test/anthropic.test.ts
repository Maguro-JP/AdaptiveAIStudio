/**
 * Claudeアダプタの契約適合テスト。
 * SDKの baseURL を偽サーバへ向け、SDK固有例外が正規化されることを確認する。
 *
 * このうち5件は @anthropic-ai/sdk が要る。
 * クラウドは既定で無効なので、入っていないのが普通の状態であり、
 * **入っていないことを失敗として数えない**。
 * 毎回4件赤いままだと、本物の失敗がその中に紛れて見えなくなる。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicProvider } from '../src/providers/anthropic.ts';
import { ProviderError } from '../src/providers/errors.ts';
import { startFakeServer } from './fake-server.ts';

/** SDK が入っているか。入っていなければ、その分は飛ばす。 */
const sdkMissing = await (async () => {
  try { await import('@anthropic-ai/sdk'); return false; } catch { return true; }
})();
const needsSdk = {
  skip: sdkMissing
    ? '@anthropic-ai/sdk が未導入（クラウドは既定で無効なので、入れなくても支障ありません）'
    : false,
};

async function kindOf(status: number, body: string): Promise<string> {
  const server = await startFakeServer({ kind: 'status', status, body });
  process.env.ANTHROPIC_BASE_URL = server.baseUrl.replace(/\/v1$/, '');
  try {
    const p = new AnthropicProvider({ apiKey: 'test-key' });
    const err = await (async () => {
      for await (const _ of p.chat(
        { model: 'claude-opus-5', messages: [{ role: 'user', content: 'hi' }] },
        new AbortController().signal,
      )) { /* 到達しない */ }
    })().then(() => undefined, (e: unknown) => e);
    assert.ok(err instanceof ProviderError, `ProviderError ではない: ${err}`);
    return err.kind;
  } finally {
    delete process.env.ANTHROPIC_BASE_URL;
    await server.close();
  }
}

describe('Claudeアダプタの契約適合', () => {
  test('429 は rate_limited に正規化される', needsSdk, async () => {
    assert.equal(await kindOf(429, '{"error":{"message":"rate limit"}}'), 'rate_limited');
  });

  test('401 は auth に正規化される', needsSdk, async () => {
    assert.equal(await kindOf(401, '{"error":{"message":"invalid api key"}}'), 'auth');
  });

  test('500 は unavailable に正規化される', needsSdk, async () => {
    assert.equal(await kindOf(500, '{"error":{"message":"oops"}}'), 'unavailable');
  });

  test('プロンプト長超過は context_too_long に正規化される', needsSdk, async () => {
    assert.equal(
      await kindOf(400, '{"error":{"message":"prompt is too long: 300000 tokens"}}'),
      'context_too_long',
    );
  });

  test('その他の400は invalid_request（フォールバックしない）', needsSdk, async () => {
    const kind = await kindOf(400, '{"error":{"message":"unknown field foo"}}');
    assert.equal(kind, 'invalid_request');
  });

  test('APIキー未設定でも health は例外を投げない', async () => {
    const p = new AnthropicProvider({ apiKey: 'test-key' });
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1';
    try {
      const h = await p.health();
      assert.equal(h.ok, false);
    } finally {
      delete process.env.ANTHROPIC_BASE_URL;
    }
  });
});

describe('Claude でツールを使う', () => {
  test('ツールの結果（role: tool）は tool_result、呼び出しは tool_use にして送り、同じ役はまとめる', async () => {
    const { toAnthropicMessages } = await import('../src/providers/anthropic.ts');
    const got = toAnthropicMessages([
      { role: 'system', content: 's' },
      { role: 'user', content: 'a.txt を読んで' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'a.txt' } }, { id: 'c2', name: 'list_files', args: 'x' }] },
      { role: 'tool', content: '中身', toolCallId: 'c1' },
      { role: 'tool', content: '一覧', toolCallId: 'c2' },
      { role: 'assistant', content: '読みました' },
    ]);
    assert.deepEqual(got, [
      { role: 'user', content: [{ type: 'text', text: 'a.txt を読んで' }] },
      { role: 'assistant', content: [
        { type: 'tool_use', id: 'c1', name: 'read_file', input: { path: 'a.txt' } },
        { type: 'tool_use', id: 'c2', name: 'list_files', input: {} },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'c1', content: '中身' },
        { type: 'tool_result', tool_use_id: 'c2', content: '一覧' },
      ] },
      { role: 'assistant', content: [{ type: 'text', text: '読みました' }] },
    ]);
  });

  test('結果の無い呼び出しには結果を補い、重なった ID は付け直す（どちらも相手が 400 で断る形）', async () => {
    const { toAnthropicMessages } = await import('../src/providers/anthropic.ts');
    const got = toAnthropicMessages([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'salvaged-0-0', name: 'a', args: {} }, { id: 'c2', name: 'b', args: {} }] },
      { role: 'tool', content: 'r1', toolCallId: 'salvaged-0-0' },
      { role: 'user', content: '次' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'salvaged-0-0', name: 'a', args: {} }] },
      { role: 'tool', content: 'r2', toolCallId: 'salvaged-0-0' },
    ]);
    const uses = got.flatMap((m) => m.content).filter((b) => b.type === 'tool_use').map((b) => (b as { id: string }).id);
    const results = got.flatMap((m) => m.content).filter((b) => b.type === 'tool_result').map((b) => (b as { tool_use_id: string }).tool_use_id);
    assert.equal(new Set(uses).size, uses.length, `ID が重なっている: ${uses.join(', ')}`);
    assert.deepEqual([...results].sort(), [...uses].sort(), `結果の無い呼び出しがある: ${JSON.stringify(got)}`);
    // 補った結果は、呼び出しの直後の user に入っている
    assert.equal(got[2]!.role, 'user');
    assert.deepEqual(got[2]!.content.map((b) => b.type), ['tool_result', 'tool_result', 'text']);
  });

  test('ツールを渡し、返ってきた tool_use をツールの呼び出しとして読む', needsSdk, async () => {
    const { createServer } = await import('node:http');
    let sent: { tools?: { name: string }[]; messages?: { role: string }[] } = {};
    const events = [
      ['message_start', { type: 'message_start', message: { id: 'm1', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name: 'read_file', input: {} } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"a.txt"}' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } }],
      ['message_stop', { type: 'message_stop' }],
    ] as const;
    const srv = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        sent = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(''));
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    try {
      const p = new AnthropicProvider({ apiKey: 'test-key' });
      const chunks = [];
      for await (const c of p.chat({
        model: 'claude-opus-5',
        messages: [
          { role: 'user', content: '読んで' },
          { role: 'assistant', content: '', toolCalls: [{ id: 'c0', name: 'list_files', args: {} }] },
          { role: 'tool', content: 'a.txt', toolCallId: 'c0' },
        ],
        tools: [{ name: 'read_file', description: '読む', parameters: { type: 'object' } }],
        // 既定の設定は temperature を持つ。Opus 5 以降は受け取らず 400 で断るので、送らない
        temperature: 0.2,
      }, new AbortController().signal)) chunks.push(c);
      assert.equal((sent as { temperature?: number }).temperature, undefined, 'temperature を送った');
      assert.deepEqual(sent.tools?.map((t) => t.name), ['read_file'], 'ツールを送っていない');
      assert.equal(sent.messages?.some((m) => m.role === 'tool'), false, 'role: tool のまま送った');
      assert.deepEqual(chunks.find((c) => c.type === 'toolCall'), { type: 'toolCall', call: { id: 'tu1', name: 'read_file', args: { path: 'a.txt' } } });
      assert.deepEqual(chunks.at(-1), { type: 'done', finishReason: 'toolCalls' });
    } finally {
      delete process.env.ANTHROPIC_BASE_URL;
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});
