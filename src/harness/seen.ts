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
import { readFile, stat } from 'node:fs/promises';
import type { ToolCall } from '../providers/contract.ts';
import { safeResolve } from '../agent/tools/paths.ts';

const prints = new WeakMap<ToolCall, string>();

/** ファイルの今の中身の指紋。読めなければ undefined（無い・読めないを、比べる材料にしない）。 */
export async function fingerprint(root: string, path: string): Promise<string | undefined> {
  const abs = safeResolve(root, path);
  if (!abs) return undefined;
  try {
    /*
     * 普通のファイルで、大きすぎないものだけ読む。ツールが断る前（作業場の外・大きすぎる）にここが丸読みしていたので、
     * `/dev/zero` へのリンクで止まらず、FIFO では書き手を待って永久に止まり、1.5GB のモデルも読み込んでいた
     */
    const info = await stat(abs);
    if (!info.isFile() || info.size > FINGERPRINT_MAX_BYTES) return undefined;
    return createHash('sha256').update(await readFile(abs)).digest('hex');
  } catch {
    return undefined;
  }
}

/** 指紋を取る大きさの上限。これより大きいファイルは比べる材料にしない（read_file も一度に全部は返さない）。 */
const FINGERPRINT_MAX_BYTES = 64 * 1024 * 1024;

/** 失敗した書き込み（何も書いていない）。同じ内容の繰り返しとして数えない（「読み直してもう一度書いて」と言った後の出し直しを止めていた）。 */
const failedWrites = new WeakSet<ToolCall>();

export function markFailedWrite(call: ToolCall): void {
  failedWrites.add(call);
}

export function isFailedWrite(call: ToolCall): boolean {
  return failedWrites.has(call);
}

/**
 * 何も書かずに終わった書き込み（断られた・当たらなかった・やり直しを求めた、のどれでも）。「読んだ」にも「書いた件数」にも数えない。
 * 失敗した write_file を「前に書いた」と数えていたので、待つ間に誰かが作ったファイルを、読まずに全文で上書きさせていた
 */
const notWritten = new WeakSet<ToolCall>();

export function markNotWritten(call: ToolCall): void {
  notWritten.add(call);
}

export function wroteNothing(call: ToolCall): boolean {
  return notWritten.has(call);
}

/** 呼び出しが見た中身の指紋を結び付ける。 */
export function markSeen(call: ToolCall, print: string): void {
  prints.set(call, print);
}

/** 呼び出しが見た中身の指紋。結び付けていなければ undefined。 */
export function seenPrint(call: ToolCall): string | undefined {
  return prints.get(call);
}

/** 同じファイルを指す呼び出しのうち、最後に指紋を結び付けたものの指紋。道は作業場の中で解いて比べる（`./a.ts` と `a.ts` を同じに見る）。 */
export function lastPrint(history: readonly ToolCall[], root: string, path: string): string | undefined {
  const target = safeResolve(root, path);
  if (!target) return undefined;
  for (let i = history.length - 1; i >= 0; i--) {
    const c = history[i]!;
    const print = prints.get(c);
    if (print === undefined) continue;
    const p = (c.args as Record<string, unknown> | undefined)?.['path'];
    if (typeof p === 'string' && safeResolve(root, p) === target) return print;
  }
  return undefined;
}
