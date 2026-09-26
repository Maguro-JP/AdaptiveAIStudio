/**
 * 同じファイルへの「読んで決めて書く」を、一列に並べる（同じプロセスの中の入れ物は、どれもここを通る）。
 *
 * 追記式の記録でも、「今の回数を読んで、一つ足して書く」や「全体を読んで畳んで書き戻す」は、
 * 並んで走ると片方の書いた分を消す・数え落とす。ファイルごとに順番に通す。
 */
const writing = new Map<string, Promise<unknown>>();

export function inOrder<T>(path: string, run: () => Promise<T>): Promise<T> {
  const prev = writing.get(path) ?? Promise.resolve();
  const mine = prev.then(run, run);
  const settled = mine.catch(() => undefined);
  writing.set(path, settled);
  settled.then(() => { if (writing.get(path) === settled) writing.delete(path); }).catch(() => undefined);
  return mine;
}
