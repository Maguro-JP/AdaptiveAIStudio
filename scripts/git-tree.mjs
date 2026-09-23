/**
 * いまの木を読む。**確かめる側と、押す側で同じ読み方を使う。**
 *
 * `scripts/check.mjs` と `scripts/pushed-tree-check.mjs` が、どちらも
 * 「HEAD は何か・commit していない直しは在るか」を要る。二箇所に書くと、
 * 片方だけ直したときに**同じ木を別の形で読む**ことになる。
 */
import { execFileSync } from 'node:child_process';

/** @returns {{ head: string, dirty: string[] }} */
export function lookTree(cwd = process.cwd()) {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' })
    .split('\n').map((l) => l.trim()).filter(Boolean);
  return { head, dirty };
}

/**
 * 読めなければ、空の木を返す。
 *
 * git が無い場所（配る形の中）でも `npm run check` は回る。ここで投げると、
 * **確かめそのものが git の有無で落ちる。**
 */
export function lookTreeOrEmpty(cwd = process.cwd()) {
  try {
    return lookTree(cwd);
  } catch {
    return { head: '', dirty: [] };
  }
}

/** 一行に畳む。シェルの変数へ入れて持ち回るため。 */
export function pack(tree) {
  return [tree.head, ...tree.dirty].join('\t');
}

export function unpack(line) {
  const [head, ...dirty] = String(line).split('\t');
  return { head: head ?? '', dirty: dirty.filter(Boolean) };
}
