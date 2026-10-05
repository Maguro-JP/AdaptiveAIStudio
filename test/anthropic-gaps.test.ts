/**
 * Claude の口の抜け（33 回目の調査、DECISIONS 10-05）。
 *
 * - コンテキストウィンドウを使い切った終わり方（`model_context_window_exceeded`）を、上限で切れたものとして読む
 * - ほかの口が付けた呼び出しの id（`.` や `:` を含む・空）を、Claude が受ける字に直し、結果の側も同じ名前へ引き直す
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { finishFromStop, toAnthropicMessages } from '../src/providers/anthropic.ts';

describe('Claude の口', () => {
  test('コンテキストウィンドウを使い切った終わり方は、上限で切れたもの', () => {
    assert.equal(finishFromStop('model_context_window_exceeded'), 'length');
    assert.equal(finishFromStop('max_tokens'), 'length');
    assert.equal(finishFromStop('end_turn'), 'stop');
    assert.equal(finishFromStop('tool_use'), 'toolCalls');
    assert.equal(finishFromStop('pause_turn'), undefined);
  });

  test('ほかの口の id を、Claude が受ける字に直す（結果も同じ名前へ）', () => {
    const got = toAnthropicMessages([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'functions.read_file:0', name: 'read_file', args: { path: 'a' } }] },
      { role: 'tool', content: '中身', toolCallId: 'functions.read_file:0' },
    ]);
    const blocks = got.flatMap((m) => m.content);
    const use = blocks.find((b) => b.type === 'tool_use') as { id: string };
    const result = blocks.find((b) => b.type === 'tool_result') as { tool_use_id: string; content: string };
    assert.match(use.id, /^[A-Za-z0-9_-]+$/, `受けない字が残った: ${use.id}`);
    assert.equal(result.tool_use_id, use.id, '結果が呼び出しと別の名前を指している');
    assert.equal(result.content, '中身', '結果の代わりに「結果がありません」を補った');
  });

  test('空の id でも、結果を同じ名前へ引き直す', () => {
    const got = toAnthropicMessages([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: '', toolCalls: [{ id: '', name: 'list', args: {} }] },
      { role: 'tool', content: '一覧', toolCallId: '' },
    ]);
    const blocks = got.flatMap((m) => m.content);
    const uses = blocks.filter((b) => b.type === 'tool_use') as Array<{ id: string }>;
    const results = blocks.filter((b) => b.type === 'tool_result') as Array<{ tool_use_id: string; content: string }>;
    assert.equal(uses.length, 1);
    assert.deepEqual(results.map((r) => [r.tool_use_id, r.content]), [[uses[0]!.id, '一覧']]);
  });
});
