/**
 * 一つの道を、前の中身へ置き戻す。巻き戻し（Checkpoint）と「戻す」（UndoStore）が同じ手で戻す。
 *
 * 別の担当の読み直しで、置き戻しが三つの形で壊れると分かった。
 *
 *   ・`writeFile` はリンクを辿る。ツールが作業場の外を指すリンクを置いていると、
 *     **外のファイルを前の中身で上書きする**。リンクは辿らず、リンクそのものを消してから書く
 *   ・`stat` もリンクを辿る。切れたリンクは「無い」と読まれて残る。`lstat` で見る
 *   ・戻せなかった道を黙って落としていた。ファイルがフォルダに入れ替わっていると `EISDIR` で
 *     捨てられ、「戻した」の一覧に出ない。**戻せなかったと言う。**
 *
 * 親がリンクで外へ出る道は `realSafeResolve` で断る（文字の上では作業場の中でも、実体は外）。
 */
import { lstat, unlink, rmdir, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { safeResolve, realSafeResolve } from '../agent/tools/paths.ts';

export type PutBack = 'restored' | 'unchanged' | 'failed';

export async function putBack(root: string, relPath: string, content: string | undefined): Promise<PutBack> {
  const abs = safeResolve(root, relPath);
  if (!abs) return 'failed';
  // 実体で見るのは親まで。道そのものがリンクなら、辿らずにそのリンクを消す（下）。
  if (!(await realSafeResolve(root, dirname(relPath)))) return 'failed';
  const now = await lstat(abs).catch(() => undefined);
  try {
    if (now?.isSymbolicLink()) {
      // 前がファイルでも「無い」でも、いまのリンクは要らない。辿らずに消す。
      await unlink(abs);
    } else if (now?.isDirectory()) {
      // 前は「無い」なのにフォルダが在る。ツールが作ったフォルダの中身は分からないので消さない。
      if (content === undefined) return 'failed';
      // 前はファイル。空のフォルダなら退けて書く（中身が残っていれば投げる → failed）。
      await rmdir(abs);
    } else if (content === undefined) {
      if (!now) return 'unchanged';
      await unlink(abs);
      return 'restored';
    }
    if (content === undefined) return 'restored';
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
    return 'restored';
  } catch {
    return 'failed';
  }
}

/** 消す道を先に、書く道を後に。ファイル → フォルダの入れ替えは、中を消してからでないと書けない。 */
export function putBackOrder<T extends { content?: string | undefined }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => Number(a.content !== undefined) - Number(b.content !== undefined));
}
