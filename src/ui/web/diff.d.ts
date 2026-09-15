/** 画面側の素の JS に、型だけ添える。中身は diff.js が持つ。 */
export interface DiffLine {
  kind: 'add' | 'del' | 'same' | 'gap' | 'folded' | 'hunk';
  /** 何番目の塊か。戻すときに本体へ言う。 */
  hunk?: number;
  /** 塊の中の何行目か（` `／`+`／`-` を数える）。 */
  at?: number;
  oldNo?: number;
  newNo?: number;
  text?: string;
  count?: number;
}

export interface DiffFile {
  path: string;
  lines: DiffLine[];
  added: number;
  removed: number;
}

export function parseDiff(text: unknown): DiffFile[];
export function collapse(lines: DiffLine[], context?: number): DiffLine[];
export interface RevertPick { hunk: number; lines?: number[] }
export function renderDiff(text: string, opts?: { mode?: 'unified' | 'split'; onRevert?: (picks: RevertPick[]) => unknown }): HTMLElement;
export function splitHunkTexts(text: unknown): { header: string; text: string }[];
