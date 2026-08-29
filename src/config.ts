/**
 * 設定。モデル名・URL・APIキーはすべてここに集約し、コードには一切書かない。
 * 探索順: 環境変数 AAS_CONFIG > ./aas.config.json > 既定値(Ollama)
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface ProviderConfig {
  id: string;
  kind: 'openai-compatible' | 'anthropic';
  /** openai-compatible のみ必須 */
  baseUrl?: string;
  locality: 'local' | 'cloud';
  /** 環境変数名。値そのものは書かない。 */
  apiKeyEnv?: string;
  models?: string[];
  /**
   * 既定は false。ローカルが主で、クラウドは「口だけ用意しておく」もの。
   * 明示的に true にしない限り、登録も接続もしない。
   */
  enabled?: boolean;
}

export interface AasConfig {
  providers: ProviderConfig[];
  /**
   * 使用モデルを固定したい場合のみ指定する。
   * 省略すると自動操縦が、入っているモデルから最良を選び、
   * 実測に応じて裏で乗り換える。既定はこちら。
   *
   * 明示指定は検証・比較目的のための機能であり、通常運用では不要。
   */
  candidates?: string[];
  system?: string;
  temperature?: number;
  maxTokens?: number;
  agent?: AgentConfig;
  runtime?: RuntimeConfig;
}

export interface RuntimeConfig {
  /**
   * ローカル推論の実行基盤。
   *   ollama   : 安定。日常運用（既定）
   *   llamacpp : 自前。オフロード層数を自分で決める。限界を攻める用途
   * 両方を並存させ、片方が壊ってももう片方で動くようにする。
   */
  kind?: 'ollama' | 'llamacpp';
  /** llamacpp: llama-server の実行パス */
  command?: string;
  /** llamacpp: command の直後に付ける固定引数（ラッパースクリプト経由の起動用） */
  commandArgs?: string[];
  /** llamacpp: GGUFファイルを置くディレクトリ */
  modelsDir?: string;
  /** llamacpp: 使用ポートの開始番号 */
  basePort?: number;
  /** llamacpp: レーンの並列度に合わせる */
  parallel?: number;
  desiredContext?: number;
  /**
   * 常時ロード。使う見込みのモデルを起動時に温めておき、
   * 作業開始時の待ちをゼロにする。既定は有効。
   * 空いているVRAMは節約ではなく損失なので、既定で使い切る。
   */
  warm?: WarmConfig;
}

export interface WarmConfig {
  enabled?: boolean;
  /** 起動時に温めるモデル。省略時は自動選択の上位を温める。 */
  preload?: string[];
  /** 同時常駐数の上限 */
  maxResident?: number;
  /** 常駐に使ってよいVRAM比率(0〜1)。既定 0.95 */
  vramFraction?: number;
}

export interface AgentConfig {
  /** 作業ディレクトリ。ここより外へは触らせない。既定はカレント。 */
  root?: string;
  /**
   * 承認の求め方。
   *   ask      : 毎回聞く
   *   autoEdit : ファイル書き込みは自動承認、コマンド実行のみ聞く（既定）
   *   auto     : 全部自動（長時間の自律実行向け。gitでの巻き戻し前提）
   *
   * 自律実行が本題なので既定は autoEdit。
   * 安全網は git であり、開始前に未コミット変更を警告する。
   */
  approval?: 'ask' | 'autoEdit' | 'auto';
  /** run_command で許可するコマンドの先頭語 */
  allowedCommands?: string[];
  maxTurns?: number;
  /**
   * レーン。同時にロードしておくモデルの単位。
   * 並列度は「同時ロード数」ではなく「レーン内の同時タスク数」で稼ぐ。
   */
  lanes?: LaneSetting[];
  /** 全レーン合計の同時実行上限。CPU/メモリの保護用。 */
  maxTotalParallel?: number;
}

export interface LaneSetting {
  id: string;
  candidates: string[];
  parallel: number;
}

export const DEFAULT_CONFIG: AasConfig = {
  providers: [
    {
      id: 'ollama',
      kind: 'openai-compatible',
      baseUrl: 'http://localhost:11434/v1',
      locality: 'local',
      // ローカルには単価が無いので、節約のために弱いモデルを既定にしない。
      // MoE は 30B級の質を 7B 並みの速度で出せるため、この環境の最適解。
      models: ['qwen3:30b-a3b', 'qwen2.5-coder:7b'],
      enabled: true,
    },
    // クラウドは既定で無効。使いたいときだけ enabled を true にする。
    {
      id: 'claude',
      kind: 'anthropic',
      locality: 'cloud',
      apiKeyEnv: 'ANTHROPIC_API_KEY',
      models: ['claude-opus-5'],
      enabled: false,
    },
  ],
  // candidates は既定で未指定。自動操縦に任せる。
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
    ...(parsed.candidates ? { candidates: parsed.candidates } : {}),
    system: parsed.system ?? DEFAULT_CONFIG.system,
    temperature: parsed.temperature ?? DEFAULT_CONFIG.temperature,
    maxTokens: parsed.maxTokens ?? DEFAULT_CONFIG.maxTokens,
    agent: parsed.agent ?? {},
    runtime: parsed.runtime ?? {},
  };
  if (config.agent?.lanes) validateLanes(config);
  validate(config);
  return { config, source: path };
}

function validate(c: AasConfig): void {
  if (c.providers.length === 0) throw new Error('providers が空です。');
  if (c.candidates && c.candidates.length === 0) {
    throw new Error('candidates を空配列にはできません。自動選択に任せるなら項目ごと省いてください。');
  }
  for (const p of c.providers) {
    if (p.kind === 'openai-compatible') {
      if (!p.baseUrl) throw new Error(`baseUrl が未設定です: ${p.id}`);
    } else if (p.kind !== 'anthropic') {
      throw new Error(`未対応の provider kind です: ${p.kind} (${p.id})`);
    }
  }
  const ids = new Set(enabledProviders(c).map((p) => p.id));
  for (const cand of c.candidates ?? []) {
    const providerId = cand.slice(0, cand.indexOf(':'));
    if (!ids.has(providerId)) {
      throw new Error(
        `candidates の "${cand}" に対応する provider "${providerId}" が有効になっていません。` +
        ' 設定で enabled: true にしてください。',
      );
    }
  }
}

function validateLanes(c: AasConfig): void {
  const ids = new Set(enabledProviders(c).map((p) => p.id));
  for (const lane of c.agent?.lanes ?? []) {
    if (lane.parallel < 1) throw new Error(`lane "${lane.id}" の parallel は1以上にしてください。`);
    if (lane.candidates.length === 0) throw new Error(`lane "${lane.id}" に candidates がありません。`);
    for (const cand of lane.candidates) {
      const providerId = cand.slice(0, cand.indexOf(':'));
      if (!ids.has(providerId)) {
        throw new Error(`lane "${lane.id}" の "${cand}" に対応する provider が有効ではありません。`);
      }
    }
  }
}

/** 有効なProviderだけを返す。enabled を省略した場合は有効とみなす。 */
export function enabledProviders(c: AasConfig): ProviderConfig[] {
  return c.providers.filter((p) => p.enabled !== false);
}
