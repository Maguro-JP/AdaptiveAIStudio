/**
 * OpenAI互換アダプタ。
 *
 * baseUrl を差し替えるだけで Ollama / LM Studio / vLLM / llama.cpp-server、
 * および将来のOpenAI互換サービスへ接続できる。
 * 「特定サービスの終了に依存しない」ことの実体的な担保がこれ。
 */
import type {
  ChatProvider, HealthStatus, ModelDescriptor,
  ProviderChunk, ProviderMessage, ProviderRequest, ToolCall,
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
  /**
   * 接続〜最初の1トークンまでの上限。既定10分。
   * 巨大モデルのロードやディスクからの読み出しに数分かかることがあるため長い。
   */
  firstTokenTimeoutMs?: number;
  /**
   * トークンが1つも来ない状態が続いたときの上限。既定2分。
   *
   * 総時間ではなく「停滞時間」で打ち切るのが要点。
   * 1トークン/秒でも生成が進んでいる限り、何時間でも待つ。
   */
  stallTimeoutMs?: number;
}

export class OpenAiCompatibleProvider implements ChatProvider {
  readonly id: string;
  readonly locality: 'local' | 'cloud';
  readonly #baseUrl: string;
  readonly #apiKey?: string;
  readonly #fallbackModels: string[];
  readonly #firstTokenTimeoutMs: number;
  readonly #stallTimeoutMs: number;

  constructor(opts: OpenAiCompatibleOptions) {
    this.id = opts.id;
    this.locality = opts.locality;
    this.#baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.#apiKey = opts.apiKey;
    this.#fallbackModels = opts.fallbackModels ?? [];
    this.#firstTokenTimeoutMs = opts.firstTokenTimeoutMs ?? 600_000;
    this.#stallTimeoutMs = opts.stallTimeoutMs ?? 120_000;
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
    const wire = req.messages.map(toWireMessage);
    const messages = req.system
      ? [{ role: 'system', content: req.system }, ...wire]
      : wire;

    // 総時間ではなく「停滞」で打ち切る。低速環境でも生成が進む限り待ち続ける。
    const watchdog = new AbortController();
    let stalled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => { stalled = true; watchdog.abort(); }, ms);
    };
    arm(this.#firstTokenTimeoutMs);

    const combined = AbortSignal.any([signal, watchdog.signal]);

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
          ...(req.tools && req.tools.length > 0
            ? {
                tools: req.tools.map((t) => ({
                  type: 'function',
                  function: { name: t.name, description: t.description, parameters: t.parameters },
                })),
                tool_choice: 'auto',
              }
            : {}),
        }),
      });
    } catch (e) {
      clearTimeout(timer);
      // 中断が「利用者の Ctrl-C」か「停滞による打ち切り」かを区別する
      const kind = signal.aborted ? 'canceled' : stalled ? 'timeout' : kindFromThrown(e);
      throw new ProviderError({
        kind, providerId: this.id, cause: e,
        message: `${this.id} への接続に失敗しました: ${describe(e)}`,
      });
    }

    if (!res.ok || !res.body) {
      clearTimeout(timer);
      const body = await res.text().catch(() => '');
      throw new ProviderError({
        kind: kindFromHttpStatus(res.status, body),
        providerId: this.id,
        retryAfterMs: parseRetryAfter(res.headers.get('retry-after')),
        message: `${this.id} が HTTP ${res.status} を返しました: ${truncate(body)}`,
      });
    }

    let finishReason: 'stop' | 'length' | 'toolCalls' | 'unknown' = 'unknown';
    // ツール呼び出しは複数チャンクに分割して届く。index ごとに組み立てる。
    const pending = new Map<number, { id: string; name: string; args: string }>();
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
          arm(this.#stallTimeoutMs); // 生成が進んでいるので待ち直す
          yield { type: 'text', delta };
        }
        for (const tc of choice?.delta?.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          const slot = pending.get(idx) ?? { id: '', name: '', args: '' };
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name += tc.function.name;
          if (tc.function?.arguments) slot.args += tc.function.arguments;
          pending.set(idx, slot);
          arm(this.#stallTimeoutMs);
        }

        if (choice?.finish_reason === 'stop') finishReason = 'stop';
        else if (choice?.finish_reason === 'length') finishReason = 'length';
        else if (choice?.finish_reason === 'tool_calls') finishReason = 'toolCalls';

        if (parsed.usage) {
          yield {
            type: 'usage',
            inputTokens: parsed.usage.prompt_tokens ?? 0,
            outputTokens: parsed.usage.completion_tokens ?? 0,
          };
        }
      }
    } catch (e) {
      const kind = signal.aborted ? 'canceled' : stalled ? 'timeout' : kindFromThrown(e);
      throw new ProviderError({
        kind, providerId: this.id, cause: e,
        message: stalled
          ? `${this.id} が ${this.#stallTimeoutMs / 1000}秒 応答しませんでした（停滞）`
          : `${this.id} のストリームが中断されました: ${describe(e)}`,
      });
    } finally {
      clearTimeout(timer);
    }

    for (const [idx, slot] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
      yield {
        type: 'toolCall',
        call: {
          id: slot.id || `call_${idx}`,
          name: slot.name,
          args: parseArgs(slot.args),
        },
      };
      if (finishReason === 'unknown') finishReason = 'toolCalls';
    }

    yield { type: 'done', finishReason: signal.aborted ? 'canceled' : finishReason };
  }
}

/** 中立形式から OpenAI 形式へ。ツール結果の表現だけが違う。 */
function toWireMessage(m: ProviderMessage): Record<string, unknown> {
  if (m.role === 'tool') {
    return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
  }
  if (m.toolCalls && m.toolCalls.length > 0) {
    return {
      role: m.role,
      content: m.content || null,
      tool_calls: m.toolCalls.map((t: ToolCall) => ({
        id: t.id,
        type: 'function',
        function: { name: t.name, arguments: JSON.stringify(t.args) },
      })),
    };
  }
  return { role: m.role, content: m.content };
}

/**
 * 引数のJSONが壊れていても落とさない。
 * ローカルの小型モデルは不正なJSONを出すことがあるため、
 * ここでは生文字列を残し、実行側で検証・エラー返却させる。
 */
function parseArgs(raw: string): unknown {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { __raw: raw, __parseError: true };
  }
}

interface OpenAiStreamChunk {
  choices?: Array<{
    delta?: {
      content?: unknown;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
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
