/**
 * 外の口が「この秒数は待て」（Retry-After）と言ったら、その間はその口へ送らない。
 *
 * 冷やす時間を種類ごとの決まった長さ（制限なら 1 分）だけで決めていたので、1 時間待てと言われても 1 分後にまた送り、
 * 断られては切り替える、を繰り返していた（DECISIONS 10-05）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAiCompatibleProvider } from '../src/providers/openai-compatible.ts';
import { ProviderRegistry } from '../src/core/registry.ts';
import { ChatOrchestrator, type ChatEvent } from '../src/core/orchestrator.ts';
import { parseRetryAfter } from '../src/providers/errors.ts';
import { startFakeServer } from './fake-server.ts';

const MINUTE = 60_000;

async function drain(gen: AsyncGenerator<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

async function cooledFor(retryAfter: string | undefined): Promise<number> {
  const primary = await startFakeServer({ kind: 'status', status: 429, body: 'slow down', ...(retryAfter === undefined ? {} : { retryAfter }) });
  const backup = await startFakeServer({ kind: 'stream', text: 'つづき' });
  try {
    const registry = new ProviderRegistry();
    registry.register(new OpenAiCompatibleProvider({ id: 'cloud', baseUrl: primary.baseUrl, locality: 'cloud' }));
    registry.register(new OpenAiCompatibleProvider({ id: 'local', baseUrl: backup.baseUrl, locality: 'local' }));
    const events = await drain(new ChatOrchestrator(registry).run(
      { candidates: ['cloud:m', 'local:m'], messages: [{ role: 'user', content: 'hi' }] },
      new AbortController().signal,
    ));
    assert.equal(events.find((e) => e.type === 'done')?.modelId, 'local:m');
    return registry.cooldownRemainingMs('cloud');
  } finally {
    await primary.close();
    await backup.close();
  }
}

describe('Retry-After と冷やす時間', () => {
  test('1 時間待てと言われたら、1 時間はその口へ送らない', async () => {
    const left = await cooledFor('3600');
    assert.ok(left > 59 * MINUTE, `冷やす時間が言われた長さより短い: ${Math.round(left / 1000)} 秒`);
    assert.ok(left <= 60 * MINUTE + 1000);
  });

  test('言われなければ、種類ごとの長さのまま（対）', async () => {
    const left = await cooledFor(undefined);
    assert.ok(left > 0 && left <= MINUTE, `制限の冷やしが 1 分ではない: ${Math.round(left / 1000)} 秒`);
  });

  test('種類ごとの長さより短く言われても、短くはしない（対）', async () => {
    const left = await cooledFor('1');
    assert.ok(left > 50_000, `言われた 1 秒に縮めた: ${Math.round(left / 1000)} 秒`);
  });

  test('とても長く言われても、一日で区切る', async () => {
    const left = await cooledFor('999999999');
    assert.ok(left <= 24 * 60 * MINUTE, `一日を超えて冷やした: ${Math.round(left / 3_600_000)} 時間`);
    assert.ok(left > 23 * 60 * MINUTE);
  });

  test('負の秒数や過去の日時は、待たない（0）として読む', () => {
    assert.equal(parseRetryAfter('-5'), 0);
    assert.equal(parseRetryAfter(new Date(Date.now() - 60_000).toUTCString()), 0);
    assert.equal(parseRetryAfter('2'), 2000);
    assert.equal(parseRetryAfter('abc'), undefined);
  });
});
