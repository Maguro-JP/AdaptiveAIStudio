/**
 * 作業場の中身を、横の板に出すために読む。
 *
 * **根の外へ出さない。**画面から渡された道をそのまま繋ぐと、
 * `../../..` で好きな所を覗ける口になる。文字の上で確かめるだけでは
 * 足りないので（リンクを辿ると外へ出る）、実体を解いてから比べる。
 */
import { readdir, realpath } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';

export interface Entry {
  name: string;
  /** 根からの相対。画面はこれをそのまま返してくる */
  path: string;
  dir: boolean;
}

/** 一度に返す数の上限。node_modules を開いても画面が固まらないように。 */
export const MAX_ENTRIES = 400;

/** 開いても仕方のないもの。数が多く、見に行く用が無い。 */
const SKIP = new Set(['.git', 'node_modules', '.DS_Store']);

/**
 * 根の中に収まっているか。実体（リンクを解いた先）で比べる。
 *
 * @returns 収まっていれば解いた実体の道。外なら undefined
 */
export async function insideRoot(root: string, asked: string): Promise<string | undefined> {
  if (isAbsolute(asked)) return undefined;
  const realRoot = await realpath(root);
  let real: string;
  try {
    real = await realpath(resolve(realRoot, asked));
  } catch {
    return undefined;
  }
  if (real === realRoot) return real;
  const rel = relative(realRoot, real);
  // 上へ出る道と、絶対の道は受け取らない。
  if (rel.startsWith('..') || isAbsolute(rel)) return undefined;
  return real;
}

/** 一階層ぶんの中身。**切ったことを黙らない**ために、切る前の数も持つ。 */
export interface Listing {
  /** 出すぶん。多いときは `MAX_ENTRIES` で切る。 */
  entries: Entry[];
  /** 切る前の数。画面は「ほかに N 件」を出すのに使う。 */
  total: number;
}

/** 一階層だけ返す。木を全部読むと、大きな作業場で待たされる。 */
export async function listDir(root: string, asked: string): Promise<Listing> {
  const real = await insideRoot(root, asked);
  if (!real) throw new Error('作業場の外は見られません');

  const names = await readdir(real, { withFileTypes: true });
  const entries: Entry[] = [];
  for (const d of names) {
    if (SKIP.has(d.name)) continue;
    entries.push({
      name: d.name,
      path: asked ? `${asked}${asked.endsWith('/') ? '' : '/'}${d.name}` : d.name,
      dir: d.isDirectory(),
    });
  }
  // フォルダが先、その中で名前順。探すときの目の動きに合わせる。
  entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  /*
   * **切ったことを、黙って隠さない。**
   *
   * ここは黙って `MAX_ENTRIES` 件で切っていた。5000 件のフォルダを開くと
   * 400 件だけ出て、**残りは無いように見える**（押して実測）。
   * 戻せる一覧や会話の一覧は「ほかに N 件」と言っているので、ここも言う。
   */
  return { entries: entries.slice(0, MAX_ENTRIES), total: entries.length };
}

/** 画面から来た道を、読むための実体に直す。読めない・外なら undefined。 */
export async function resolveInside(root: string, asked: string): Promise<string | undefined> {
  return insideRoot(root, asked);
}

/** 道の区切りを画面むけに揃える（Windows の `\\` を `/` に）。 */
export function toWebPath(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}

/** 根からの相対を、実際のファイルの場所にする。 */
export function underRoot(root: string, rel: string): string {
  return join(root, rel);
}
