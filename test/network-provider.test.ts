/**
 * ネットワークの送り口（docs/NETWORK-MODEL.md の段階 1）。中身を持たず、中の候補へそのまま渡す。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderRegistry } from '../src/core/registry.ts';
import { ChatOrchestrator, type ChatEvent } from '../src/core/orchestrator.ts';
import { NetworkProvider, NETWORK_MODEL_ID, withNetwork } from '../src/core/network-provider.ts';
import type { ChatProvider, ProviderChunk } from '../src/providers/contract.ts';
import { tempDir } from './tmp.ts';

/** 中のモデルの代わり。決まった本文とツールの呼び出しを返し、受けた依頼を覚える。 */
function fakeInner(id = 'fake'): ChatProvider & { asked: string[] } {
  const asked: string[] = [];
  return {
    id, locality: 'local', asked,
    async health() { return { ok: true }; },
    async listModels() { return [{ id: `${id}:m`, providerId: id, model: 'm', displayName: 'm', locality: 'local' }]; },
    async *chat(req): AsyncIterable<ProviderChunk> {
      asked.push(`${req.model}:${req.messages.at(-1)?.content}`);
      yield { type: 'text', delta: '中の答え' };
      yield { type: 'toolCall', call: { id: 'c1', name: 'read_file', args: { path: 'a.txt' } } };
      yield { type: 'done', finishReason: 'toolCalls' };
    },
  };
}

async function drain(gen: AsyncGenerator<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

describe('ネットワークの送り口', () => {
  test('network へ送った依頼は、中のモデルの本文とツールの呼び出しを返し、答えたモデルを中の名前で言う', async () => {
    const registry = new ProviderRegistry();
    const inner = fakeInner();
    registry.register(inner);
    registry.register(new NetworkProvider(registry, () => ['fake:m']));
    const events = await drain(new ChatOrchestrator(registry).run(
      { candidates: [NETWORK_MODEL_ID, 'fake:m'], messages: [{ role: 'user', content: 'こんにちは' }] },
      new AbortController().signal,
    ));
    assert.equal(events.filter((e) => e.type === 'text').map((e) => e.delta).join(''), '中の答え');
    const call = events.find((e) => e.type === 'toolCall');
    assert.deepEqual(call?.type === 'toolCall' ? call.call : undefined, { id: 'c1', name: 'read_file', args: { path: 'a.txt' } });
    const done = events.find((e) => e.type === 'done');
    assert.equal(done?.type === 'done' ? done.modelId : undefined, 'fake:m');
    assert.equal(done?.type === 'done' ? done.finishReason : undefined, 'toolCalls');
    // 一度だけ渡す（外でもう一度やり直さない）
    assert.deepEqual(inner.asked, ['m:こんにちは']);
  });

  test('network だけを候補に渡しても、作ったときの中の候補へ渡す（送り口の契約の chat でも同じ）', async () => {
    const registry = new ProviderRegistry();
    registry.register(fakeInner());
    const network = new NetworkProvider(registry, () => ['fake:m']);
    registry.register(network);
    const events = await drain(new ChatOrchestrator(registry).run(
      { candidates: [NETWORK_MODEL_ID], messages: [{ role: 'user', content: 'x' }] },
      new AbortController().signal,
    ));
    assert.equal(events.filter((e) => e.type === 'text').map((e) => e.delta).join(''), '中の答え');
    const chunks: ProviderChunk[] = [];
    for await (const c of network.chat({ model: 'network', messages: [{ role: 'user', content: 'x' }] }, new AbortController().signal)) chunks.push(c);
    assert.deepEqual(chunks.map((c) => c.type), ['text', 'toolCall', 'done']);
  });

  test('中で失敗したら、中の失敗をそのまま返す', async () => {
    const registry = new ProviderRegistry();
    registry.register(new NetworkProvider(registry, () => ['nothing:m']));
    const events = await drain(new ChatOrchestrator(registry).run(
      { candidates: [NETWORK_MODEL_ID, 'nothing:m'], messages: [{ role: 'user', content: 'x' }] },
      new AbortController().signal,
    ));
    const failed = events.find((e) => e.type === 'failed');
    assert.match(failed?.type === 'failed' ? failed.error.message : '', /利用できるモデルがありません/);
  });
});

describe('候補の並び', { timeout: 120_000 }, () => {
  test('中のモデルがあれば network が先頭、無ければ何も足さない', () => {
    assert.deepEqual(withNetwork(['a:m', 'b:m']), [NETWORK_MODEL_ID, 'a:m', 'b:m']);
    assert.deepEqual(withNetwork([]), []);
  });

  test('Session の既定の送り先は network で、中で使うモデルが答える', async () => {
    process.env.AAS_STATE_DIR = await tempDir('aas-network-state-');
    const root = await tempDir('aas-network-root-');
    const { Session } = await import('../src/core/session.ts');
    const s = await Session.create({
      providers: [], candidates: ['fake:m'], runtime: { kind: 'none' },
      agent: { root, approval: 'auto', maxTurns: 1, verify: { enabled: false } },
    } as never, { approve: () => Promise.resolve(true) });
    try {
      assert.deepEqual(s.candidates, [NETWORK_MODEL_ID, 'fake:m']);
    } finally {
      await s.close();
    }
  });

  test('中で使うモデルが無いときは、今までどおり候補が空で、モデルが無い理由を持つ', async () => {
    process.env.AAS_STATE_DIR = await tempDir('aas-network-none-state-');
    const root = await tempDir('aas-network-none-root-');
    const { Session } = await import('../src/core/session.ts');
    const s = await Session.create({
      providers: [], runtime: { kind: 'none' },
      agent: { root, approval: 'auto', maxTurns: 1, verify: { enabled: false } },
    } as never, { approve: () => Promise.resolve(true) });
    try {
      assert.deepEqual(s.candidates, []);
      assert.ok(s.modelReason.length > 0, 'モデルが無い理由を持っていない');
    } finally {
      await s.close();
    }
  });
});
