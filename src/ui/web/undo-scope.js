/**
 * 「ここまで戻す」で、実際に書き戻るファイル。
 *
 * 戻すのは選んだ一件だけではない。**その後の直しが上に乗っている**ので、
 * 選んだ戻り先を含めて、それより新しいものも一緒に当てる
 * （`src/core/undo.ts` の `restore`）。
 *
 * 画面は選んだ一件の分しか並べずに「戻します」と訊いていたので、
 * **名前を出していないファイルまで書き戻っていた。**消える直しが在るのに、
 * 押す前にそれが見えない。戻すのは取り返しの利かない側なので、全部並べる。
 *
 * 新しい順（いちばん新しいものが `list[0]`）で渡す。
 */
export function willRestore(list, index) {
  const upto = (list ?? []).slice(0, Math.max(0, index) + 1);
  const out = [];
  for (const point of upto) {
    for (const path of point?.paths ?? []) if (!out.includes(path)) out.push(path);
  }
  return out;
}

/**
 * 「ここまで戻す」でも**戻らない**ファイル。
 *
 * 大きすぎて控えられなかったものは、戻り先に中身が入っていない
 * （`src/core/undo.ts` の `capture`）。知らせは流れにしか出ていなかったので、
 * 既定の並びで見ている人には届かない。**戻る一覧の隣に、戻らない分も出す。**
 */
export function wontRestore(list, index) {
  const upto = (list ?? []).slice(0, Math.max(0, index) + 1);
  const out = [];
  for (const point of upto) {
    for (const path of point?.skipped ?? []) if (!out.includes(path)) out.push(path);
  }
  return out;
}
