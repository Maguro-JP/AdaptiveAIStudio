/**
 * 同じ並びを吐き続けているのを見つける。
 *
 * 実機で「1+1=」に対して `1+100000000…` と 0 を延々と書き続け、画面の帯は
 * 4 分 36 秒「書いています」のままだった。止めるものが無かったので、
 * 上限（コンテキストウィンドウの 4 割）まで吐き切るまで終わらない。
 *
 * **これは模型の機嫌ではなく、止め方が無いという作りの問題。**
 * サンプリングを変えても起きるときは起きる。起きたら切る。
 *
 * 見分け方は「末尾が、短い単位の繰り返しだけで長く続いているか」。
 * 見出しの `-----` や罫線と区別するため、既定は 200 文字と厳しめに取る
 * （罫線は行の幅までで、200 文字は超えない）。
 */

export interface RunawayOptions {
  /** これだけ続いたら暴走とみなす。既定 200 文字。 */
  minRun?: number;
  /** 繰り返しの単位の長さの上限。既定 40 文字。 */
  maxUnit?: number;
}

/**
 * 暴走が始まった位置を返す。無ければ -1。
 *
 * 末尾だけを見る（出来た端から呼ばれるので、毎回すべてを走査しない）。
 */
export function findRunaway(text: string, opts: RunawayOptions = {}): number {
  const minRun = opts.minRun ?? 200;
  const maxUnit = opts.maxUnit ?? 40;
  if (text.length < minRun) return -1;

  // 末尾だけ見る。走査する長さを入力に比例させない
  // （出来た端から呼ばれるので、全部を毎回見ると二乗になる）。
  const window = text.slice(-(minRun * 2));

  let best = -1;
  for (let unit = 1; unit <= maxUnit; unit += 1) {
    if (window.length < unit * 2) break;
    // 末尾から、周期 unit で一致している長さを測る。
    let same = 0;
    for (let i = window.length - unit - 1; i >= 0; i -= 1) {
      if (window[i] !== window[i + unit]) break;
      same += 1;
    }
    const run = same + unit;
    if (run < minRun) continue;
    // いちばん短い単位が、その繰り返しの本当の単位。
    // 見つけた時点で、それより長い単位を見る意味は無い。
    best = text.length - run;
    break;
  }
  return best;
}

/**
 * 止めた理由を、記録の一行にする。
 *
 * **何が起きたかを、その場で言う。**黙って切ると「途中で終わった」に見える。
 */
export function runawayNote(text: string, at: number): string {
  const unit = text.slice(at, at + 24).replace(/\n/g, '\\n');
  return `同じ並びを繰り返していたので止めました（${text.length - at} 文字ぶん、「${unit}」…）`;
}
