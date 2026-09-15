/** 画面側の素の JS に、型だけ添える。中身は verdict.js が持つ。 */
export interface Verdict {
  reason: string;
  checked?: 'passed' | 'failed' | 'preexisting' | 'notRun';
  /**
   * 訊かれただけの回か。
   *
   * 問いに答えただけの回に「完了（検証していません）」と出していた。
   * 何も完了していないし、確かめるものも無い（`src/core/session.ts` の settled）。
   */
  chat?: boolean;
  /** 終わりの一行に出す秒。言葉だけを見る `howText` には要らない。 */
  seconds?: number;
  model?: string;
  tps?: number;
}
export const SLOW_TPS: number;
/** 終わり方を、人の言葉にする。**符丁のままは出さない。** */
export function howText(v: Verdict): string;
export function verdictText(v: Verdict & { seconds: number }): string;
export function slowNote(v: Verdict): string;
