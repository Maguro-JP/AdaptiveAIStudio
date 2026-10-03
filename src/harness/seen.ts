/**
 * 読んだ・書いたときの、ファイルの中身の指紋。
 *
 * 「読んでから書く」は、読んだことだけを見ていた。読んだ後に別の担当や `run_command` が同じファイルを
 * 替えても、読んだ時点の中身をもとに全文を書き戻せたので、その変更が黙って消えた。
 * 読んだ（書いた）直後の指紋を呼び出しに結び付けておき、全文を書く前に今の中身と比べる。
 *
 * 時刻（mtime）ではなく中身で見る。FAT や Z: のようなドライブでは時刻が粗く、変わっても同じに見えることがある。
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { ToolCall } from '../providers/contract.ts';
import { safeResolve } from '../agent/tools/paths.ts';

const prints = new WeakMap<ToolCall, string>();

/** ファイルの今の中身の指紋。読めなければ undefined（無い・読めないを、比べる材料にしない）。 */
export async function fingerprint(root: string, path: string): Promise<string | undefined> {
  const abs = safeResolve(root, path);
  if (!abs) return undefined;
  try {
    return createHash('sha256').update(await readFile(abs)).digest('hex');
  } catch {
    return undefined;
  }
}

/** 呼び出しが見た中身の指紋を結び付ける。 */
export function markSeen(call: ToolCall, print: string): void {
  prints.set(call, print);
}

/** 呼び出しが見た中身の指紋。結び付けていなければ undefined。 */
export function seenPrint(call: ToolCall): string | undefined {
  return prints.get(call);
}
