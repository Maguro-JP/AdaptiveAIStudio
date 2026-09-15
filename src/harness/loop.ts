/**
 * ループエンジン — 「やって、確かめて、直す」を部品にする。
 *
 * 自己検証だけが特別なのではない。設計→実装→レビュー、
 * 生成→採点→再生成、修正→再現確認 …… どれも同じ形をしている。
 *
 *   目標を決める → 試す → 確かめる → 駄目なら情報を渡して再挑戦
 *
 * これを毎回書き下ろすと、打ち切り条件や進捗判定を書き忘れる。
 * 忘れると無人実行が暴走する。だから形を固定して、
 * **新しいループを足すときに安全装置が自動で付いてくる**ようにする。
 */

export interface LoopCheck {
  /** 目標に到達したか */
  passed: boolean;
  /**
   * 状態の指紋。同じ指紋が続いたら進んでいないと判断する。
   * 実行ごとに変わる値（時刻・所要時間・一時パス）は含めないこと。
   */
  digest: string;
  /** 失敗時に次の試行へ渡す情報 */
  feedback?: string;
}

export interface LoopOptions {
  /** ループの名前。記録と表示に使う。 */
  name: string;
  /** 最大の試行回数 */
  maxRounds?: number;
  /** ループ全体の時間上限(ms) */
  timeBudgetMs?: number;
  /** 同じ状態が何回続いたら諦めるか */
  stallLimit?: number;
}

export type LoopStopReason = 'passed' | 'maxRounds' | 'noProgress' | 'timeBudget' | 'aborted';

export type LoopEvent<C extends LoopCheck> =
  | { type: 'round'; round: number }
  | { type: 'checked'; round: number; check: C }
  | { type: 'retrying'; round: number; feedback: string }
  | { type: 'stopped'; reason: LoopStopReason; round: number; detail: string };

export interface LoopResult<C extends LoopCheck> {
  passed: boolean;
  rounds: number;
  reason: LoopStopReason;
  detail: string;
  last?: C;
}

/**
 * ループを回す。
 *
 * `check` は現在の状態を確かめる。`attempt` は改善を試みる。
 * 1回目は attempt を呼ばずに check から入る。
 * 既に目標を満たしているなら、何もしないのが正しいため。
 */
export async function* runLoop<C extends LoopCheck>(
  opts: LoopOptions,
  check: (round: number, signal: AbortSignal) => Promise<C>,
  attempt: (feedback: string, round: number, signal: AbortSignal) => Promise<void>,
  signal: AbortSignal,
): AsyncGenerator<LoopEvent<C>, LoopResult<C>> {
  const maxRounds = opts.maxRounds ?? 5;
  const budget = opts.timeBudgetMs ?? 60 * 60_000;
  const stallLimit = opts.stallLimit ?? 3;
  const startedAt = Date.now();

  const digests: string[] = [];
  let last: C | undefined;

  for (let round = 1; round <= maxRounds; round += 1) {
    if (signal.aborted) {
      const detail = '中断されました。';
      yield { type: 'stopped', reason: 'aborted', round: round - 1, detail };
      return { passed: false, rounds: round - 1, reason: 'aborted', detail, last };
    }
    if (Date.now() - startedAt > budget) {
      const detail = `時間上限 ${Math.round(budget / 60_000)}分 に達しました。`;
      yield { type: 'stopped', reason: 'timeBudget', round: round - 1, detail };
      return { passed: false, rounds: round - 1, reason: 'timeBudget', detail, last };
    }

    yield { type: 'round', round };
    const result = await check(round, signal);
    last = result;
    yield { type: 'checked', round, check: result };

    if (result.passed) {
      const detail = `${round}回目で到達しました。`;
      yield { type: 'stopped', reason: 'passed', round, detail };
      return { passed: true, rounds: round, reason: 'passed', detail, last };
    }

    digests.push(result.digest);
    if (digests.length >= stallLimit
        && new Set(digests.slice(-stallLimit)).size === 1) {
      const detail = `同じ状態が${stallLimit}回続きました。進んでいません。`;
      yield { type: 'stopped', reason: 'noProgress', round, detail };
      return { passed: false, rounds: round, reason: 'noProgress', detail, last };
    }

    if (round >= maxRounds) break;

    const feedback = result.feedback ?? '前回の試行では目標に到達しませんでした。';
    yield { type: 'retrying', round, feedback };
    await attempt(feedback, round, signal);
  }

  const detail = `${maxRounds}回試しても到達しませんでした。`;
  yield { type: 'stopped', reason: 'maxRounds', round: maxRounds, detail };
  return { passed: false, rounds: maxRounds, reason: 'maxRounds', detail, last };
}
