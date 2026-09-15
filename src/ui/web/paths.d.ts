/** 画面側の素の JS に、型だけ添える。中身は paths.js が持つ。 */

/** 道の隣に置く「開く」「コピー」。deps は試験で差し込む手。 */
export function pathActions(path: string, deps?: {
  open?: (path: string) => Promise<{ ok: boolean; body?: { error?: string } }>;
  copy?: (text: string) => Promise<void>;
  say?: (message: string) => void;
}): HTMLElement;
