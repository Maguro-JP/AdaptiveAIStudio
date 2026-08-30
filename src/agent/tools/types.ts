import type { ToolSchema } from '../../providers/contract.ts';

export interface ToolContext {
  /** 作業ディレクトリ。ここより外へは一切アクセスさせない。 */
  root: string;
  signal: AbortSignal;
  /** 書き込み・実行の承認を求める。false なら実行しない。 */
  approve(req: ApprovalRequest): Promise<boolean>;
}

export type ApprovalRequest =
  | { kind: 'write'; path: string; diff: string; created: boolean }
  | { kind: 'command'; command: string }
  // 外へ出ることも承認の対象。持ち出しは無いが、行き先は見せる。
  | { kind: 'network'; url: string };

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
