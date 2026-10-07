/**
 * 会話のコンテキストウィンドウと Claude の口の不具合（67 回目の調査）。
 *
 * - コンテキストウィンドウに収めるために切るとき、絵文字などの対になる文字を割り、片割れを送った
 * - ツールを渡さない回（雑談と見た回）でも、前の回のツールのやりとりを tool_use・tool_result のまま Claude へ送った（tools 無しでは断られる）
 *
 * 合議と考えごとの担当にコンテキストウィンドウを渡していなかった件は、偽の orchestrator で読んだファイルの扱いを見る試験が要るので書いていない（確かめていない）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fitToWindow } from '../src/agent/window.ts';
import { AnthropicProvider } from '../src/providers/anthropic.ts';

const sdkMissing = await (async () => {
  try { await import('@anthropic-ai/sdk'); return false; } catch { return true; }
})();

/** 対になっていない片割れ（上半分だけ・下半分だけ） */
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('コンテキストウィンドウに収める', () => {
  test('**切るときに、対になる文字を割らない**', () => {
    const big = 'a'.repeat(399) + '😀' + 'b'.repeat(3000);
    const history = [
      { role: 'user' as const, content: '最初の依頼' },
      ...Array.from({ length: 6 }, (_, i) => [
        { role: 'assistant' as const, content: '', toolCalls: [{ id: `c${i}`, name: 'read_file', args: { path: `f${i}` } }] },
        { role: 'tool' as const, content: big, toolCallId: `c${i}` },
      ]).flat(),
      { role: 'user' as const, content: '今の依頼' },
    ];
    const { messages, trimmed } = fitToWindow(history, 3000);
    assert.ok(trimmed, '前提: 切っていない');
    for (const m of messages) assert.ok(!LONE.test(m.content), `片割れの文字が残った: …${m.content.slice(395, 405)}…`);
  });
});

describe('Claude の口', () => {
  test('**ツールを渡さない回は、前の回のツールのやりとりを文に畳んで送る**', { skip: sdkMissing ? 'SDK が未導入' : false }, async () => {
    let sent = '';
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        sent = body;
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end('{"type":"error","error":{"type":"invalid_request_error","message":"stop here"}}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const p = new AnthropicProvider({ apiKey: 'test-key' });
      await (async () => {
        for await (const _ of p.chat({
          model: 'claude-opus-5',
          tools: [],
          messages: [
            { role: 'user', content: '読んで' },
            { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'a.ts' } }] },
            { role: 'tool', content: '中身', toolCallId: 'c1' },
            { role: 'assistant', content: '読みました' },
            { role: 'user', content: 'ありがとう' },
          ],
        }, new AbortController().signal)) { /* 断られる */ }
      })().catch(() => undefined);
      assert.ok(sent, '前提: 依頼が届いていない');
      assert.doesNotMatch(sent, /"tool_use"|"tool_result"/, 'ツールを渡さない回に、ツールのブロックを送った');
      assert.match(sent, /read_file/, '何を呼んだかを残していない');
    } finally {
      delete process.env.ANTHROPIC_BASE_URL;
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
