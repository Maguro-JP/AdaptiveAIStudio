/**
 * 作業前検査の一度きり実行。
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
}

export interface BaselineOptions {
  /** 作業前検査だけの時間上限。既定2分。検証本体の上限とは別に持つ。 */
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

    // 同時に来た依頼で二重に流さない。
    const running = this.#inFlight.get(command);
    if (running) return { ...(await running), cached: true };

    const task = this.#run(command, signal);
    this.#inFlight.set(command, task);
    try {
      return await task;
    } finally {
      this.#inFlight.delete(command);
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

  /** 流さずに、覚えている結果だけを見る。 */
  remembered(command: string): BaselineOutcome | undefined {
    const e = this.#done.get(command);
    if (!e || this.#now() - e.at >= this.#maxAgeMs) return undefined;
    return { ...e.outcome, cached: true };
  }
}
