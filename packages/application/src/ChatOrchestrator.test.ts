import { describe, expect, it } from 'vitest';
import type { ModelDescriptor, RoutingPolicy } from '@aas/core';
import {
  ProviderError,
  type ChatProvider,
  type ProviderChunk,
  type ProviderErrorKind,
} from '@aas/provider-contract';
import { ChatOrchestrator, type ChatEvent } from './ChatOrchestrator.js';
import { FallbackPolicy } from './FallbackPolicy.js';
import { ModelRouter } from './ModelRouter.js';
import { ProviderRegistry } from './ProviderRegistry.js';

const descriptor = (id: string, providerId: string, locality: 'local' | 'cloud'): ModelDescriptor => ({
  id,
  providerId,
  displayName: id,
  family: providerId,
  capabilities: { streaming: true, toolUse: false, vision: false, jsonMode: false, systemPrompt: true },
  limits: { contextWindow: 8192, maxOutputTokens: 2048 },
  locality,
});

const CLOUD = descriptor('anthropic:claude', 'anthropic', 'cloud');
const LOCAL = descriptor('ollama:qwen', 'ollama', 'local');
const CATALOG = new Map([CLOUD, LOCAL].map((d) => [d.id, d]));
const POLICY: RoutingPolicy = { byTask: {}, default: [CLOUD.id, LOCAL.id] };

function stubProvider(id: string, behavior: () => AsyncIterable<ProviderChunk>): ChatProvider {
  return {
    id,
    locality: id === 'ollama' ? 'local' : 'cloud',
    listModels: async () => [],
    health: async () => ({ reachable: true }),
    chat: () => behavior(),
  };
}

const failing = (kind: ProviderErrorKind, providerId: string) =>
  stubProvider(providerId, async function* () {
    throw new ProviderError({ kind, providerId });
    yield { type: 'done', finishReason: 'stop' } as ProviderChunk;
  });

const answering = (providerId: string, text: string) =>
  stubProvider(providerId, async function* () {
    yield { type: 'text', delta: text };
    yield { type: 'usage', inputTokens: 3, outputTokens: 4 };
    yield { type: 'done', finishReason: 'stop' };
  });

function build(providers: ChatProvider[]) {
  const registry = new ProviderRegistry();
  for (const p of providers) registry.register(p);
  const router = new ModelRouter(registry, CATALOG);
  return {
    registry,
    orchestrator: new ChatOrchestrator(registry, router, new FallbackPolicy(0)),
  };
}

async function drain(it: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const input = { task: 'chat' as const, policy: POLICY, messages: [{ role: 'user' as const, content: 'hi' }] };

describe('ChatOrchestrator', () => {
  it('制限到達時にローカルへ落ち、切替をイベントで可視化する', async () => {
    const { registry, orchestrator } = build([
      failing('rate_limited', 'anthropic'),
      answering('ollama', 'ローカルの応答'),
    ]);

    const events = await drain(orchestrator.run(input));

    expect(events.filter((e) => e.type === 'fallback')).toEqual([
      { type: 'fallback', from: CLOUD.id, to: LOCAL.id, reason: 'rate_limited' },
    ]);
    const done = events.find((e) => e.type === 'done');
    expect(done).toMatchObject({ modelId: LOCAL.id, fallbackFrom: CLOUD.id });
    expect(registry.isCoolingDown('anthropic')).toBe(true);
  });

  it('invalid_request ではフォールバックせずに失敗する', async () => {
    const { orchestrator } = build([
      failing('invalid_request', 'anthropic'),
      answering('ollama', 'x'),
    ]);
    const events = await drain(orchestrator.run(input));
    expect(events.some((e) => e.type === 'fallback')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'error', kind: 'invalid_request' });
  });

  it('冷却中の Provider は候補から外れる', async () => {
    const { registry, orchestrator } = build([
      failing('quota_exhausted', 'anthropic'),
      answering('ollama', 'ローカル'),
    ]);
    registry.cooldown('anthropic', 60_000);
    const events = await drain(orchestrator.run(input));
    expect(events[0]).toEqual({ type: 'modelSelected', modelId: LOCAL.id });
    expect(events.some((e) => e.type === 'fallback')).toBe(false);
  });

  it('候補が全滅した場合はエラーで終わる', async () => {
    const { orchestrator } = build([
      failing('unavailable', 'anthropic'),
      failing('unavailable', 'ollama'),
    ]);
    expect((await drain(orchestrator.run(input))).at(-1)).toMatchObject({ type: 'error' });
  });

  it('pinnedModelId は候補列の先頭になる', async () => {
    const { orchestrator } = build([answering('anthropic', 'c'), answering('ollama', 'l')]);
    const events = await drain(orchestrator.run({ ...input, pinnedModelId: LOCAL.id }));
    expect(events[0]).toEqual({ type: 'modelSelected', modelId: LOCAL.id });
  });
});
