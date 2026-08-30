import type { Locality, ModelDescriptor, ModelId, ProviderId } from '@aas/core';
import type {
  ChatProvider,
  FinishReason,
  HealthStatus,
  ProviderChunk,
  ProviderRequest,
} from '@aas/provider-contract';
import { ProviderError } from '@aas/provider-contract';
import { fromResponse, fromThrown } from './normalizeError.js';
import { parseSse } from './sse.js';

export interface OpenAiCompatibleConfig {
  id: ProviderId;
  /** 例: http://localhost:11434/v1 (Ollama) / http://localhost:1234/v1 (LM Studio) */
  baseUrl: string;
  locality: Locality;
  apiKey?: string;
  /** 同梱カタログ。ここに無いモデルは /models の応答から最小構成で補う。 */
  models?: ModelDescriptor[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const FINISH: Record<string, FinishReason> = {
  stop: 'stop',
  length: 'length',
  tool_calls: 'tool_use',
  content_filter: 'content_filter',
};

/**
 * OpenAI互換HTTPを話す全てのサービスを1本で吸収するアダプタ。
 * 「サービス終了に依存しない」ことの実体的な担保はこのクラスにある。
 */
export class OpenAiCompatibleProvider implements ChatProvider {
  readonly id: ProviderId;
  readonly locality: Locality;
  readonly #cfg: OpenAiCompatibleConfig;
  readonly #fetch: typeof fetch;

  constructor(cfg: OpenAiCompatibleConfig) {
    this.id = cfg.id;
    this.locality = cfg.locality;
    this.#cfg = cfg;
    this.#fetch = cfg.fetchImpl ?? globalThis.fetch;
  }

  #headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      ...(this.#cfg.apiKey ? { authorization: `Bearer ${this.#cfg.apiKey}` } : {}),
    };
  }

  #url(path: string): string {
    return `${this.#cfg.baseUrl.replace(/\/$/, '')}${path}`;
  }

  async listModels(): Promise<ModelDescriptor[]> {
    if (this.#cfg.models?.length) return this.#cfg.models;
    try {
      const res = await this.#fetch(this.#url('/models'), { headers: this.#headers() });
      if (!res.ok) throw fromResponse(this.id, res, await res.text());
      const json = (await res.json()) as { data?: { id?: unknown }[] };
      return (json.data ?? [])
        .map((m) => (typeof m.id === 'string' ? m.id : null))
        .filter((id): id is string => id !== null)
        .map((id) => this.#minimalDescriptor(id));
    } catch (e) {
      throw fromThrown(this.id, e);
    }
  }

  #minimalDescriptor(rawId: string): ModelDescriptor {
    return {
      id: `${this.id}:${rawId}` satisfies ModelId,
      providerId: this.id,
      displayName: rawId,
      family: rawId.split(/[:\-/]/)[0] ?? rawId,
      capabilities: {
        streaming: true,
        toolUse: false,
        vision: false,
        jsonMode: false,
        systemPrompt: true,
      },
      limits: { contextWindow: 8192, maxOutputTokens: 2048 },
      locality: this.locality,
    };
  }

  async health(): Promise<HealthStatus> {
    try {
      const res = await this.#fetch(this.#url('/models'), { headers: this.#headers() });
      if (res.ok) return { reachable: true };
      return { reachable: false, detail: `HTTP ${res.status}` };
    } catch (e) {
      return { reachable: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }

  /** ModelId から Provider が理解する生のモデル名へ戻す。 */
  #rawModel(modelId: ModelId): string {
    return modelId.startsWith(`${this.id}:`) ? modelId.slice(this.id.length + 1) : modelId;
  }

  async *chat(req: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderChunk> {
    const messages = [
      ...(req.system ? [{ role: 'system', content: req.system }] : []),
      ...req.messages.map((m) => ({ role: m.role, content: m.content })),
    ];

    let res: Response;
    try {
      res = await this.#fetch(this.#url('/chat/completions'), {
        method: 'POST',
        headers: this.#headers(),
        signal,
        body: JSON.stringify({
          model: this.#rawModel(req.modelId),
          messages,
          stream: true,
          stream_options: { include_usage: true },
          ...(req.params.temperature !== undefined ? { temperature: req.params.temperature } : {}),
          ...(req.params.maxTokens !== undefined ? { max_tokens: req.params.maxTokens } : {}),
          ...(req.params.topP !== undefined ? { top_p: req.params.topP } : {}),
        }),
      });
    } catch (e) {
      throw fromThrown(this.id, e);
    }

    if (!res.ok) throw fromResponse(this.id, res, await res.text().catch(() => ''));
    if (!res.body) {
      throw new ProviderError({ kind: 'unavailable', providerId: this.id, message: 'empty body' });
    }

    let finishReason: FinishReason = 'stop';
    let sawUsage = false;
    let outputChars = 0;
    let inputChars = messages.reduce((n, m) => n + m.content.length, 0);

    try {
      for await (const data of parseSse(res.body)) {
        if (data === '[DONE]') break;
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue; // 壊れた行は落とす。ストリーム全体は止めない。
        }
        const ev = parsed as {
          choices?: { delta?: { content?: unknown }; finish_reason?: unknown }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
          error?: { message?: string };
        };

        if (ev.error) {
          throw new ProviderError({
            kind: 'unavailable',
            providerId: this.id,
            message: ev.error.message ?? 'stream error',
          });
        }

        const choice = ev.choices?.[0];
        const delta = choice?.delta?.content;
        if (typeof delta === 'string' && delta.length > 0) {
          outputChars += delta.length;
          yield { type: 'text', delta };
        }
        if (typeof choice?.finish_reason === 'string') {
          finishReason = FINISH[choice.finish_reason] ?? 'stop';
        }
        if (ev.usage) {
          sawUsage = true;
          yield {
            type: 'usage',
            inputTokens: ev.usage.prompt_tokens ?? 0,
            outputTokens: ev.usage.completion_tokens ?? 0,
          };
        }
      }
    } catch (e) {
      throw fromThrown(this.id, e);
    }

    if (!sawUsage) {
      // usage を返さないサーバでもコスト表示を成立させるための推定値 (4文字≒1トークン)。
      yield {
        type: 'usage',
        inputTokens: Math.ceil(inputChars / 4),
        outputTokens: Math.ceil(outputChars / 4),
      };
    }
    yield { type: 'done', finishReason };
  }
}
