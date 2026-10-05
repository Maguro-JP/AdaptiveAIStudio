/**
 * 「終わった」を、語形の変わらない合図で受け取る。
 *
 * ここまで、**道具を呼ばなかった＝終わった**と決めていた。
 * 小さいモデルは作業の途中で平気で手を止める。
 * 「では次に src/a.ts を書き換えます」と言って、そこで返してくる。
 * それを「完了」と読んでいたので、**何もしていないのに完了と出ていた。**
 * 自律で回し続けられなかったのは、ここで毎回降りていたから。
 *
 * 判じるのは、モデルの言い回しではなく**決めた一語**。
 * 日本語で「終わりました」を読ませると、「終わりませんでした」を
 * 「終わった」と読む（同じ間違いを、通す／止めるで既にやっている）。
 *
 * 合図は行頭に、それだけの行として書かせる（`PASS` / `BLOCK:` と同じ扱い）。
 */

/** 終わりの合図。**変えない。**変えると、古い決まりのまま動くモデルが止まらなくなる。 */
export const DONE_MARK = 'TASK_DONE';

/**
 * 流れてくる本文から、合図を見つけて取り除く。
 *
 * 少しずつ届くので、合図の途中まで（`TASK_` など）が来た時点では
 * まだ見せない。合図でないと分かってから、まとめて見せる。
 * 見せてしまうと、画面に `TASK_DONE` が出る。
 */
export class DoneMark {
  /** まだ見せていない、行の途中。 */
  #tail = '';
  #found = false;
  /** いまの行の頭を、もう見せたか。見せた行の残りは、合図になりえない（行の途中に書いたもの）。 */
  #midLine = false;

  /** 届いた分を入れて、**見せてよい分**を返す。 */
  push(delta: string): string {
    this.#tail += delta;
    let shown = '';
    for (;;) {
      const at = this.#tail.indexOf('\n');
      if (at < 0) break;
      const line = this.#tail.slice(0, at + 1);
      this.#tail = this.#tail.slice(at + 1);
      if (!this.#midLine && isMark(line)) this.#found = true;
      else shown += line;
      this.#midLine = false;
    }
    // 行の途中。合図になりうるなら、まだ見せない。頭を見せた行の残りは、合図ではないので待たない
    // （待って空にした後で、残りを行の頭として読んでいたので、区切れ方で合図の判定が変わった）
    if (this.#midLine || !couldBeMark(this.#tail)) {
      if (this.#tail) this.#midLine = true;
      shown += this.#tail;
      this.#tail = '';
    }
    return shown;
  }

  /**
   * ここで行が切れたことにする。本文から呼び出しを抜いた後に使う（抜いた後の残りは前後を詰めてあり、
   * 改行が消えている。続きを行の途中として読むと、次の行の合図を合図と読まずに見せていた）。
   */
  newLine(): void {
    if (this.#tail === '') this.#midLine = false;
  }

  /** 終わり。残りを吐き出し、合図があったかを言う。 */
  end(): { text: string; done: boolean } {
    const rest = this.#tail;
    this.#tail = '';
    const midLine = this.#midLine;
    this.#midLine = false;
    if (!midLine && isMark(rest)) return { text: '', done: true };
    return { text: rest, done: this.#found };
  }

  /** いま見つかっているか（途中で見るとき用）。 */
  get done(): boolean { return this.#found; }
}

/** その行は合図そのものか。前後の空白は許す。 */
function isMark(line: string): boolean {
  return line.trim() === DONE_MARK;
}

/**
 * まだ途中だが、合図になりうるか。
 *
 * 空白だけ、あるいは合図の先頭に当たるなら、見せずに待つ。
 * `TASK_DONE です` のように続きが付いたら、その時点で合図ではない。
 */
function couldBeMark(tail: string): boolean {
  const t = tail.trimStart();
  if (t.length === 0) return tail.length > 0;
  return DONE_MARK.startsWith(t) || (t === DONE_MARK);
}
