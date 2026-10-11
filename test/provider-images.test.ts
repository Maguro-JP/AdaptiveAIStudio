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
import type { ProviderMessage, ChatProvider, ProviderRequest, ProviderChunk } from '../src/providers/contract.ts';
import { ProviderRegistry } from '../src/core/registry.ts';
import { ChatOrchestrator } from '../src/core/orchestrator.ts';
import { ProviderError } from '../src/providers/errors.ts';

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

// --- 113 回目の調査（DECISIONS 10-11） ---

function provider(id: string, sees: boolean, fail: boolean, seen: ProviderRequest[]): ChatProvider {
  return {
    id, locality: 'local',
    health: async () => ({ ok: true }),
    listModels: async () => [],
    canSeeImages: async () => sees,
    async *chat(req: ProviderRequest): AsyncIterable<ProviderChunk> {
      seen.push(req);
      if (fail) throw new ProviderError({ kind: 'unavailable', providerId: id, message: '落ちた' });
      yield { type: 'text', delta: 'ok' };
      yield { type: 'done', finishReason: 'stop' };
    },
  };
}

test('先頭の候補が落ちて、画像を読めない候補へ切り替わったら、画像を外して渡していないと添える', async () => {
  const seenA: ProviderRequest[] = [];
  const seenB: ProviderRequest[] = [];
  const registry = new ProviderRegistry();
  registry.register(provider('a', true, true, seenA));
  registry.register(provider('b', false, false, seenB));
  const orch = new ChatOrchestrator(registry);
  for await (const _ of orch.run({ candidates: ['a:m', 'b:m'], messages: [{ role: 'user', content: '見て', images: [png] }] }, new AbortController().signal)) { /* 流す */ }
  assert.ok(seenA[0]?.messages[0]?.images?.length, '読める候補に画像が渡っていない（この試験の前提）');
  const toB = seenB[0]?.messages[0];
  assert.ok(toB, '切り替え先に届いていない');
  assert.equal(toB.images, undefined, '読めない候補に画像を渡した');
  assert.match(toB.content, /渡していません/);
});
