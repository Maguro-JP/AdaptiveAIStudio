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
  #onProcessSigint?: () => void;

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

  /**
   * Ctrl-C を受ける。**プロセスの SIGINT も受ける。**読み手は `terminal: false` で作っているので、rl の SIGINT は来ない。
   * rl だけに付けていたので、Ctrl-C で生成だけを止めるつもりが、プロセスごと落ちていた（戻り先を閉じる前に終わる）。
   * 端末でも同じで、Ctrl-C は端末の側で SIGINT としてプロセスへ送られる。
   */
  onSigint(handler: () => void): void {
    this.#rl.on('SIGINT', handler);
    /*
     * **二度押したら終わる。**止める処理が詰まる（起動の途中・考えごとの最中・片づけが返らない）と、一度目の Ctrl-C では抜けない。
     * 2 秒以内の二度目は、止める処理を待たずに終わる（130 は Ctrl-C で終わったときの慣例の終了コード）。
     * 読み手を閉じた後は聞き手を外すので、それ以降の Ctrl-C は既定どおりプロセスを終わらせる。
     */
    let lastAt = 0;
    this.#onProcessSigint = () => {
      const now = Date.now();
      if (now - lastAt < SIGINT_TWICE_MS) process.exit(130);
      lastAt = now;
      handler();
    };
    process.on('SIGINT', this.#onProcessSigint);
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
      // 時計は毎回片づける。行が先に来たとき残しておくと、`/exit` の後も時計が切れるまで（既定 30 秒）終わらなかった
      let clock: ReturnType<typeof setTimeout> | undefined;
      const timer = new Promise<'idle'>((r) => { clock = setTimeout(() => r('idle'), idleMs); });
      const winner = await Promise.race([line.then(() => 'line' as const), timer]);
      clearTimeout(clock);
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

  /**
   * いま訊いたことへの答えを、これから打たれる行で受ける（承認の [y/N]）。**溜まっている行は使わない。**
   *
   * `question` は溜まっている行から先に取るので、作業の最中に次の依頼を打っておくと、承認の問いがその依頼を答えとして食べていた
   * （`y` でないので断られ、次の依頼も消える）。溜まっている行は次の依頼のために残す。入力が閉じていれば答え無し（許可しない）。
   */
  async askNow(prompt: string): Promise<string | undefined> {
    if (this.#closed) return undefined;
    this.#output.write(prompt);
    return new Promise<string | undefined>((resolve) => { this.#waiting = resolve; });
  }

  /**
   * 待っている問いを「答え無し」で解く（Ctrl-C で止めたとき）。解かないと、承認の問いが Enter を押すまで待ち続け、
   * 止めたのに先へ進まなかった。答え無しは、承認では「許可しない」になる。
   */
  cancelWaiting(): void {
    const waiter = this.#waiting;
    if (!waiter) return;
    this.#waiting = undefined;
    waiter(undefined);
  }

  close(): void {
    this.#rl.close();
    if (this.#onProcessSigint) process.off('SIGINT', this.#onProcessSigint);
    this.#onProcessSigint = undefined;
  }
}

/** 二度押しとみなす間合い。 */
const SIGINT_TWICE_MS = 2_000;
