/**
 * 行入力。
 *
 * readline の question() は「呼んだ時点以降」の入力しか受け取らない。
 * 起動処理（モデルの温め・先読み・接続確認）を待っている間に
 * パイプで流し込まれた入力は、question() を呼ぶ前に EOF に達して捨てられる。
 *
 *   echo "テストを追加して" | aas agent    ← 何もせず終了してしまう
 *
 * 自動実行させたい道具でこれは致命的なので、
 * 到着した行を自分で溜めておき、後から取り出せるようにする。
 */
import { createInterface, type Interface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

export class LineSource {
  readonly #rl: Interface;
  readonly #output: Writable;
  readonly #pending: string[] = [];
  #waiting?: (line: string | undefined) => void;
  #closed = false;

  constructor(input: Readable, output: Writable) {
    this.#output = output;
    this.#rl = createInterface({ input, output, terminal: false });

    this.#rl.on('line', (line) => {
      const waiter = this.#waiting;
      if (waiter) {
        this.#waiting = undefined;
        waiter(line);
      } else {
        // まだ誰も待っていない。捨てずに溜めておく。
        this.#pending.push(line);
      }
    });

    this.#rl.on('close', () => {
      this.#closed = true;
      const waiter = this.#waiting;
      if (waiter) {
        this.#waiting = undefined;
        waiter(undefined);
      }
    });
  }

  onSigint(handler: () => void): void {
    this.#rl.on('SIGINT', handler);
  }

  /** 溜まっている行があるか。待機中かどうかの判断に使う。 */
  get hasPending(): boolean {
    return this.#pending.length > 0;
  }

  /**
   * 1行受け取る。待っている間に onIdle を呼ぶ。
   *
   * 待機中は計算資源が丸ごと空いている。
   * ローカルでそこを遊ばせるのは損なので、考える時間に充てる。
   */
  async questionWhileIdle(
    prompt: string,
    idleMs: number,
    onIdle: () => Promise<boolean>,
  ): Promise<string | undefined> {
    const queued = this.#pending.shift();
    if (queued !== undefined) {
      this.#output.write(prompt + queued + '\n');
      return queued;
    }
    if (this.#closed) return undefined;

    this.#output.write(prompt);
    const line = new Promise<string | undefined>((resolve) => { this.#waiting = resolve; });

    let settled = false;
    line.then(() => { settled = true; });

    for (;;) {
      const timer = new Promise<'idle'>((r) => setTimeout(() => r('idle'), idleMs));
      const winner = await Promise.race([line.then(() => 'line' as const), timer]);
      if (winner === 'line') break;
      if (settled) break;
      const printed = await onIdle();
      // 考えている間に入力が来ていたら、そちらを優先する
      if (settled) break;
      // 何も出力していないなら、プロンプトは出したままで良い。
      // 毎回書き直すと画面が入力欄で埋まる。
      if (printed) this.#output.write(prompt);
    }
    return line;
  }

  /** 1行受け取る。入力が尽きていれば undefined。 */
  async question(prompt: string): Promise<string | undefined> {
    const queued = this.#pending.shift();
    if (queued !== undefined) {
      // 溜まっていた行も、対話時と同じように画面へ出す
      this.#output.write(prompt + queued + '\n');
      return queued;
    }
    if (this.#closed) return undefined;

    this.#output.write(prompt);
    return new Promise<string | undefined>((resolve) => { this.#waiting = resolve; });
  }

  close(): void {
    this.#rl.close();
  }
}
