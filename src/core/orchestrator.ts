/**
 * 候補モデルを順に試し、正規化エラーの種別に従って
 * リトライ・フォールバック・冷却を行う。
 *
 * 設計上の要点:
 *   - フォールバックは「まだ1文字も出力していない場合」に限る。
 *     出力途中で別モデルに切り替えると、文章が二重・不整合になるため。
 *   - どのモデルが答えたかは必ず呼び出し側へ通知する(暗黙の劣化を防ぐ)。
 */
import type { ModelId, ProviderMessage, ToolCall, ToolSchema } from '../providers/contract.ts';
import { ProviderError } from '../providers/errors.ts';
import type { ProviderRegistry } from './registry.ts';

export type ChatEvent =
  | { type: 'attempt'; modelId: ModelId; attempt: number }
  | { type: 'fallback'; from: ModelId; to: ModelId; reason: string }
  | { type: 'text'; delta: string }
  | { type: 'toolCall'; call: ToolCall }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'done'; modelId: ModelId; fallbackFrom?: ModelId }
  | { type: 'failed'; error: ProviderError };

export interface ChatInput {
  candidates: ModelId[];
  system?: string;
  messages: ProviderMessage[];
  temperature?: number;
  maxTokens?: number;
  tools?: ToolSchema[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ChatOrchestrator {
  readonly #registry: ProviderRegistry;

  constructor(registry: ProviderRegistry) {
    this.#registry = registry;
  }

  async *run(input: ChatInput, signal: AbortSignal): AsyncGenerator<ChatEvent> {
    const usable = input.candidates.filter((id) => {
      const r = this.#registry.resolve(id);
      return r !== undefined && this.#registry.isAvailable(r.provider.id);
    });

    if (usable.length === 0) {
      yield {
        type: 'failed',
        error: new ProviderError({
          kind: 'unavailable',
          providerId: '-',
          message: '利用できるモデルがありません(全Providerが未登録または冷却中)。',
        }),
      };
      return;
    }

    let lastError: ProviderError | undefined;
    let previousModelId: ModelId | undefined;

    for (const modelId of usable) {
      const resolved = this.#registry.resolve(modelId)!;
      const { provider, model } = resolved;

      if (previousModelId && lastError) {
        yield {
          type: 'fallback',
          from: previousModelId,
          to: modelId,
          reason: `${lastError.kind}: ${lastError.message}`,
        };
      }

      let attempt = 0;
      // 同一モデル内のリトライ。retries は kind ごとの規則から決まる。
      for (;;) {
        if (signal.aborted) return;
        yield { type: 'attempt', modelId, attempt };

        let emitted = false;
        try {
          for await (const chunk of provider.chat(
            { model, system: input.system, messages: input.messages,
              temperature: input.temperature, maxTokens: input.maxTokens,
              tools: input.tools },
            signal,
          )) {
            if (chunk.type === 'text') {
              emitted = true;
              yield { type: 'text', delta: chunk.delta };
            } else if (chunk.type === 'toolCall') {
              // ツール呼び出しも「出力済み」とみなす。
              // ここで別モデルに切り替えると、呼び出しが二重に実行される。
              emitted = true;
              yield { type: 'toolCall', call: chunk.call };
            } else if (chunk.type === 'usage') {
              yield { type: 'usage', inputTokens: chunk.inputTokens, outputTokens: chunk.outputTokens };
            }
          }
          this.#registry.clearCooldown(provider.id);
          yield { type: 'done', modelId, fallbackFrom: previousModelId };
          return;
        } catch (e) {
          const err = e instanceof ProviderError
            ? e
            : new ProviderError({
                kind: 'unavailable', providerId: provider.id, cause: e,
                message: e instanceof Error ? e.message : String(e),
              });

          if (err.kind === 'canceled') return;

          /*
           * **地元の口は冷やさない。**
           *
           * 冷却は、外の口（雲）の割当てを守り、その間に別の口へ逃がすためのもの。
           * この機械の中の口（inproc の子プロセス、Ollama）では意味が違う。
           * 落ちた原因は子が消えたことで、それは**次の送信で読み直す**と直る。
           * ここで 5 分冷やすと、読み直せているのに「利用できるモデルがありません」で
           * 0.0 秒で終わり続ける（子を殺して確かめた）。逃がす先も、たいてい無い。
           */
          if (provider.locality !== 'local') this.#registry.cooldown(provider.id, err.rule.cooldownMs);
          lastError = err;

          // 出力開始後の切替は文章を壊すので、ここで打ち切る。
          if (emitted) {
            yield { type: 'failed', error: err };
            return;
          }
          if (!err.rule.fallback && attempt >= err.rule.retries) {
            yield { type: 'failed', error: err };
            return;
          }
          if (attempt < err.rule.retries) {
            const wait = err.retryAfterMs ?? 500 * 2 ** attempt;
            attempt += 1;
            await sleep(wait);
            continue;
          }
          break; // 次の候補モデルへ
        }
      }
      previousModelId = modelId;
    }

    yield {
      type: 'failed',
      error: lastError ?? new ProviderError({
        kind: 'unavailable', providerId: '-',
        message: 'すべての候補モデルが失敗しました。',
      }),
    };
  }
}
