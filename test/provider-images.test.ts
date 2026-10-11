/**
 * 利用者が添えた画像を、画像を読める送り口が正しい形で送る（DECISIONS 10-11、画像を渡す仕組み）。
 *
 * OpenAI 互換は content を文と `image_url`（data URL）の並びに、Claude は `image` ブロック（base64）にする。
 * 画像の無い依頼・利用者でない役の形は今までどおり。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toWireMessage } from '../src/providers/openai-compatible.ts';
import { toAnthropicMessages, withoutToolBlocks } from '../src/providers/anthropic.ts';
import type { ProviderMessage } from '../src/providers/contract.ts';

const png = { mime: 'image/png', data: 'iVBORw0KGgo=' };

test('OpenAI 互換: 画像を添えた依頼は、文と画像の並びで送る', () => {
  const wire = toWireMessage({ role: 'user', content: 'この画面を見て', images: [png] });
  assert.deepEqual(wire, {
    role: 'user',
    content: [
      { type: 'text', text: 'この画面を見て' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
    ],
  });
});

test('OpenAI 互換: 画像の無い依頼は、今までどおり文字列で送る（対）', () => {
  assert.deepEqual(toWireMessage({ role: 'user', content: 'こんにちは' }), { role: 'user', content: 'こんにちは' });
});

test('Claude: 画像を添えた依頼は、画像ブロックを文の前に置いて送る', () => {
  const msgs: ProviderMessage[] = [{ role: 'user', content: 'この画面を見て', images: [png] }];
  const out = toAnthropicMessages(msgs);
  assert.deepEqual(out, [{
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
      { type: 'text', text: 'この画面を見て' },
    ],
  }]);
});

test('Claude: ツールを渡さない依頼に畳むときも、利用者の画像は落とさない', () => {
  const msgs: ProviderMessage[] = [{ role: 'user', content: '見て', images: [png] }];
  const out = toAnthropicMessages(withoutToolBlocks(msgs));
  assert.equal(out[0]?.content[0]?.type, 'image');
});

test('Claude: 利用者でない役に付いた画像は送らない', () => {
  const out = toAnthropicMessages([{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a', images: [png] }]);
  assert.ok(!out.some((m) => m.content.some((b) => b.type === 'image')));
});
