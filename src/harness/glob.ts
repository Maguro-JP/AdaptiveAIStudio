/**
 * 最小のグロブ照合。保護パターンの指定に使う。
 * 依存を増やさないため自前で持つ。対応するのは * ** ? のみ。
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
        // ** は区切りを跨いで一致する
        i += 1;
        if (pattern[i + 1] === '/') i += 1;
        out += '(?:.*/)?';
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') out += '[^/]';
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return out;
}
