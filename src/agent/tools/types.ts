import type { ToolSchema } from '../../providers/contract.ts';

export interface ToolContext {
  /** 作業ディレクトリ。ここより外へは一切アクセスさせない。 */
  root: string;
  signal: AbortSignal;
  /**
   * いまの窓（トークン）。返す長さを決めるのに使う。
   *
   * **無ければ切らない。**分からないことを理由に切ると、
   * 窓を知らない呼び出し（試験や道具の直接利用）で中身が消える。
   */
  contextTokens?: number;
  /**
   * トークンの数え方。**そのモデルの本物の数え方**が分かっていれば渡る。
   *
   * 無ければ見積もり（`estimateTokens`）に戻る。見積もりは日本語で
   * 外しやすく、外した分だけ切る位置がずれる。
   */
  count?: (text: string) => number;
  /** 書き込み・実行の承認を求める。false なら実行しない。 */
  approve(req: ApprovalRequest): Promise<ApprovalAnswer>;
  /**
   * 書き込む直前に呼ばれる。**戻せるようにするための控え。**
   *
   * `previous` は書き換える前の中身（無かったファイルは undefined）。
   * 書く側が既に読んでいるものを渡すので、二度読まない。
   * 承認が通り、実際に中身が変わるときだけ呼ぶ。
   */
  beforeWrite?(relPath: string, previous: string | undefined): void;
}

/**
 * 承認の返事。
 *
 * `true`／`false` のほかに、**差分の一部だけ**を通せる（`hunks` は
 * 通す塊の番号）。全部か無しかしか無いと、3つ直したうちの1つが違うだけで
 * 直っている2つごと捨てることになる。
 */
export type ApprovalAnswer =
  | boolean
  | { readonly hunks: readonly number[] }
  /**
   * これを通し、**この依頼のあいだは、書き込みをもう訊かない。**
   *
   * 5 ファイル直すと 5 回訊かれる。1 回目で中身を見て納得しているのに、
   * 残り 4 回も同じ手を動かすことになる。人はそこで**中身を見ずに押す**
   * ようになり、承認そのものが形だけになる。
   *
   * 効くのはその依頼のあいだだけ。次の依頼では、また訊く。
   * 関所（ハーネス）は素通りしないし、戻り先も今までどおり残る。
   */
  | 'all';

export type ApprovalRequest =
  | { kind: 'write'; path: string; diff: string; created: boolean }
  | { kind: 'command'; command: string }
  // 外へ出ることも承認の対象。持ち出しは無いが、行き先は見せる。
  | { kind: 'network'; url: string }
  // 重大な変更の協議。判断そのものを利用者に見せる。
  | { kind: 'deliberation'; summary: string };

export interface ToolResult {
  /** モデルへ返す文字列。失敗も文字列で返し、例外は投げない。 */
  content: string;
  isError?: boolean;
}

export interface Tool {
  schema: ToolSchema;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export function ok(content: string): ToolResult {
  return { content };
}

export function fail(message: string): ToolResult {
  // 失敗もモデルに読ませる。例外で落とすとループが止まる。
  return { content: `ERROR: ${message}`, isError: true };
}

export function requireString(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = args[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * 1 以上の整数を受け取る。
 *
 * **モデルは数を文字列で渡してくる。**`{"offset": "120"}` を落とすと、
 * 使い方は合っているのに効かない。取れなければ `undefined` を返して、
 * 呼ぶ側の既定に任せる（`0` や `NaN` を既定と混ぜない）。
 */
export function optionalPositiveInt(
  args: Record<string, unknown>,
  key: string,
): number | undefined {
  const v = args[key];
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return undefined;
  const i = Math.floor(n);
  return i >= 1 ? i : undefined;
}
