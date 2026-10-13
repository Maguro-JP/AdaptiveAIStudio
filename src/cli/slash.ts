/**
 * `/system 文` のような打ち込みを、命令と残りに分ける。
 *
 * 最初の空白だけで分け、残りはそのまま渡す。空白ごとに分けて一つの空白で繋ぎ直していたので、
 * `/system` に渡した文の続いた空白・タブ・改行が詰まっていた。
 */
export function splitSlash(line: string): { cmd: string; arg: string } {
  const m = /^(\S+)\s*([\s\S]*)$/.exec(line.trim());
  return { cmd: m?.[1] ?? '', arg: m?.[2] ?? '' };
}

/**
 * 打った一行を、命令として読める形にそろえる。前後の空白を落とし、頭の全角の `／` を `/` にする
 * （日本語の入力のまま打つと全角になり、命令がモデルへの依頼として送られていた）。
 */
export function normalizeLine(input: string): string {
  return input.trim().replace(/^／/, '/');
}
