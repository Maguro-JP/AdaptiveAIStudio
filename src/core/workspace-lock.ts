/**
 * 作業場の錠。書く依頼は、これを持っている間だけ作業場を変える。
 *
 * 画面で二つの会話を同時に動かすと、どちらも同じ作業場へ書き得る。二つが同時に書くと、
 * 互いの書き込みを「外のツールの変化」と読み違え、巻き戻しで相手の仕事まで戻し、「戻す」の記録も混ざる
 * （DECISIONS 09-26）。書く手を初めて使う時点で錠を取り、依頼の終わりまで持つ。読むだけの会話は取らない。
 *
 * 待つ順は来た順。止められた待ち手は列から抜ける（錠を取らずに投げる）。
 * 同じ持ち主がもう一度取りに来たら、すぐ返す（一つの依頼の中で何度書いても待たない）。
 */
export class WorkspaceLock {
  #owner: string | undefined;
  readonly #waiters: Array<{ owner: string; grant: () => void }> = [];

  /** いまの持ち主。誰も持っていなければ undefined。 */
  get owner(): string | undefined { return this.#owner; }

  get held(): boolean { return this.#owner !== undefined; }

  /** 待っている数。画面で「待っています」と言うために使う。 */
  get waiting(): number { return this.#waiters.length; }

  /**
   * 取る。空いていればすぐ、持ち主が同じならすぐ、そうでなければ空くまで待つ。
   * `signal` が止められたら、待つのをやめて投げる（錠は取っていない）。
   */
  acquire(owner: string, signal?: AbortSignal): Promise<void> {
    if (this.#owner === undefined || this.#owner === owner) {
      this.#owner = owner;
      return Promise.resolve();
    }
    if (signal?.aborted) return Promise.reject(new Error('止められたので、作業場の錠を待つのをやめました'));
    return new Promise<void>((resolve, reject) => {
      const waiter = { owner, grant: () => { signal?.removeEventListener('abort', onAbort); resolve(); } };
      const onAbort = () => {
        const at = this.#waiters.indexOf(waiter);
        if (at >= 0) this.#waiters.splice(at, 1);
        reject(new Error('止められたので、作業場の錠を待つのをやめました'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#waiters.push(waiter);
    });
  }

  /**
   * 待たずに取る。空いていれば（持ち主が同じでも）取って true、ほかが持っていれば false。
   * 画面の手書き（保存・差分からの戻し・「戻す」）は、AI の作業が終わるまで待たせずに断るので、こちらを使う。
   */
  tryAcquire(owner: string): boolean {
    if (this.#owner !== undefined && this.#owner !== owner) return false;
    this.#owner = owner;
    return true;
  }

  /** 返す。持ち主でなければ何もしない（二度返しても壊れない）。次の待ち手へ渡す。 */
  release(owner: string): void {
    if (this.#owner !== owner) return;
    const next = this.#waiters.shift();
    this.#owner = next?.owner;
    next?.grant();
  }
}
