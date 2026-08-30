import type { ModelId, RoutingPolicy, TaskKind } from '@aas/core';
import {
  ProviderError,
  isProviderError,
  type ProviderChunk,
  type ProviderMessage,
} from '@aas/provider-contract';
import { type Clock, systemClock } from '@aas/shared';
import type { FallbackPolicy } from './FallbackPolicy.js';
import type { ModelRouter } from './ModelRouter.js';
import type { ProviderRegistry } from './ProviderRegistry.js';

export interface ChatInput {
  task: TaskKind;
  policy: RoutingPolicy;
  system?: string;
  messages: ProviderMessage[];
  params?: { temperature?: number; maxTokens?: number; topP?: number };
  pinnedModelId?: ModelId;
  signal?: AbortSignal;
}

export type ChatEvent =
  | { type: 'modelSelected'; modelId: ModelId }
  /** フォールバックは暗黙に起こしてはならない。必ずイベントとして可視化する (R6)。 */
  | { type: 'fallback'; from: ModelId; to: ModelId; reason: string }
  | { type: 'text'; delta: string }
  | { type: 'toolCall'; id: string; name: string; args: unknown }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'done'; modelId: ModelId; finishReason: string; latencyMs: number; fallbackFrom?: ModelId }
  | { type: 'error'; kind: string; message: string };

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  ms <= 0
    ? Promise.resolve()
    : new Promise((resolve) => {
        const t = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
      });

/** Router → Provider実行 → 失敗判定 → 次候補 までを統括する。 */
export class ChatOrchestrator {
  constructor(
    private readonly registry: ProviderRegistry,
    private readonly router: ModelRouter,
    private readonly fallback: FallbackPolicy,
    private readonly clock: Clock = systemClock,
  ) {}

  async *run(input: ChatInput): AsyncIterable<ChatEvent> {
    const candidates = this.router.resolve(input.task, input.policy, 
      input.pinnedModelId !== undefined ? { pinnedModelId: input.pinnedModelId } : {});

    if (candidates.length === 0) {
      yield { type: 'error', kind: 'unavailable', message: '利用可能なモデルがありません' };
      return;
    }

    let previous: ModelId | undefined;
    let lastError: ProviderError | undefined;

    for (const modelId of candidates) {
      const descriptor = this.router.descriptor(modelId);
      if (!descriptor) continue;
      const provider = this.registry.get(descriptor.providerId);

      if (previous !== undefined) {
        yield {
          type: 'fallback',
          from: previous,
          to: modelId,
          reason: lastError?.kind ?? 'unknown',
        };
      }
      yield { type: 'modelSelected', modelId };

      for (let attempt = 0; ; attempt++) {
        const startedAt = this.clock.now();
        let emitted = false;
        try {
          const signal = input.signal ?? new AbortController().signal;
          const stream = provider.chat(
            {
              modelId,
              ...(input.system !== undefined ? { system: input.system } : {}),
              messages: input.messages,
              params: input.params ?? {},
            },
            signal,
          );

          for await (const chunk of stream) {
            emitted = true;
            const ev = this.#toEvent(chunk, modelId, startedAt, previous);
            if (ev) yield ev;
          }
          return;
        } catch (e) {
          const pe = isProviderError(e)
            ? e
            : new ProviderError({
                kind: 'unavailable',
                providerId: provider.id,
                message: e instanceof Error ? e.message : String(e),
                cause: e,
              });
          lastError = pe;

          if (pe.kind === 'canceled') {
            yield { type: 'error', kind: pe.kind, message: pe.message };
            return;
          }

          // 部分出力を返した後の再試行は重複出力になるため行わない。
          if (!emitted && this.fallback.shouldRetry(pe, attempt)) {
            await sleep(this.fallback.nextDelayMs(attempt, pe), input.signal);
            continue;
          }

          this.registry.cooldown(provider.id, this.fallback.cooldownMsFor(pe));

          if (!this.fallback.shouldFallback(pe)) {
            yield { type: 'error', kind: pe.kind, message: pe.message };
            return;
          }
          previous = modelId;
          break;
        }
      }
    }

    yield {
      type: 'error',
      kind: lastError?.kind ?? 'unavailable',
      message: lastError?.message ?? '全ての候補モデルが失敗しました',
    };
  }

  #toEvent(
    chunk: ProviderChunk,
    modelId: ModelId,
    startedAt: number,
    fallbackFrom: ModelId | undefined,
  ): ChatEvent | null {
    switch (chunk.type) {
      case 'text':
        return { type: 'text', delta: chunk.delta };
      case 'toolCall':
        return { type: 'toolCall', id: chunk.id, name: chunk.name, args: chunk.args };
      case 'usage':
        return { type: 'usage', inputTokens: chunk.inputTokens, outputTokens: chunk.outputTokens };
      case 'done':
        return {
          type: 'done',
          modelId,
          finishReason: chunk.finishReason,
          latencyMs: this.clock.now() - startedAt,
          ...(fallbackFrom !== undefined ? { fallbackFrom } : {}),
        };
      default:
        return null;
    }
  }
}
