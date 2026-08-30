/** 画面側の素の JS に、型だけ添える。中身は diff.js が持つ。 */
export interface DiffLine {
  kind: 'add' | 'del' | 'same' | 'gap' | 'folded';
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
export function renderDiff(text: string, opts?: { mode?: 'unified' | 'split' }): HTMLElement;
