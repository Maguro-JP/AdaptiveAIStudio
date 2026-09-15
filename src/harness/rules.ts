/**
 * ハーネス規則 — モデルに「お願い」せず、境界で機械的に強制する。
 *
 * プロンプトに「テストを消さないでください」と書くのは要求であって保証ではない。
 * モデルは人と同じく誤った選択をするので、
 * **守らせたいことは実行の手前で止める**必要がある。
 *
 * 規則はツール呼び出しの前後に挟まり、次のいずれかを返す:
 *   allow  そのまま実行する
 *   deny   実行させず、理由をモデルへ返す（モデルは考え直す）
 *   warn   実行はするが、利用者と記録に残す
 *   inject 実行後に追加の情報をモデルへ渡す（気づかせる）
 */
import type { ToolCall } from '../providers/contract.ts';

export interface RuleContext {
  root: string;
  /** これまでのツール呼び出し（この依頼の中で） */
  history: ToolCall[];
  /** 依頼の本文 */
  instruction: string;
  signal: AbortSignal;
}

export type PreDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'warn'; note: string };

export type PostDecision =
  | { kind: 'ok' }
  /** 実行後にモデルへ追加で伝える。気づかせるための差し込み。 */
  | { kind: 'inject'; note: string }
  /** 実行結果が受け入れられない。取り消しはできないが、次の判断材料を強制的に渡す。 */
  | { kind: 'violation'; reason: string };

export interface Rule {
  name: string;
  /** 何のための規則かを一行で。監査ログと説明に出る。 */
  description: string;
  /** 実行前の判定 */
  pre?(call: ToolCall, ctx: RuleContext): Promise<PreDecision> | PreDecision;
  /** 実行後の判定 */
  post?(call: ToolCall, result: string, ctx: RuleContext): Promise<PostDecision> | PostDecision;
}

export const allow: PreDecision = { kind: 'allow' };
export const ok: PostDecision = { kind: 'ok' };

export function deny(reason: string): PreDecision {
  return { kind: 'deny', reason };
}

/** 呼び出し引数から文字列を取り出す小道具。規則実装で多用する。 */
export function argString(call: ToolCall, key: string): string | undefined {
  const args = call.args;
  if (typeof args !== 'object' || args === null) return undefined;
  const v = (args as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : undefined;
}
