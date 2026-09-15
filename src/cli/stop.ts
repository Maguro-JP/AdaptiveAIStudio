/**
 * 止めるときの段取り。
 *
 * 片づけ（`server.stop`）が返ってこないことがある。待ち続けると、
 * **閉じたつもりの画面の裏で、読み込んだモデルごと生き続ける**
 * （数GBを掴んだまま）。上限で諦めて、終わることは終わる。
 *
 * ここを入口（`src/cli/ui.ts`）に直接書いていたので、確かめ方が
 * 「入口に `setTimeout` と `process.exit` の字が在る」になっていた。
 * **字が在ることは、押したときに終わることを言わない。**
 * 終わらせ方（`exit`）と片づけ（`stop`）を渡せる形にして、
 * 返ってこない片づけでも終わることを、動かして見られるようにする。
 */
export interface StopPlan {
  /** 片づけ。**返ってこないことがある。** */
  stop: (log: (line: string) => void) => Promise<unknown>;
  /** 終わらせ方。試験では控えるだけにする。 */
  exit: (code: number) => void;
  log: (line: string) => void;
  /** 片づけを待つ上限。 */
  waitMs?: number;
}

/** Ctrl-C / SIGTERM で呼ぶもの。二度押されたら、そのまま終わる。 */
export function createStopper({ stop, exit, log, waitMs = 5000 }: StopPlan): () => void {
  let stopping = false;
  return () => {
    if (stopping) {
      log('  もう一度押されたので、そのまま終わります。');
      exit(0);
      return;
    }
    stopping = true;
    log('  止めています…');
    const giveUp = setTimeout(() => {
      log(`  片づけが ${waitMs / 1000} 秒で終わらないので、そのまま終わります。`);
      exit(0);
    }, waitMs);
    giveUp.unref?.();
    void stop((line) => log(`  ${line}`)).catch(() => undefined).then(() => {
      // 片づけが終わったら、上限の方は取り下げる。
      clearTimeout(giveUp);
      exit(0);
    });
  };
}
