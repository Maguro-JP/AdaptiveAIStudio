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

  test('**地元の口は、落ちても冷やさない**（次の送信で読み直せば使えるので）', async () => {
    // 子プロセスが消えたのと同じ形: 繋がるが、途中で落ちる（HTTP 503）。
    const local = await startFakeServer({ kind: 'status', status: 503, body: 'gone' });
    const cloud = await startFakeServer({ kind: 'status', status: 503, body: 'gone' });
    try {
      const registry = new ProviderRegistry();
      registry.register(new OpenAiCompatibleProvider({ id: 'inproc', baseUrl: local.baseUrl, locality: 'local' }));
      registry.register(new OpenAiCompatibleProvider({ id: 'cloud', baseUrl: cloud.baseUrl, locality: 'cloud' }));
      const events = await drain(new ChatOrchestrator(registry).run(
        { candidates: ['inproc:m', 'cloud:m'], messages: [{ role: 'user', content: 'hi' }] },
        new AbortController().signal,
      ));
      assert.equal(events.at(-1)?.type, 'failed');
      // 地元は、次の送信でそのまま候補に残る。雲は、これまで通り冷やす。
      assert.equal(registry.isAvailable('inproc'), true, '地元の口を冷やしている。読み直せても 5 分使えない');
      assert.equal(registry.isAvailable('cloud'), false, '雲の口を冷やしていない');
    } finally {
      await local.close();
      await cloud.close();
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
