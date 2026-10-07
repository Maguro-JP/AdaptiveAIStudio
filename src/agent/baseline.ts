/**
 * ベースラインの一度きり実行。
 *
 * 「元から壊れていたか」を知るための検査は、作業のたびに流す必要がない。
 * 作業前の状態は作業をしても変わらないからで、
 * 毎回流すと実機（全件242秒）では指示のたびに4分待たされることになる。
 *
 * そこで
 *   ・同じ場所・同じ命令なら**一度だけ**流して覚えておく
 *   ・時間上限を別に設ける（全件が長いなら「分からない」で切り上げる)
 * の2つで抑える。
 *
 * 「分からない」は失敗ではない。切り分けができないだけなので、
 * 作業後の失敗を今回のせいにも前からのせいにもしない。
 */
import { runVerification, type VerifyResult } from './verify.ts';

export type BaselineStatus = 'passed' | 'failed' | 'unknown';

export interface BaselineOutcome {
  status: BaselineStatus;
  /** 打ち切り・失敗時は無い。verifyLoop へ渡せるのはこれがある場合だけ。 */
  result?: VerifyResult;
  /** 覚えていた結果を返したか。画面に「(前回の結果)」と出すために使う。 */
  cached: boolean;
  /** unknown の理由。 */
  reason?: string;
  /** 止められた回（■）。待っていた別の会話は、これを受け取らずに自分で測り直す */
  aborted?: boolean;
}

export interface BaselineOptions {
  /** ベースラインだけの時間上限。既定2分。検証本体の上限とは別に持つ。 */
  timeoutMs?: number;
  /** 覚えておく時間。既定30分。長い作業の途中で古くなりすぎないように。 */
  maxAgeMs?: number;
  now?: () => number;
}

interface Entry {
  at: number;
  outcome: BaselineOutcome;
}

export const DEFAULT_BASELINE_TIMEOUT_MS = 120_000;
export const DEFAULT_BASELINE_MAX_AGE_MS = 30 * 60_000;

export class BaselineProbe {
  readonly #root: string;
  readonly #timeoutMs: number;
  readonly #maxAgeMs: number;
  readonly #now: () => number;
  readonly #done = new Map<string, Entry>();
  readonly #inFlight = new Map<string, Promise<BaselineOutcome>>();

  constructor(root: string, opts: BaselineOptions = {}) {
    this.#root = root;
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_BASELINE_TIMEOUT_MS;
    this.#maxAgeMs = opts.maxAgeMs ?? DEFAULT_BASELINE_MAX_AGE_MS;
    this.#now = opts.now ?? Date.now;
  }

  /** 覚えている結果があればそれを返す。無ければ一度だけ流す。 */
  async measure(command: string, signal: AbortSignal): Promise<BaselineOutcome> {
    const remembered = this.#done.get(command);
    if (remembered && this.#now() - remembered.at < this.#maxAgeMs) {
      return { ...remembered.outcome, cached: true };
    }

    // 同時に来た依頼で二重に流さない。待つのは自分の ■ でやめられる（前は相手が終わるまで、上限の 2 分まで待った）
    const running = this.#inFlight.get(command);
    if (running) {
      const got = await untilAborted(running, signal);
      if (got === undefined) return { status: 'unknown', cached: false, aborted: true, reason: '止めたので、作業前の確かめは見ていません。' };
      // 相手の会話が止めた回は受け取らない（止められた途中の結果を「作業前から落ちていた」として受け取っていた）。自分で測り直す
      if (got.aborted) return this.#runShared(command, signal);
      return { ...got, cached: true };
    }
    return this.#runShared(command, signal);
  }

  /** 自分で流す。流している間に来た同じ命令の依頼は、これを待つ。 */
  async #runShared(command: string, signal: AbortSignal): Promise<BaselineOutcome> {
    const task = this.#run(command, signal);
    this.#inFlight.set(command, task);
    try {
      return await task;
    } finally {
      if (this.#inFlight.get(command) === task) this.#inFlight.delete(command);
    }
  }

  async #run(command: string, signal: AbortSignal): Promise<BaselineOutcome> {
    let outcome: BaselineOutcome;
    try {
      const result = await runVerification(
        { command, root: this.#root, commandTimeoutMs: this.#timeoutMs }, signal,
      );
      outcome = result.timedOut
        ? {
            status: 'unknown', cached: false,
            reason: `作業前の検査が${Math.round(this.#timeoutMs / 1000)}秒で終わらないため、切り上げました。`
              + '前からの失敗かどうかは切り分けません。',
          }
        : signal.aborted
          // 止められた回は、落ちたのではない（途中で止めたテストは、通ったか分からない）
          ? { status: 'unknown', cached: false, aborted: true, reason: '止めたので、作業前の確かめを途中でやめました。' }
          : { status: result.passed ? 'passed' : 'failed', result, cached: false };
    } catch (e) {
      outcome = {
        status: 'unknown', cached: false,
        reason: `作業前の検査を実行できませんでした: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    // 打ち切りも覚える。毎回同じだけ待たされては意味がない。
    if (!signal.aborted) this.#done.set(command, { at: this.#now(), outcome });
    return outcome;
  }

  /** 覚えた結果を捨てる。外から作業木が入れ替わったときに使う。 */
  invalidate(command?: string): void {
    if (command === undefined) this.#done.clear();
    else this.#done.delete(command);
  }

  /**
   * 作業後の確かめの結果を、次の回の「前」として覚える。
   *
   * 覚えているのが作業前の測りだけだと、前の回が落ちる姿のまま残した作業場でも
   * 「前は通っていた」のままになる。回の終わりに分かった姿を書き戻して、
   * 「この回より前」が本当に直前の姿になるようにする。
   */
  note(command: string, result: VerifyResult): void {
    this.#done.set(command, {
      at: this.#now(),
      outcome: { status: result.passed ? 'passed' : 'failed', result, cached: false },
    });
  }

  /** 流さずに、覚えている結果だけを見る。 */
  remembered(command: string): BaselineOutcome | undefined {
    const e = this.#done.get(command);
    if (!e || this.#now() - e.at >= this.#maxAgeMs) return undefined;
    return { ...e.outcome, cached: true };
  }
}

/** 約束が解けるか、合図が鳴るまで待つ。合図が先なら undefined。 */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise<T | undefined>((resolve, reject) => {
    const onAbort = () => resolve(undefined);
    signal.addEventListener('abort', onAbort, { once: true });
    p.then((v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e: unknown) => { signal.removeEventListener('abort', onAbort); reject(e); });
  });
}
