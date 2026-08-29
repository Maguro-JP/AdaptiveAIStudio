/**
 * 自己検証ループ — 書いて終わりにしない。
 *
 *   実装 → テスト実行 → 失敗なら原因を渡して直させる → 再実行
 *
 * ローカルは計算が無料なので、この往復を無人で何度でも回せる。
 * **時間で品質を買う**手段であり、賢さで劣るローカルモデルの主要な埋め合わせ。
 *
 * ただし放置すると壊れ方が2つある。
 *   1. テストを消して「通した」ことにする  → test-integrity で検出
 *   2. 同じ失敗を延々と繰り返す            → 進捗判定で打ち切る
 */
import { execCommand, tailOf } from './shell-exec.ts';
import { snapshotTests, compareTests, type TestSnapshot } from './test-integrity.ts';

export interface VerifyResult {
  passed: boolean;
  output: string;
  durationMs: number;
  timedOut: boolean;
}

export type VerifyEvent =
  | { type: 'preexisting'; digest: string }
  | { type: 'running'; round: number; command: string }
  | { type: 'passed'; round: number; durationMs: number }
  | { type: 'failed'; round: number; digest: string }
  | { type: 'tampered'; reason: string }
  | { type: 'fixing'; round: number }
  | { type: 'giveUp'; reason: 'maxRounds' | 'noProgress' | 'timeBudget' | 'aborted'; detail: string };

export interface VerifyOptions {
  command: string;
  root: string;
  /** 最大の往復回数 */
  maxRounds?: number;
  /** 1回のテスト実行の上限 */
  commandTimeoutMs?: number;
  /** ループ全体の上限。無人実行でも青天井にはしない。 */
  timeBudgetMs?: number;
}

/** 検証を1回実行する。 */
export async function runVerification(
  opts: Pick<VerifyOptions, 'command' | 'root' | 'commandTimeoutMs'>,
  signal: AbortSignal,
): Promise<VerifyResult> {
  const r = await execCommand(
    opts.command, opts.root, opts.commandTimeoutMs ?? 600_000, signal,
  );
  return {
    passed: r.code === 0,
    output: r.output,
    durationMs: r.durationMs,
    timedOut: r.timedOut,
  };
}

/**
 * 失敗の要約。毎回全文を渡すと文脈を食い潰すので末尾だけにする。
 * 進捗判定にも使うため、実行ごとに変わる値（所要時間など）は含めない。
 */
export function digestFailure(output: string): string {
  const lines = output.split('\n')
    .filter((l) => l.trim().length > 0)
    // 実行のたびに変わる部分は落とす。同じ失敗を同じと判定できるように。
    .map((l) => l
      .replace(/\d+(\.\d+)?\s*ms\b/g, 'Nms')
      .replace(/\d+(\.\d+)?\s*s\b/g, 'Ns')
      .replace(/\/tmp\/[\w.-]+/g, '/tmp/X'));
  return lines.slice(-40).join('\n');
}

/** 作業者へ返す指示文。 */
export function feedbackFor(result: VerifyResult, command: string, round: number): string {
  if (result.timedOut) {
    return `\`${command}\` が時間内に終わりませんでした（${round}回目）。` +
      `無限ループや待ち合わせを疑ってください。\n\n${tailOf(result.output, 4000)}`;
  }
  return `\`${command}\` が失敗しました（${round}回目）。以下の出力を読んで原因を直してください。\n\n` +
    `${tailOf(result.output, 6000)}\n\n` +
    'テストを削除・skip して通すことは認められません。実装側を直してください。';
}

export interface LoopOutcome {
  passed: boolean;
  rounds: number;
  /** 最後の検証結果 */
  last?: VerifyResult;
  /** 作業前から失敗していたか */
  preexistingFailure: boolean;
  reason?: string;
}

/**
 * 検証ループを回す。
 *
 * `fix` は「失敗内容を渡して直させる」呼び出し。
 * Agent でも Team でも差し替えられるよう、関数として受け取る。
 */
export async function* verifyLoop(
  opts: VerifyOptions,
  fix: (feedback: string, signal: AbortSignal) => Promise<void>,
  signal: AbortSignal,
  /** 作業開始前に取っておいたテストの状態 */
  baselineTests?: TestSnapshot,
  /**
   * 作業開始前の検証結果。
   * これが無いと「元から壊れていた」のか「作業で壊した」のかを区別できず、
   * 直せない失敗をモデルに何度も投げることになる。
   */
  baseline?: VerifyResult,
): AsyncGenerator<VerifyEvent, LoopOutcome> {
  const maxRounds = opts.maxRounds ?? 5;
  const budget = opts.timeBudgetMs ?? 60 * 60_000;
  const startedAt = Date.now();

  const before = baselineTests ?? await snapshotTests(opts.root);
  let preexistingFailure = false;
  const digests: string[] = [];
  let last: VerifyResult | undefined;

  for (let round = 1; round <= maxRounds; round += 1) {
    if (signal.aborted) {
      yield { type: 'giveUp', reason: 'aborted', detail: '中断されました。' };
      return { passed: false, rounds: round - 1, last, preexistingFailure };
    }
    if (Date.now() - startedAt > budget) {
      yield { type: 'giveUp', reason: 'timeBudget', detail: `時間上限 ${Math.round(budget / 60000)}分 に達しました。` };
      return { passed: false, rounds: round - 1, last, preexistingFailure };
    }

    yield { type: 'running', round, command: opts.command };
    const result = await runVerification(opts, signal);
    last = result;

    if (result.passed) {
      // 通ったように見えても、テストが減っていれば通過とみなさない
      const verdict = compareTests(before, await snapshotTests(opts.root));
      if (!verdict.ok) {
        yield { type: 'tampered', reason: verdict.reason! };
        if (round >= maxRounds) {
          return { passed: false, rounds: round, last, preexistingFailure, reason: verdict.reason };
        }
        yield { type: 'fixing', round };
        await fix(verdict.reason!, signal);
        continue;
      }
      yield { type: 'passed', round, durationMs: result.durationMs };
      return { passed: true, rounds: round, last, preexistingFailure };
    }

    const digest = digestFailure(result.output);

    // 作業前と同じ失敗なら、この作業が原因ではない。
    // 直せないものをモデルに投げ続けても回数を消費するだけなので、ここで止める。
    if (round === 1 && baseline && !baseline.passed
        && digestFailure(baseline.output) === digest) {
      preexistingFailure = true;
      yield { type: 'preexisting', digest };
      return {
        passed: false, rounds: 1, last, preexistingFailure: true,
        reason: '作業前から同じ失敗が出ています。この作業が原因ではありません。',
      };
    }

    yield { type: 'failed', round, digest };

    // 同じ失敗が3回続いたら、これ以上回しても直らない
    digests.push(digest);
    if (digests.length >= 3 && new Set(digests.slice(-3)).size === 1) {
      const detail = '同じ失敗が3回続きました。原因が掴めていません。';
      yield { type: 'giveUp', reason: 'noProgress', detail };
      return { passed: false, rounds: round, last, preexistingFailure, reason: detail };
    }

    if (round >= maxRounds) break;

    yield { type: 'fixing', round };
    await fix(feedbackFor(result, opts.command, round), signal);
  }

  const detail = `${maxRounds}回試しても通りませんでした。`;
  yield { type: 'giveUp', reason: 'maxRounds', detail };
  return { passed: false, rounds: maxRounds, last, preexistingFailure, reason: detail };
}
