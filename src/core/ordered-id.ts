/**
 * 時刻から名前を配る。**同じミリ秒に二つ作っても、必ず別のものにする。**
 *
 * 時刻＋乱数2桁で作っていた。同じミリ秒に二つ作ると、1296 分の 1 ではなく、かなりの割合でぶつかる
 * （50 件なら 6 割）。一覧は名前で引くので、ぶつかると後のものが前のものを置き換える＝頼んだことが黙って消える。
 *
 * 乱数はそのまま使い、前に配った名前と同じか前になるときだけ一つ進める（会話の名前と同じやり方）。
 */
export function idMaker(prefix: string): (now: number, rand?: () => number) => string {
  let last = '';
  return (now, rand = Math.random) => {
    const head = `${prefix}${now.toString(36)}`;
    let tail = Math.floor(rand() * 1296).toString(36).padStart(2, '0');
    if (last.startsWith(head)) {
      const before = last.slice(head.length);
      if (tail <= before) tail = after(before);
    }
    last = head + tail;
    return last;
  };
}

/** その末尾の、次に来るもの。**必ず後になり、必ず別のものになる。** */
function after(tail: string): string {
  const [base = '', over] = tail.split('-');
  const n = parseInt(base, 36);
  if (over === undefined && n < 1295) return (n + 1).toString(36).padStart(2, '0');
  const next = over === undefined ? 1 : parseInt(over, 36) + 1;
  return `${base}-${next.toString(36).padStart(4, '0')}`;
}
