/**
 * 相手の失敗の見分け方（91 回目の調査）。
 *
 * - Gemini の 1 日の上限（`…PerDay… Please retry in 32.5s`）を、「retry in」の語で一時的な制限と読んでいた（1 分ごとに送り直した）
 * - 400 で「token … limit」と出るだけで（1 分あたりのトークンの制限など）、依頼が長すぎるとして黙って次の候補へ回していた
 * - 404 の本文に「model」の字が入るだけで（`/v1/models/…` の道の打ち間違い）、モデルが無いとして黙って次の候補へ回していた
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kindFromHttpStatus } from '../src/providers/errors.ts';

test('Gemini の 1 日の上限は、使い切りとして読む', () => {
  const body = JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota. quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier. Please retry in 32.5s.' } });
  assert.equal(kindFromHttpStatus(429, body), 'quota_exhausted');
});

test('Gemini の 1 分の上限は、一時的な制限のまま（対）', () => {
  const body = JSON.stringify({ error: { code: 429, message: 'You exceeded your current quota. quotaId: GenerateRequestsPerMinutePerProjectPerModel. Please retry in 41s.' } });
  assert.equal(kindFromHttpStatus(429, body), 'rate_limited');
});

test('400 の 1 分あたりのトークンの制限は、長すぎる依頼ではない', () => {
  const body = JSON.stringify({ error: { message: 'Rate limit reached for tokens per min (TPM): Limit 30000' } });
  assert.notEqual(kindFromHttpStatus(400, body), 'context_too_long');
});

test('400 の文脈の長さの超過は、これまでどおり長すぎる依頼（対）', () => {
  assert.equal(kindFromHttpStatus(400, JSON.stringify({ error: { message: 'This model\'s maximum context length is 8192 tokens' } })), 'context_too_long');
});

test('404 の道の打ち間違いは、モデルが無いとは読まない', () => {
  assert.notEqual(kindFromHttpStatus(404, '404 page not found: /v1/models/chat'), 'model_missing');
});

test('404 のモデルが無いという本文は、これまでどおり（対）', () => {
  assert.equal(kindFromHttpStatus(404, '{"error":"model \\"llama3\\" not found, try pulling it first"}'), 'model_missing');
  assert.equal(kindFromHttpStatus(404, JSON.stringify({ error: { message: 'The model `gpt-9` does not exist', code: 'model_not_found' } })), 'model_missing');
});
