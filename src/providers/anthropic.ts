/**
 * Claude アダプタ。公式SDK (@anthropic-ai/sdk) を使う。
 *
 * SDK依存はこのファイルの内側だけに閉じ込める。
 * Application層は contract.ts の型しか知らないので、
 * SDKが壊れてもここを差し替えれば済む。
 *
 * **SDK は使うときまで読み込まない。**
 * クラウドは既定で無効なのに、その依存が無いだけで全体が起動しないのでは、
 * 「口だけ用意しておく」ことにならない。
 * 導入していない環境でも、ローカルだけで最後まで動くようにする。
 */
import type Anthropic from '@anthropic-ai/sdk';
import type {
  ChatProvider, HealthStatus, ModelDescriptor,
  ProviderChunk, ProviderRequest,
} from './contract.ts';
import { ProviderError, type ProviderErrorKind } from './errors.ts';

type Sdk = typeof import('@anthropic-ai/sdk')['default'];

let sdk: Sdk | undefined;

/**
 * SDK を読み込む。入っていなければ、そう言って断る。
 * 断り方が「モジュールが見つかりません」では、何をすればいいか分からない。
 */
async function loadSdk(providerId: string): Promise<Sdk> {
  if (sdk) return sdk;
  try {
    sdk = (await import('@anthropic-ai/sdk')).default;
    return sdk;
  } catch (e) {
    throw new ProviderError({
      kind: 'unavailable',
      providerId,
      cause: e,
      message: 'Claude を使うには @anthropic-ai/sdk が要ります。`npm install` を実行してください。'
        + '（ローカルだけで使うなら、設定で claude を無効のままにしておけば不要です）',
    });
  }
}

export interface AnthropicProviderOptions {
  id?: string;
  apiKey?: string;
  /** APIが一覧を返さない場合に使う既定モデル */
  fallbackModels?: string[];
}

export class AnthropicProvider implements ChatProvider {
  readonly id: string;
  readonly locality = 'cloud' as const;
  readonly #fallbackModels: string[];
  readonly #apiKey?: string;
  #client?: Anthropic;

  constructor(opts: AnthropicProviderOptions = {}) {
    this.id = opts.id ?? 'anthropic';
    this.#fallbackModels = opts.fallbackModels ?? ['claude-opus-5'];
    this.#apiKey = opts.apiKey;
  }

  /** 実際に使うときに初めて用意する。登録しただけでは何も読み込まない。 */
  async #api(): Promise<Anthropic> {
    if (this.#client) return this.#client;
    const Sdk = await loadSdk(this.id);
    // リトライはOrchestratorのフォールバック規則が一元管理するので、
    // SDK側の自動リトライは切る。二重に待たされるのを防ぐ。
    this.#client = new Sdk({
      ...(this.#apiKey ? { apiKey: this.#apiKey } : {}),
      maxRetries: 0,
    });
    return this.#client;
  }

  async health(): Promise<HealthStatus> {
    try {
      await (await this.#api()).models.list({ limit: 1 });
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: describeForHealth(e) };
    }
  }

  async listModels(): Promise<ModelDescriptor[]> {
    const toDescriptor = (model: string, displayName = model): ModelDescriptor => ({
      id: `${this.id}:${model}`,
      providerId: this.id,
      model,
      displayName,
      locality: 'cloud',
    });

    try {
      const page = await (await this.#api()).models.list({ limit: 100 });
      const models = page.data.map((m) => toDescriptor(m.id, m.display_name ?? m.id));
      return models.length > 0 ? models : this.#fallbackModels.map((m) => toDescriptor(m));
    } catch {
      // 一覧が取れなくてもチャットは可能。設定値で続行する。
      return this.#fallbackModels.map((m) => toDescriptor(m));
    }
  }

  async *chat(req: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderChunk> {
    // Claudeは system をトップレベルで受け取る(messagesに混ぜない)
    const messages = req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    const systemFromMessages = req.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content);
    const system = [req.system, ...systemFromMessages].filter(Boolean).join('\n\n');

    let finishReason: 'stop' | 'length' | 'unknown' = 'unknown';

    try {
      const stream = (await this.#api()).messages.stream(
        {
          model: req.model,
          max_tokens: req.maxTokens ?? 16_000,
          ...(system ? { system } : {}),
          messages,
          // thinking は指定しない。Claude Opus 5 は既定で適応的思考が有効。
          // 明示指定は SDK のバージョンによって型が変わるため、ここでは触らない。
        },
        { signal },
      );

      for await (const ev of stream) {
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
          yield { type: 'text', delta: ev.delta.text };
        } else if (ev.type === 'message_delta') {
          if (ev.delta.stop_reason === 'end_turn') finishReason = 'stop';
          else if (ev.delta.stop_reason === 'max_tokens') finishReason = 'length';
          if (ev.usage) {
            yield {
              type: 'usage',
              inputTokens: ev.usage.input_tokens ?? 0,
              outputTokens: ev.usage.output_tokens ?? 0,
            };
          }
        }
      }
    } catch (e) {
      throw this.#normalize(e, signal);
    }

    yield { type: 'done', finishReason: signal.aborted ? 'canceled' : finishReason };
  }

  /** SDKの型付き例外を、フォールバック判断に使える正規化エラーへ変換する。 */
  #normalize(e: unknown, signal: AbortSignal): ProviderError {
    if (signal.aborted) {
      return new ProviderError({
        kind: 'canceled', providerId: this.id, cause: e,
        message: '中断されました。',
      });
    }

    let kind: ProviderErrorKind = 'unavailable';
    let retryAfterMs: number | undefined;

    // SDK を読めていないなら、型付きの判定はできない。無理に決めつけない。
    if (!sdk) {
      return new ProviderError({
        kind: e instanceof ProviderError ? e.kind : 'unavailable',
        providerId: this.id, cause: e,
        message: `${this.id}: ${e instanceof Error ? e.message : String(e)}`,
      });
    }

    if (e instanceof sdk.RateLimitError) {
      const body = JSON.stringify(e.error ?? e.message);
      kind = /quota|credit|billing|insufficient/i.test(body) ? 'quota_exhausted' : 'rate_limited';
      const header = e.headers?.get?.('retry-after');
      const seconds = Number(header);
      if (Number.isFinite(seconds)) retryAfterMs = seconds * 1000;
    } else if (e instanceof sdk.AuthenticationError || e instanceof sdk.PermissionDeniedError) {
      kind = 'auth';
    } else if (e instanceof sdk.BadRequestError) {
      kind = /context|too long|maximum.*token|token.*limit|prompt is too long/i.test(e.message)
        ? 'context_too_long'
        : 'invalid_request';
    } else if (e instanceof sdk.NotFoundError) {
      kind = 'invalid_request';
    } else if (e instanceof sdk.InternalServerError) {
      kind = 'unavailable';
    } else if (e instanceof sdk.APIConnectionTimeoutError) {
      kind = 'timeout';
    } else if (e instanceof sdk.APIConnectionError) {
      kind = 'unavailable';
    }

    return new ProviderError({
      kind, providerId: this.id, retryAfterMs, cause: e,
      message: `${this.id}: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

function describeForHealth(e: unknown): string {
  if (sdk) {
    if (e instanceof sdk.AuthenticationError) return 'APIキーが無効か未設定です';
    if (e instanceof sdk.RateLimitError) return '利用制限中';
  }
  return e instanceof Error ? e.message : String(e);
}
