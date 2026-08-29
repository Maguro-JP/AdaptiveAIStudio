/**
 * 設定。モデル名・URL・APIキーはすべてここに集約し、コードには一切書かない。
 * 探索順: 環境変数 AAS_CONFIG > ./aas.config.json > 既定値(Ollama)
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface ProviderConfig {
  id: string;
  kind: 'openai-compatible';
  baseUrl: string;
  locality: 'local' | 'cloud';
  /** 環境変数名。値そのものは書かない。 */
  apiKeyEnv?: string;
  models?: string[];
}

export interface AasConfig {
  providers: ProviderConfig[];
  /** 先頭から順に試す。前が使えなければ次へフォールバックする。 */
  candidates: string[];
  system?: string;
  temperature?: number;
  maxTokens?: number;
}

export const DEFAULT_CONFIG: AasConfig = {
  providers: [
    {
      id: 'ollama',
      kind: 'openai-compatible',
      baseUrl: 'http://localhost:11434/v1',
      locality: 'local',
      models: ['qwen2.5-coder:7b'],
    },
  ],
  candidates: ['ollama:qwen2.5-coder:7b'],
  system: 'あなたは日本語で応答する開発支援アシスタントです。簡潔に、根拠とともに答えてください。',
  temperature: 0.2,
  maxTokens: 4096,
};

export function loadConfig(cwd = process.cwd()): { config: AasConfig; source: string } {
  const path = process.env.AAS_CONFIG ?? resolve(cwd, 'aas.config.json');
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { config: DEFAULT_CONFIG, source: '既定値 (aas.config.json なし)' };
  }

  const parsed = JSON.parse(raw) as Partial<AasConfig>;
  const config: AasConfig = {
    providers: parsed.providers ?? DEFAULT_CONFIG.providers,
    candidates: parsed.candidates ?? DEFAULT_CONFIG.candidates,
    system: parsed.system ?? DEFAULT_CONFIG.system,
    temperature: parsed.temperature ?? DEFAULT_CONFIG.temperature,
    maxTokens: parsed.maxTokens ?? DEFAULT_CONFIG.maxTokens,
  };
  validate(config);
  return { config, source: path };
}

function validate(c: AasConfig): void {
  if (c.providers.length === 0) throw new Error('providers が空です。');
  if (c.candidates.length === 0) throw new Error('candidates が空です。');
  for (const p of c.providers) {
    if (p.kind !== 'openai-compatible') {
      throw new Error(`未対応の provider kind です: ${p.kind} (${p.id})`);
    }
    if (!p.baseUrl) throw new Error(`baseUrl が未設定です: ${p.id}`);
  }
  const ids = new Set(c.providers.map((p) => p.id));
  for (const cand of c.candidates) {
    const providerId = cand.slice(0, cand.indexOf(':'));
    if (!ids.has(providerId)) {
      throw new Error(`candidates の "${cand}" に対応する provider "${providerId}" が定義されていません。`);
    }
  }
}
