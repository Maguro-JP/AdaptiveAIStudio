/** フォールバックの挙動 — 本プロジェクトの中核。 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAiCompatibleProvider } from '../src/providers/openai-compatible.ts';
import { ProviderRegistry } from '../src/core/registry.ts';
import { ChatOrchestrator, type ChatEvent } from '../src/core/orchestrator.ts';
import { startFakeServer } from './fake-server.ts';

async function drain(gen: AsyncGenerator<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

describe('ChatOrchestrator', () => {
  test('制限に達した第1候補から第2候補へ自動で切り替わる', async () => {
    const primary = await startFakeServer({ kind: 'status', status: 429, body: 'rate limit' });
    const backup = await startFakeServer({ kind: 'stream', text: 'ローカルで継続' });
    try {
      const registry = new ProviderRegistry();
      registry.register(new OpenAiCompatibleProvider({ id: 'cloud', baseUrl: primary.baseUrl, locality: 'cloud' }));
      registry.register(new OpenAiCompatibleProvider({ id: 'local', baseUrl: backup.baseUrl, locality: 'local' }));

      const events = await drain(new ChatOrchestrator(registry).run(
        { candidates: ['cloud:m', 'local:m'], messages: [{ role: 'user', content: 'hi' }] },
        new AbortController().signal,
      ));

      const fallback = events.find((e) => e.type === 'fallback');
      assert.ok(fallback, 'fallback イベントが発生していない');
      assert.equal(fallback.from, 'cloud:m');
      assert.equal(fallback.to, 'local:m');

      const text = events.filter((e) => e.type === 'text').map((e) => e.delta).join('');
      assert.equal(text, 'ローカルで継続');

      const done = events.find((e) => e.type === 'done');
      assert.equal(done?.modelId, 'local:m');
      assert.equal(done?.fallbackFrom, 'cloud:m');

      // 制限に達したProviderは冷却され、次のリクエストの候補から外れる
      assert.equal(registry.isAvailable('cloud'), false);
    } finally {
      await primary.close();
      await backup.close();
    }
  });

  test('invalid_request はフォールバックせず即失敗する', async () => {
    const primary = await startFakeServer({ kind: 'status', status: 400, body: 'bad field' });
    const backup = await startFakeServer({ kind: 'stream', text: 'ここには来ない' });
    try {
      const registry = new ProviderRegistry();
      registry.register(new OpenAiCompatibleProvider({ id: 'a', baseUrl: primary.baseUrl, locality: 'cloud' }));
      registry.register(new OpenAiCompatibleProvider({ id: 'b', baseUrl: backup.baseUrl, locality: 'local' }));

      const events = await drain(new ChatOrchestrator(registry).run(
        { candidates: ['a:m', 'b:m'], messages: [{ role: 'user', content: 'hi' }] },
        new AbortController().signal,
      ));

      const failed = events.find((e) => e.type === 'failed');
      assert.equal(failed?.error.kind, 'invalid_request');
      assert.equal(events.some((e) => e.type === 'fallback'), false);
      assert.equal(backup.requests, 0, '第2候補が呼ばれてしまっている');
    } finally {
      await primary.close();
      await backup.close();
    }
  });

  test('全候補が使えない場合は failed で終わる', async () => {
    const registry = new ProviderRegistry();
    const events = await drain(new ChatOrchestrator(registry).run(
      { candidates: ['missing:m'], messages: [{ role: 'user', content: 'hi' }] },
      new AbortController().signal,
    ));
    assert.equal(events.at(-1)?.type, 'failed');
  });
});
