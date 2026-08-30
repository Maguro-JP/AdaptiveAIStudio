import type { ModelDescriptor, ModelId, ProviderId, Locality } from '@aas/core';

export type ProviderRole = 'user' | 'assistant' | 'tool';

export interface ProviderMessage {
  role: ProviderRole;
  /** 正規化済みの中立形式。モデル差は ContextBuilder が吸収する。 */
  content: string;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ProviderRequest {
  modelId: ModelId;
  system?: string;
  messages: ProviderMessage[];
  tools?: ToolSchema[];
  params: { temperature?: number; maxTokens?: number; topP?: number };
}

export type FinishReason = 'stop' | 'length' | 'tool_use' | 'canceled' | 'content_filter';

export type ProviderChunk =
  | { type: 'text'; delta: string }
  | { type: 'toolCall'; id: string; name: string; args: unknown }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'done'; finishReason: FinishReason };

export interface HealthStatus {
  reachable: boolean;
  /** クールダウン中なら解除時刻 (epoch ms)。 */
  cooldownUntil?: number;
  detail?: string;
}

export interface ChatProvider {
  readonly id: ProviderId;
  readonly locality: Locality;

  listModels(): Promise<ModelDescriptor[]>;
  health(): Promise<HealthStatus>;

  chat(req: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderChunk>;
}
