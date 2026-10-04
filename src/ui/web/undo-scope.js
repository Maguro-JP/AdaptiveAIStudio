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

/**
 * 戻り先の時刻の出し方（日本時間）。今日なら時刻だけ、今日でなければ月日も、年が違えば年も出す。
 * 時刻だけを出していたので、三日前の 14:20 と今日の 14:20 が同じ「14:20」に並び、今日の分のつもりで押すと何日分も戻っていた。
 */
export function undoWhen(at, now = Date.now()) {
  const parts = (t) => Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(t)).map((p) => [p.type, p.value]));
  const a = parts(at);
  const n = parts(now);
  const time = `${a.hour}:${a.minute}`;
  if (a.year !== n.year) return `${a.year}/${a.month}/${a.day} ${time}`;
  if (a.month !== n.month || a.day !== n.day) return `${a.month}/${a.day} ${time}`;
  return time;
}
