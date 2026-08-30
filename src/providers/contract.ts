/**
 * Provider契約 — 本プロジェクトで最も重要な境界。
 *
 * Application層はこのファイルの型しか知らない。
 * SDK固有の型・HTTPステータス・モデル固有のパラメータは
 * すべて各アダプタの内側に閉じ込める。
 */

export type ProviderId = string;
/** "ollama:qwen2.5-coder:7b" / "anthropic:claude-sonnet-4-5" 形式 */
export type ModelId = string;

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  /** モデルが生成した引数。JSONとして妥当である保証はない。 */
  args: unknown;
}

export interface ProviderMessage {
  role: Role;
  content: string;
  /** assistant がツールを呼んだとき */
  toolCalls?: ToolCall[];
  /** role === 'tool' のとき、どの呼び出しへの結果か */
  toolCallId?: string;
}

/** ツールの定義。JSON Schema はモデル側へそのまま渡す。 */
export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ProviderRequest {
  model: string; // Provider内部でのモデル名(ModelIdからprefixを除いたもの)
  system?: string;
  messages: ProviderMessage[];
  temperature?: number;
  maxTokens?: number;
  tools?: ToolSchema[];
}

export type ProviderChunk =
  | { type: 'text'; delta: string }
  | { type: 'toolCall'; call: ToolCall }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'done'; finishReason: FinishReason };

export type FinishReason = 'stop' | 'length' | 'toolCalls' | 'canceled' | 'unknown';

export interface ModelDescriptor {
  id: ModelId;
  providerId: ProviderId;
  model: string;
  displayName: string;
  locality: 'local' | 'cloud';
  contextWindow?: number;
}

export type HealthStatus =
  | { ok: true }
  | { ok: false; reason: string };

export interface ChatProvider {
  readonly id: ProviderId;
  readonly locality: 'local' | 'cloud';

  /** 到達性の確認。失敗しても例外を投げず reason を返す。 */
  health(): Promise<HealthStatus>;

  /** Providerが今提供できるモデル一覧。取得できない場合は設定値を返す。 */
  listModels(): Promise<ModelDescriptor[]>;

  chat(req: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderChunk>;
}
