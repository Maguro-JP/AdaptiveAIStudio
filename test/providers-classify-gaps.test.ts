/**
 * 80 回目の不具合調査（モデルとの通信の残り）の分。
 *
 * - 「too long」の語だけで、大きすぎる依頼にしない（ツールの説明の上限・出力の上限はこちらの誤り）
 * - Claude の利用額の上限は、次の候補へ回す種類（上限切れ）
 * - 一つの返事に同じ id の呼び出しが二つあっても、Claude へ送る結果を取り違えない
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { kindFromHttpStatus, saysContextTooLong } from '../src/providers/errors.ts';
import { toAnthropicMessages } from '../src/providers/anthropic.ts';
import type { ProviderMessage } from '../src/providers/contract.ts';

describe('大きすぎる依頼かどうか', () => {
  test('**ツールの説明の文字数の上限（string too long）は、大きすぎる依頼ではない**', () => {
    const body = JSON.stringify({ error: { message: "Invalid 'tools[3].function.description': string too long. Expected a string with maximum length 1024", code: 'string_above_max_length' } });
    assert.notEqual(kindFromHttpStatus(400, body), 'context_too_long');
  });

  test('**出力の上限を超えた max_tokens は、大きすぎる依頼ではない**', () => {
    assert.equal(saysContextTooLong('max_tokens: 16000 > 8192, which is the maximum allowed number of output tokens for claude-x'), false);
  });

  test('本当に長い依頼は、これまでどおり大きすぎる依頼（対）', () => {
    assert.equal(saysContextTooLong("This model's maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens."), true);
    assert.equal(saysContextTooLong('prompt is too long: 210000 tokens > 200000 maximum'), true);
    assert.equal(kindFromHttpStatus(400, JSON.stringify({ error: { code: 'context_length_exceeded', message: 'x' } })), 'context_too_long');
  });
});

describe('Claude の利用額の上限', () => {
  test('**上限切れとして、次の候補へ回す種類にする**', () => {
    const body = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.' } });
    assert.equal(kindFromHttpStatus(400, body), 'quota_exhausted');
  });
});

describe('同じ id の呼び出し', () => {
  test('**一つの返事に同じ id が二つあっても、結果をそれぞれの呼び出しに付ける**', () => {
    const msgs: ProviderMessage[] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'X', name: 'a', args: {} }, { id: 'X', name: 'b', args: {} }] },
      { role: 'tool', toolCallId: 'X', content: 'A' },
      { role: 'tool', toolCallId: 'X', content: 'B' },
    ];
    const out = toAnthropicMessages(msgs);
    const uses = out.flatMap((m) => m.content).filter((b) => b.type === 'tool_use') as Array<{ id: string }>;
    const results = out.flatMap((m) => m.content).filter((b) => b.type === 'tool_result') as Array<{ tool_use_id: string; content: string }>;
    assert.equal(uses.length, 2);
    assert.notEqual(uses[0]!.id, uses[1]!.id);
    assert.deepEqual(results.map((r) => [r.tool_use_id, r.content]), [[uses[0]!.id, 'A'], [uses[1]!.id, 'B']],
      JSON.stringify(results));
  });
});
