/**
 * 最小のグロブ照合。保護パターンの指定に使う。
 * 依存を増やさないため自前で持つ。対応するのは * ** ? のみ。
 *
 * **`a/**` が何にも当たらない書き方をしていた。**
 * `(?:.*\/)?` に直していたので、末尾に置くと「区切りで終わる道」しか
 * 表さず、`a/b.txt` に当たらない。既定の保護に `.git/**` が入っていたので、
 * `.git` の中は**守られていなかった**。守っているつもりで守れていないのが
 * いちばん悪い。
 */
export function minimatch(path: string, pattern: string): boolean {
  const normalized = path.split('\\').join('/');
  const re = new RegExp('^' + toRegex(pattern) + '$');
  return re.test(normalized);
}

function toRegex(pattern: string): string {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        i += 1;
        if (pattern[i + 1] === '/') {
          // `**/` は「区切りを何段でも跨ぐ（0段を含む）」
          i += 1;
          out += '(?:[^/]*/)*';
        } else {
          // 末尾やその他の `**` は、区切りごと何でも
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') out += '[^/]';
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return out;
}
