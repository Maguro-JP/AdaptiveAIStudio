/**
 * 「ファイルを書き換える道具」を、一箇所で決める。
 *
 * ここまで、守りはどれも `name === 'write_file'` と**名前を直に見て**いた。
 * 守られた場所・読んでから書く・巻き戻し・差分の表示・作業前検査、
 * 全部で18箇所。**書き換える道具をもう一つ足した瞬間、その全部を
 * すり抜ける口になる。**（.env を守っているつもりで、別の道具からは
 * 素通り、という形になる。）
 *
 * だから、増やす前にここへ集める。
 */
import { readFile } from 'node:fs/promises';
import { safeResolve } from './paths.ts';

/** ファイルを書き換える道具。**増やすときは、必ずここに足す。** */
export const WRITE_TOOLS = ['write_file', 'edit_file'] as const;

export function isWriteTool(name: string): boolean {
  return (WRITE_TOOLS as readonly string[]).includes(name);
}

/** 呼び出しから、書き換える先の道を取る。 */
export function writePath(args: Record<string, unknown> | unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const p = (args as { path?: unknown }).path;
  return typeof p === 'string' ? p : undefined;
}

/**
 * その呼び出しで、ファイルが**どうなるか**。
 *
 * 中身を見る守り（テストを消していないか、同じものを書き続けていないか）は、
 * 書かれる後の姿が要る。`write_file` は引数にそのまま入っているが、
 * `edit_file` は「いまの中身に当ててみないと分からない」。
 * **見えないからと素通りさせない。**ここで当ててから渡す。
 */
export async function plannedContent(
  name: string,
  args: Record<string, unknown> | unknown,
  root: string,
): Promise<string | undefined> {
  if (typeof args !== 'object' || args === null) return undefined;
  const a = args as { content?: unknown; find?: unknown; replace?: unknown; all?: unknown };
  if (name === 'write_file') return typeof a.content === 'string' ? a.content : undefined;
  if (name !== 'edit_file') return undefined;

  const path = writePath(args);
  if (!path || typeof a.find !== 'string' || typeof a.replace !== 'string') return undefined;
  const abs = safeResolve(root, path);
  if (!abs) return undefined;
  const before = await readFile(abs, 'utf8').catch(() => undefined);
  if (before === undefined) return undefined;
  return applyEdit(before, a.find, a.replace, a.all === true).text;
}

/**
 * 置き換えを当てる。**当たった数も返す。**
 *
 * 数を返さないと、「一箇所のつもりが十箇所変わっていた」を止められない。
 * 小さいモデルは短い断片を渡してくるので、これは実際に起きる。
 */
export function applyEdit(
  before: string, find: string, replace: string, all: boolean,
): { text: string; hits: number } {
  if (find.length === 0) return { text: before, hits: 0 };
  let hits = 0;
  let at = 0;
  for (;;) {
    const found = before.indexOf(find, at);
    if (found < 0) break;
    hits += 1;
    at = found + find.length;
  }
  if (hits === 0) return { text: before, hits: 0 };
  if (!all && hits > 1) return { text: before, hits };
  return { text: all ? before.split(find).join(replace) : before.replace(find, replace), hits };
}
