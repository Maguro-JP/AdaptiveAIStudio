/**
 * Claude へ送る会話の形（91 回目の調査）。
 *
 * - 対になる呼び出しが直前に無いツールの結果を、そのまま結果として送っていた（Claude が 400 で断る）
 * - 読めなかったツールの引数（こちらの内側の形 `{ __raw, __parseError }`）を、モデルが出した呼び出しとして見せていた
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toAnthropicMessages } from '../src/providers/anthropic.ts';

test('対になる呼び出しの無い結果は、結果として送らない', () => {
  const out = toAnthropicMessages([
    { role: 'user', content: 'hi' },
    { role: 'tool', toolCallId: 'x', content: 'r' },
    { role: 'assistant', content: 'ok' },
  ] as never);
  const blocks = out.flatMap((m) => m.content) as Array<{ type: string }>;
  assert.equal(blocks.some((b) => b.type === 'tool_result'), false, JSON.stringify(out));
  assert.match(JSON.stringify(out), /（ツールの結果）\\nr/);
});

test('対になる呼び出しがあれば、これまでどおり結果として送る（対）', () => {
  const out = toAnthropicMessages([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'a' } }] },
    { role: 'tool', toolCallId: 'c1', content: 'r' },
  ] as never);
  assert.match(JSON.stringify(out), /"type":"tool_result","tool_use_id":"c1"/);
});

test('読めなかった引数は、内側の形のまま見せない', () => {
  const out = toAnthropicMessages([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', args: { __raw: '{bad', __parseError: true } }] },
    { role: 'tool', toolCallId: 'c1', content: 'ERROR' },
  ] as never);
  assert.doesNotMatch(JSON.stringify(out), /__parseError|__raw/, JSON.stringify(out));
});

test('OpenAI 互換の口でも、読めなかった引数はモデルが書いた元の文字列に戻す', async () => {
  const { toWireMessage } = await import('../src/providers/openai-compatible.ts');
  const wire = toWireMessage({ role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', args: { __raw: '{bad', __parseError: true } }] } as never) as { tool_calls: Array<{ function: { arguments: string } }> };
  assert.equal(wire.tool_calls[0]!.function.arguments, '{bad');
});
