export type ModelId = string;     // "anthropic:claude-opus-5" / "local:qwen2.5-coder-7b"
export type ProviderId = string;  // "anthropic" / "ollama"

export type Locality = 'local' | 'cloud';

export interface ModelCapabilities {
  streaming: boolean;
  toolUse: boolean;
  vision: boolean;
  jsonMode: boolean;
  /** 単独 system メッセージを持てないモデルの吸収用。 */
  systemPrompt: boolean;
}

export interface ModelLimits {
  contextWindow: number;
  maxOutputTokens: number;
  /** ローカルモデル選定に必須 (VRAM 8GB 制約 / R2)。 */
  estimatedVramGb?: number;
}

export interface CostProfile {
  inputPerMTokUsd: number;
  outputPerMTokUsd: number;
}

export interface ModelDescriptor {
  id: ModelId;
  providerId: ProviderId;
  displayName: string;
  family: string;
  capabilities: ModelCapabilities;
  limits: ModelLimits;
  /** ローカルモデルは undefined。 */
  cost?: CostProfile;
  locality: Locality;
}
