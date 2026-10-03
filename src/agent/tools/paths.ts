import { resolve, relative, isAbsolute, sep } from 'node:path';

/**
 * 作業ディレクトリの外へ出さない。
 * `..` やシンボリックリンク経由の脱出を防ぐ最初の関門。
 */
/**
 * `relative()` の答えが、根の外を指すか。**最初の区切りが `..` のときだけ外。**`rel.startsWith('..')` で見ていたので、作業場の中の
 * `..foo` のような名前のファイル（`..env.bak` など）まで外として断っていた。
 */
export function outsideRel(rel: string): boolean {
  // `.. ` や `...` も外として扱う（Windows は区切りの末の点と空白を落とすので、`..` と同じになりうる。確かめていないので断る側に倒す）
  return isAbsolute(rel) || /^\.\.[. ]*$/.test(rel.split(sep)[0] ?? '');
}

export function safeResolve(root: string, candidate: string): string | undefined {
  const abs = isAbsolute(candidate) ? candidate : resolve(root, candidate);
  const rel = relative(root, abs);
  if (rel === '') return abs;
  if (outsideRel(rel)) return undefined;
  if (rel.split(sep).includes('..')) return undefined;
  return abs;
}

export function toDisplayPath(root: string, abs: string): string {
  const rel = relative(root, abs);
  return rel === '' ? '.' : rel.split(sep).join('/');
}

import { realpath, lstat } from 'node:fs/promises';
import { dirname as dirOf, basename as baseOf } from 'node:path';

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
      if (outsideRel(rel)) return undefined;
      return resolve(root, rel);
    } catch {
      const up = dirOf(probe);
      if (up === probe) return undefined;
      // 一つ上が根（`C:\`・`/`）だと区切りで終わるので、長さで切ると名前の頭の一字を落とす（`Z:\new\a.txt` が `Z:\ew\a.txt` になる）。名前は basename で取る
      tail = tail ? `${baseOf(probe)}${sep}${tail}` : baseOf(probe);
      probe = up;
    }
  }
}

/** 道の長さの上限（Windows の長い道でも 32767 字）。これより長い文字列は道ではない。 */
const MAX_PATH_CHARS = 32767;

/**
 * 書いたときに実際に当たるファイルの、作業場からの道（`/` 区切り）。外・解けないなら undefined。
 *
 * 規則（保護・試験・協議）は引数の綴りを見るが、書く側は `realSafeResolve` で実体へ解いてから書く。
 * 綴りと実体が食い違うと、規則は「別のファイル」として通し、書く側は守っているファイルに書く。
 *   - Windows の 8.3 の短い名前（`ENV~1` は `.env`、`GIT~1\config` は `.git\config`）
 *   - 大小の違い（`SRC\Harness\Gate.ts`）は、在るものなら実体の綴りに揃う
 *   - フォルダへのリンク・junction（`g -> .git` の `g/config`）
 * 規則は綴りと、この実体の両方で照らす。
 */
export async function canonicalRel(root: string, candidate: string): Promise<string | undefined> {
  // 道になりえない長さなら引かない。外のツールの長い文字列（base64 など）を区切りごとに realpath で遡ると重い
  if (candidate.length > MAX_PATH_CHARS) return undefined;
  const real = await realSafeResolve(root, candidate);
  return real === undefined ? undefined : toDisplayPath(root, real);
}

/** それ自身がリンクか。書く先がリンクなら、書いた先は別の場所。 */
export async function isSymlink(abs: string): Promise<boolean> {
  try { return (await lstat(abs)).isSymbolicLink(); } catch { return false; }
}
