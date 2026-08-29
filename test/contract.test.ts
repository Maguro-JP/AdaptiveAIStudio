/**
 * Provider契約テスト。
 * 新しいProviderを追加したら、このスイートを通すことを条件とする。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAiCompatibleProvider } from '../src/providers/openai-compatible.ts';
import { ProviderError } from '../src/providers/errors.ts';
import type { ProviderRequest } from '../src/providers/contract.ts';
import { startFakeServer, type FakeServer } from './fake-server.ts';

const REQ: ProviderRequest = {
  model: 'fake-model',
  messages: [{ role: 'user', content: 'hello' }],
};

let server: FakeServer;
let provider: OpenAiCompatibleProvider;

before(async () => {
  server = await startFakeServer({ kind: 'stream', text: 'こんにちは' });
  provider = new OpenAiCompatibleProvider({
    id: 'fake', baseUrl: server.baseUrl, locality: 'local', requestTimeoutMs: 3000,
  });
});
after(async () => { await server.close(); });

async function collect(signal = new AbortController().signal) {
  const chunks = [];
  for await (const ch of provider.chat(REQ, signal)) chunks.push(ch);
  return chunks;
}

describe('Provider契約', () => {
  test('テキストが順序通り届き、最後に必ず done が来る', async () => {
    server.setBehavior({ kind: 'stream', text: 'こんにちは' });
    const chunks = await collect();
    const text = chunks.filter((c) => c.type === 'text').map((c) => c.delta).join('');
    assert.equal(text, 'こんにちは');
    assert.equal(chunks.at(-1)?.type, 'done');
  });

  test('usage が取得できる', async () => {
    server.setBehavior({ kind: 'stream', text: 'ab' });
    const usage = (await collect()).find((c) => c.type === 'usage');
    assert.deepEqual(usage, { type: 'usage', inputTokens: 7, outputTokens: 2 });
  });

  test('listModels が ModelId を provider:model 形式で返す', async () => {
    const models = await provider.listModels();
    assert.equal(models[0]?.id, 'fake:fake-model');
  });

  test('429 は rate_limited に正規化され、retry-after が伝わる', async () => {
    server.setBehavior({ kind: 'status', status: 429, body: 'slow down', retryAfter: '2' });
    const err = await collect().then(() => undefined, (e: unknown) => e);
    assert.ok(err instanceof ProviderError);
    assert.equal(err.kind, 'rate_limited');
    assert.equal(err.retryAfterMs, 2000);
  });

  test('429 でも本文が quota なら quota_exhausted になる', async () => {
    server.setBehavior({ kind: 'status', status: 429, body: 'insufficient quota' });
    const err = await collect().then(() => undefined, (e: unknown) => e);
    assert.equal((err as ProviderError).kind, 'quota_exhausted');
  });

  test('401 は auth、500 は unavailable', async () => {
    server.setBehavior({ kind: 'status', status: 401 });
    assert.equal(((await collect().catch((e) => e)) as ProviderError).kind, 'auth');
    server.setBehavior({ kind: 'status', status: 500 });
    assert.equal(((await collect().catch((e) => e)) as ProviderError).kind, 'unavailable');
  });

  test('context超過は context_too_long に正規化される', async () => {
    server.setBehavior({ kind: 'status', status: 400, body: 'maximum context length exceeded' });
    assert.equal(((await collect().catch((e) => e)) as ProviderError).kind, 'context_too_long');
  });

  test('AbortSignal で中断でき、canceled として区別される', async () => {
    server.setBehavior({ kind: 'hang' });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const err = await collect(ac.signal).then(() => undefined, (e: unknown) => e);
    assert.equal((err as ProviderError).kind, 'canceled');
  });

  test('到達不能なProviderの health は例外を投げず reason を返す', async () => {
    const dead = new OpenAiCompatibleProvider({
      id: 'dead', baseUrl: 'http://127.0.0.1:1/v1', locality: 'local',
    });
    const h = await dead.health();
    assert.equal(h.ok, false);
  });
});
