import { resolve, relative, isAbsolute, sep } from 'node:path';

/**
 * 作業ディレクトリの外へ出さない。
 * `..` やシンボリックリンク経由の脱出を防ぐ最初の関門。
 */
export function safeResolve(root: string, candidate: string): string | undefined {
  const abs = isAbsolute(candidate) ? candidate : resolve(root, candidate);
  const rel = relative(root, abs);
  if (rel === '') return abs;
  if (rel.startsWith('..') || isAbsolute(rel)) return undefined;
  if (rel.split(sep).includes('..')) return undefined;
  return abs;
}

export function toDisplayPath(root: string, abs: string): string {
  const rel = relative(root, abs);
  return rel === '' ? '.' : rel.split(sep).join('/');
}

import { realpath, lstat } from 'node:fs/promises';
import { dirname as dirOf } from 'node:path';

/**
 * リンクを辿った先まで見て、作業場の中かを決める。
 *
 * `safeResolve` は文字の上でしか見ない。作業場の中に `link -> /etc` という
 * リンクが一つあれば、`link/passwd` は文字の上では中でも、実体は外。
 * モデルは `ln -s` を打てるので、これは他人事ではない。
 *
 * まだ無い道（これから書くファイル）は、在る所まで遡って実体を見る。
 */
export async function realSafeResolve(root: string, candidate: string): Promise<string | undefined> {
  const abs = safeResolve(root, candidate);
  if (!abs) return undefined;
  let realRoot: string;
  try { realRoot = await realpath(root); } catch { return undefined; }

  /*
   * **返すのは、渡された root の綴りのまま。**
   *
   * realpath は「作業場の中か」を判じるためだけに使う。返す道まで実体の綴りに
   * 置き換えると、呼んだ側が持っている root と食い違う。
   *
   * Windows の CI で実際に壊れた。`%TEMP%` が `C:\Users\RUNNER~1\...`（8.3 の
   * 短い名前）なのに realpath は `C:\Users\runneradmin\...` を返すので、
   * `toDisplayPath` が `../../../../../runneradmin/...` を控えた。その道は
   * `safeResolve` が弾くため、**戻す（undo）が何も戻さずに黙って終わる。**
   * junction・ネットワークの割り当て・symlink でも同じことが起きる。
   *
   * 中か外かは実体（realRoot と full）で見る。ここは変えない。
   * 変えるのは、外に返す綴りだけ。在る所まで遡るのも、そのまま。
   */
  let probe = abs;
  let tail = '';
  for (;;) {
    try {
      const real = await realpath(probe);
      const full = tail ? resolve(real, tail) : real;
      const rel = relative(realRoot, full);
      if (rel === '') return root;
      if (rel.startsWith('..') || isAbsolute(rel)) return undefined;
      return resolve(root, rel);
    } catch {
      const up = dirOf(probe);
      if (up === probe) return undefined;
      tail = tail ? `${probe.slice(up.length + 1)}${sep}${tail}` : probe.slice(up.length + 1);
      probe = up;
    }
  }
}

/** それ自身がリンクか。書く先がリンクなら、書いた先は別の場所。 */
export async function isSymlink(abs: string): Promise<boolean> {
  try { return (await lstat(abs)).isSymbolicLink(); } catch { return false; }
}
