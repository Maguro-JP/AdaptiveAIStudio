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
  /**
   * 依頼を回す側が足した押し戻し（「続きを書いて」「次の一手を」）。人の依頼ではない。
   * コンテキストウィンドウに収めるとき、今の依頼と見なさない（押し戻しを守って、本物の依頼を落とさない）。送る形には載せない。
   */
  nudge?: boolean;
  /**
   * 利用者が添えた画像（role === 'user' のとき）。画像を読めるモデルへの送り口だけが載せる。読めない送り口は見ない
   * （本文には、画像を添えたことと保存先が文で入っている）。
   */
  images?: ProviderImage[];
}

/** 送る画像。`data` は base64（`data:` の頭は付けない）。 */
export interface ProviderImage {
  mime: string;
  data: string;
}

/** ツールの定義。JSON Schema はモデル側へそのまま渡す。 */
export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * 依頼の優先度。**数が小さいほど先に口を借りる。**
 *
 * 表に出すときは利用者の言葉を使う（`PRIORITY_LABEL`。まだ出している場所は無い）。中は数だけで持つ
 * （語形が変わらない合図。HTTP でも `x-aas-priority: 0` のように数で送る）。
 *
 * - 最優先・優先: 取り分を持つ。空いた口は上から順にこちらへ回る
 * - 高・中・低: 取り分 0。**上に待ち手が居ないときだけ**口を借りる。
 *   口が 2 本以上あるときは、半分（切り上げ）を上のために空けておく
 *   （inproc の `LanePool`。本数で決まり、設定ではない）
 */
export const Priority = { top: 0, preferred: 1, high: 2, normal: 3, low: 4 } as const;
export type Priority = (typeof Priority)[keyof typeof Priority];
/** 表に出すときの名前。利用者の言葉をそのまま使う（訳語を作らない）。まだ出している場所は無い。 */
export const PRIORITY_LABEL: Record<Priority, string> = { 0: '最優先', 1: '優先', 2: '高', 3: '中', 4: '低' };
/** 何も言われなければ「中」。上に待ち手が居れば待つ側。 */
export const DEFAULT_PRIORITY: Priority = Priority.normal;
/**
 * 優先度を運ぶ HTTP ヘッダ。本文に足す道を選ばなかったのは、知らない項目を
 * 断る OpenAI 互換の相手が居るため。知らないヘッダは読み飛ばされるはずだが、
 * **確かめたのは inproc だけ**（Ollama / llama-server / 雲の中継では試していない）。
 */
export const PRIORITY_HEADER = 'x-aas-priority';
/** ヘッダから読む。無い・読めない・範囲外は既定（中）。 */
export function toPriority(value: unknown): Priority {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw === null) return DEFAULT_PRIORITY;
  const text = String(raw).trim();
  // 受けるのは 0〜4 の一文字だけ。`Number('')` は 0（最優先）、`Number('0x1')` は 1 に
  // なるので、数に直す前に形で見る。
  if (!/^[0-4]$/.test(text)) return DEFAULT_PRIORITY;
  return Number(text) as Priority;
}

export interface ProviderRequest {
  model: string; // Provider内部でのモデル名(ModelIdからprefixを除いたもの)
  system?: string;
  messages: ProviderMessage[];
  temperature?: number;
  maxTokens?: number;
  tools?: ToolSchema[];
  /** 優先度。無ければ既定（中）。inproc の口の貸し出し順に効く。外の相手（雲）は見ない。 */
  priority?: Priority;
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
  /**
   * 相手に「在る」と言われたものか。
   *
   * 一覧が取れないとき、設定に書いてある名前で進む道がある（`/v1/models` を
   * 持たない相手が居るため）。そのとき **`false`**。
   *
   * ここを持たせないと、**書いてあるだけの名前が「入っている」ことになる。**
   * 実際に、既定の設定にあった Ollama 向けの2つが画面に候補として並び、
   * 送るたびに存在しない相手を叩いていた。
   */
  verified?: boolean;
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
