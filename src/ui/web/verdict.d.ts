/** 画面側の素の JS に、型だけ添える。中身は verdict.js が持つ。 */
export interface Verdict {
  reason: string;
  checked?: 'passed' | 'failed' | 'preexisting' | 'notRun';
  seconds: number;
  model?: string;
  tps?: number;
}
export const SLOW_TPS: number;
export function howText(v: Verdict): string;
export function verdictText(v: Verdict): string;
export function slowNote(v: Verdict): string;
