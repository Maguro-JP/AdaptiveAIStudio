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
