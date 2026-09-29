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

  test('Retry-After で長く待てと言われたら、待たずに次の候補へ回る（1 時間止まったままにしない）', async () => {
    const primary = await startFakeServer({ kind: 'status', status: 429, body: 'slow down', retryAfter: '3600' });
    const backup = await startFakeServer({ kind: 'stream', text: '次の候補で続ける' });
    try {
      const registry = new ProviderRegistry();
      registry.register(new OpenAiCompatibleProvider({ id: 'cloud', baseUrl: primary.baseUrl, locality: 'cloud' }));
      registry.register(new OpenAiCompatibleProvider({ id: 'local', baseUrl: backup.baseUrl, locality: 'local' }));
      const started = Date.now();
      const events = await Promise.race([
        drain(new ChatOrchestrator(registry).run(
          { candidates: ['cloud:m', 'local:m'], messages: [{ role: 'user', content: 'hi' }] },
          new AbortController().signal,
        )),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Retry-After の 1 時間を待っている')), 10_000).unref()),
      ]);
      assert.ok(Date.now() - started < 10_000);
      assert.equal(events.find((e) => e.type === 'done')?.modelId, 'local:m');
    } finally {
      await primary.close();
      await backup.close();
    }
  });

  test('やり直しを待っている間に止めたら、待ち明けを待たずに終わる', async () => {
    const primary = await startFakeServer({ kind: 'status', status: 429, body: 'slow down', retryAfter: '20' });
    try {
      const registry = new ProviderRegistry();
      registry.register(new OpenAiCompatibleProvider({ id: 'cloud', baseUrl: primary.baseUrl, locality: 'cloud' }));
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 300).unref();
      const started = Date.now();
      await Promise.race([
        drain(new ChatOrchestrator(registry).run(
          { candidates: ['cloud:m'], messages: [{ role: 'user', content: 'hi' }] }, ac.signal,
        )),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('止めたのに 20 秒の待ちを続けている')), 10_000).unref()),
      ]);
      assert.ok(Date.now() - started < 10_000);
    } finally {
      await primary.close();
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

  test('**地元の口の時間切れは、やり直さない**（同じだけ待って同じ理由で落ちるので）', async () => {
    const local = await startFakeServer({ kind: 'hang' });
    const cloud = await startFakeServer({ kind: 'hang' });
    try {
      const registry = new ProviderRegistry();
      registry.register(new OpenAiCompatibleProvider({ id: 'inproc', baseUrl: local.baseUrl, locality: 'local', connectTimeoutMs: 50 }));
      registry.register(new OpenAiCompatibleProvider({ id: 'cloud', baseUrl: cloud.baseUrl, locality: 'cloud', connectTimeoutMs: 50 }));
      const events = await drain(new ChatOrchestrator(registry).run(
        { candidates: ['inproc:m', 'cloud:m'], messages: [{ role: 'user', content: 'hi' }] },
        new AbortController().signal,
      ));
      assert.equal(events.at(-1)?.type, 'failed');
      assert.equal(local.requests, 1, '地元の口の時間切れをやり直している（3 回並んで 3 回落ちる）');
      // 雲は、これまで通り 3 回まで試す（対）。
      assert.equal(cloud.requests, 3, '雲の口の再試行まで消えている');
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
