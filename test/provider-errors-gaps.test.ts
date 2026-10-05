/**
 * 送り先の失敗の分け方（30 回目の調査）。
 *
 * - 残高切れ（402・Claude の 400 の credit balance）を「こちらの誤り」にせず、次の候補へ回す
 * - 一時的な制限の本文に入った billing の URL で、30 分冷やす切れと取り違えない
 * - ツールに対応していないモデル（400 の does not support tools）は、次の候補へ回す
 * - 413（大きすぎる）は、やり直さずに次の候補へ。Claude の待ち時間は 429 以外からも読む
 * - 答えの判定で、閉じていない考えごとの中の数字を答えとして採らない
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAiCompatibleProvider } from '../src/providers/openai-compatible.ts';
import { AnthropicProvider } from '../src/providers/anthropic.ts';
import { ProviderError, kindFromHttpStatus } from '../src/providers/errors.ts';
import { ProviderRegistry } from '../src/core/registry.ts';
import { ChatOrchestrator, type ChatEvent } from '../src/core/orchestrator.ts';
import { judgeAnswer } from '../src/cli/ask-once.ts';
import { startFakeServer } from './fake-server.ts';

async function fallsBack(status: number, body: string): Promise<{ fell: boolean; text: string }> {
  const primary = await startFakeServer({ kind: 'status', status, body });
  const backup = await startFakeServer({ kind: 'stream', text: '手元で続けます' });
  try {
    const registry = new ProviderRegistry();
    registry.register(new OpenAiCompatibleProvider({ id: 'cloud', baseUrl: primary.baseUrl, locality: 'cloud' }));
    registry.register(new OpenAiCompatibleProvider({ id: 'local', baseUrl: backup.baseUrl, locality: 'local' }));
    const events: ChatEvent[] = [];
    for await (const ev of new ChatOrchestrator(registry).run(
      { candidates: ['cloud:m', 'local:m'], messages: [{ role: 'user', content: 'hi' }] },
      new AbortController().signal,
    )) events.push(ev);
    return {
      fell: events.some((e) => e.type === 'fallback'),
      text: events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join(''),
    };
  } finally {
    await primary.close();
    await backup.close();
  }
}

describe('次の候補へ回る失敗', () => {
  for (const [label, status, body] of [
    ['402 の残高切れ', 402, '{"error":{"message":"Insufficient credits"}}'],
    ['400 で返る残高切れ', 400, '{"error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the API. Please go to Plans & Billing"}}'],
    ['ツールに対応していないモデル', 400, '{"error":"registry.ollama.ai/library/gemma3:latest does not support tools"}'],
    ['413 の大きすぎる依頼', 413, '{"error":{"message":"request_too_large"}}'],
  ] as const) {
    test(`**${label}なら、手元の候補へ回る**（依頼ごと落とさない）`, async () => {
      const r = await fallsBack(status, body);
      assert.ok(r.fell, `次の候補へ回っていない: ${label}`);
      assert.equal(r.text, '手元で続けます');
    });
  }
  test('ただの書き間違い（400）は、今までどおり止める（対）', async () => {
    assert.equal(kindFromHttpStatus(400, '{"error":{"message":"messages: field required"}}'), 'invalid_request');
  });
});

describe('制限と切れの見分け', () => {
  test('**一時的な制限の本文に billing の URL があっても、切れと読まない**', () => {
    const body = '{"error":{"code":"rate_limit_exceeded","message":"Rate limit reached. Upgrade at https://console.example.com/settings/billing"}}';
    assert.equal(kindFromHttpStatus(429, body), 'rate_limited');
    assert.equal(kindFromHttpStatus(429, 'Rate limit reached, see https://platform.example.com/account/billing'), 'rate_limited');
  });
  test('切れを言う本文は、今までどおり切れと読む（対）', () => {
    assert.equal(kindFromHttpStatus(429, '{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}'), 'quota_exhausted');
    assert.equal(kindFromHttpStatus(429, 'You exceeded your current quota, please check your plan'), 'quota_exhausted');
  });
});

/** SDK が入っていなければ、Claude の分は飛ばす（クラウドは既定で無効）。 */
const sdkMissing = await (async () => {
  try { await import('@anthropic-ai/sdk'); return false; } catch { return true; }
})();
const needsSdk = { skip: sdkMissing ? '@anthropic-ai/sdk が未導入' : false };

async function claudeError(status: number, body: string, retryAfter?: string): Promise<ProviderError> {
  const server = await startFakeServer({ kind: 'status', status, body, ...(retryAfter ? { retryAfter } : {}) });
  process.env.ANTHROPIC_BASE_URL = server.baseUrl.replace(/\/v1$/, '');
  try {
    const p = new AnthropicProvider({ apiKey: 'test-key' });
    const err = await (async () => {
      for await (const _ of p.chat({ model: 'claude-x', messages: [{ role: 'user', content: 'hi' }] }, new AbortController().signal)) { /* 届かない */ }
    })().then(() => undefined, (e: unknown) => e);
    assert.ok(err instanceof ProviderError, `ProviderError ではない: ${err}`);
    return err;
  } finally {
    delete process.env.ANTHROPIC_BASE_URL;
    await server.close();
  }
}

describe('Claude の失敗の分け方', () => {
  test('**残高切れ（400 の credit balance）を quota_exhausted にする**', needsSdk, async () => {
    const e = await claudeError(400, '{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}');
    assert.equal(e.kind, 'quota_exhausted');
  });
  test('**413 を context_too_long にする**（同じ依頼をやり直して冷やさない）', needsSdk, async () => {
    const e = await claudeError(413, '{"type":"error","error":{"type":"request_too_large","message":"Request exceeds the maximum allowed number of bytes."}}');
    assert.equal(e.kind, 'context_too_long');
  });
});

describe('答えの判定', () => {
  test('**閉じていない考えごとの中の「2」を、答えとして採らない**', () => {
    assert.ok(judgeAnswer('<think>Okay, 1+1 is 2, so'), '考えごとの中の数字で通した');
  });
  test('考えごとを閉じた後の「2」は、今までどおり採る（対）', () => {
    assert.equal(judgeAnswer('<think>1+1 は</think>2 です'), undefined);
  });
});
