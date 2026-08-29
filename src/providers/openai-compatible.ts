/**
 * OpenAI互換アダプタ。
 *
 * baseUrl を差し替えるだけで Ollama / LM Studio / vLLM / llama.cpp-server、
 * および将来のOpenAI互換サービスへ接続できる。
 * 「特定サービスの終了に依存しない」ことの実体的な担保がこれ。
 */
import type {
  ChatProvider, HealthStatus, ModelDescriptor,
  ProviderChunk, ProviderRequest,
} from './contract.ts';
import {
  ProviderError, kindFromHttpStatus, kindFromThrown, parseRetryAfter,
} from './errors.ts';
import { readSseLines } from './sse.ts';

export interface OpenAiCompatibleOptions {
  id: string;
  baseUrl: string;
  apiKey?: string;
  locality: 'local' | 'cloud';
  /** APIがモデル一覧を返さない場合のフォールバック */
  fallbackModels?: string[];
  requestTimeoutMs?: number;
}

export class OpenAiCompatibleProvider implements ChatProvider {
  readonly id: string;
  readonly locality: 'local' | 'cloud';
  readonly #baseUrl: string;
  readonly #apiKey?: string;
  readonly #fallbackModels: string[];
  readonly #timeoutMs: number;

  constructor(opts: OpenAiCompatibleOptions) {
    this.id = opts.id;
    this.locality = opts.locality;
    this.#baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.#apiKey = opts.apiKey;
    this.#fallbackModels = opts.fallbackModels ?? [];
    this.#timeoutMs = opts.requestTimeoutMs ?? 300_000;
  }

  #headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (this.#apiKey) h.authorization = `Bearer ${this.#apiKey}`;
    return h;
  }

  async health(): Promise<HealthStatus> {
    try {
      const res = await fetch(`${this.#baseUrl}/models`, {
        headers: this.#headers(),
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
      return { ok: true };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return { ok: false, reason };
    }
  }

  async listModels(): Promise<ModelDescriptor[]> {
    const toDescriptor = (model: string): ModelDescriptor => ({
      id: `${this.id}:${model}`,
      providerId: this.id,
      model,
      displayName: model,
      locality: this.locality,
    });

    try {
      const res = await fetch(`${this.#baseUrl}/models`, {
        headers: this.#headers(),
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return this.#fallbackModels.map(toDescriptor);
      const json = (await res.json()) as { data?: Array<{ id?: unknown }> };
      const ids = (json.data ?? [])
        .map((m) => m.id)
        .filter((v): v is string => typeof v === 'string');
      return (ids.length > 0 ? ids : this.#fallbackModels).map(toDescriptor);
    } catch {
      // 一覧が取れないことは致命的ではない。設定値で続行する。
      return this.#fallbackModels.map(toDescriptor);
    }
  }

  async *chat(req: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderChunk> {
    const messages = req.system
      ? [{ role: 'system', content: req.system }, ...req.messages]
      : req.messages;

    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);

    let res: Response;
    try {
      res = await fetch(`${this.#baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.#headers(),
        signal: combined,
        body: JSON.stringify({
          model: req.model,
          messages,
          stream: true,
          stream_options: { include_usage: true },
          temperature: req.temperature,
          max_tokens: req.maxTokens,
        }),
      });
    } catch (e) {
      // 中断が「利用者の Ctrl-C」か「タイムアウト」かを区別する
      const kind = signal.aborted ? 'canceled' : kindFromThrown(e);
      throw new ProviderError({
        kind, providerId: this.id, cause: e,
        message: `${this.id} への接続に失敗しました: ${describe(e)}`,
      });
    }

    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => '');
      throw new ProviderError({
        kind: kindFromHttpStatus(res.status, body),
        providerId: this.id,
        retryAfterMs: parseRetryAfter(res.headers.get('retry-after')),
        message: `${this.id} が HTTP ${res.status} を返しました: ${truncate(body)}`,
      });
    }

    let finishReason: 'stop' | 'length' | 'unknown' = 'unknown';
    try {
      for await (const data of readSseLines(res.body)) {
        if (data === '[DONE]') break;
        if (!data) continue;

        let parsed: OpenAiStreamChunk;
        try {
          parsed = JSON.parse(data) as OpenAiStreamChunk;
        } catch {
          continue; // 壊れた1行でストリーム全体を落とさない
        }

        const choice = parsed.choices?.[0];
        const delta = choice?.delta?.content;
        if (typeof delta === 'string' && delta.length > 0) {
          yield { type: 'text', delta };
        }
        if (choice?.finish_reason === 'stop') finishReason = 'stop';
        else if (choice?.finish_reason === 'length') finishReason = 'length';

        if (parsed.usage) {
          yield {
            type: 'usage',
            inputTokens: parsed.usage.prompt_tokens ?? 0,
            outputTokens: parsed.usage.completion_tokens ?? 0,
          };
        }
      }
    } catch (e) {
      const kind = signal.aborted ? 'canceled' : kindFromThrown(e);
      throw new ProviderError({
        kind, providerId: this.id, cause: e,
        message: `${this.id} のストリームが中断されました: ${describe(e)}`,
      });
    }

    yield { type: 'done', finishReason: signal.aborted ? 'canceled' : finishReason };
  }
}

interface OpenAiStreamChunk {
  choices?: Array<{
    delta?: { content?: unknown };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function truncate(s: string, max = 200): string {
  return s.length > max ? `${s.slice(0, max)}...` : s;
}
