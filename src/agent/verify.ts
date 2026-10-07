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
import { runLoop, type LoopCheck } from '../harness/loop.ts';

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
  | { type: 'giveUp'; reason: 'maxRounds' | 'noProgress' | 'timeBudget' | 'aborted' | 'unsure'; detail: string };

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
      /*
       * node:test は数字を後ろに書く（TAP の `duration_ms: 1.37` と `# duration_ms 125.6`、spec の `ℹ duration_ms 125.6`）。
       * 前に書く形しか落としていなかったので、node:test の作業場では同じ失敗が毎回別物になり、「作業前から」と判定できず、
       * 関係ない失敗を直させ続けていた（同じ失敗を 2 回回して測った）。
       */
      .replace(/duration_ms[:\s]+\d+(\.\d+)?/g, 'duration_ms N')
      .replace(/\d+(\.\d+)?\s*ms\b/g, 'Nms')
      .replace(/\d+(\.\d+)?\s*s\b/g, 'Ns')
      // 時刻（vitest の `Start at 10:21:33`、pytest の `(0:01:02)`）と、go の結果を使い回した表示（`(cached)`）も毎回変わる
      .replace(/\b(Start at\s+)\d{1,2}:\d{2}:\d{2}(?:\.\d+)?/g, '$1HH:MM:SS').replace(/\(\d+:\d{2}:\d{2}(?:\.\d+)?\)/g, '(H:MM:SS)')
      .replace(/\(cached\)/g, 'Ns')
      .replace(/\/tmp\/[\w.-]+/g, '/tmp/X')
      // Windows の一時フォルダ（`C:\Users\me\AppData\Local\Temp\aas-x1`。出力の中では `\\` に重なることもある）。
      // 利用者名に空白が入る（`C:\Users\John Smith\...`）ので、間は空白も含めて取る（引用符と改行の手前まで）
      .replace(/[A-Za-z]:(?:\\{1,2}|\/)(?:[^'"`\r\n]*?(?:\\{1,2}|\/))?Temp(?:\\{1,2}|\/)[\w.-]+/gi, 'TMP/X'));
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
  /** 試験は通ったが、テストを読めず、減っていないかを確かめられなかった。失敗でも合格でもない */
  unsure?: string;
}

/**
 * 検証ループを回す。
 *
 * `fix` は「失敗内容を渡して直させる」呼び出し。
 * Agent でも Team でも差し替えられるよう、関数として受け取る。
 */
/** ループエンジンへ渡す検査結果。 */
interface VerifyCheck extends LoopCheck {
  result?: VerifyResult;
  tampered?: string;
  preexisting?: boolean;
  /** テストを読めなかった（読み直しても）。モデルに直させるものではない */
  unsure?: string;
}

/** テストを読み直す回数と間。一瞬掴まれていた（ウイルス対策・同期）だけなら、これで読める */
const UNSURE_RETRIES = 2;
const UNSURE_WAIT_MS = 300;

/**
 * 検証ループ。
 *
 * 打ち切り条件（回数・時間・停滞）はループエンジンが持つ。
 * ここが持つのは「何を検査するか」と「何を差し戻すか」だけ。
 */
export async function* verifyLoop(
  opts: VerifyOptions,
  fix: (feedback: string, signal: AbortSignal) => Promise<void>,
  signal: AbortSignal,
  baselineTests?: TestSnapshot,
  baseline?: VerifyResult,
): AsyncGenerator<VerifyEvent, LoopOutcome> {
  const before = baselineTests ?? await snapshotTests(opts.root);
  let preexistingFailure = false;
  let last: VerifyResult | undefined;

  const check = async (round: number): Promise<VerifyCheck> => {
    const result = await runVerification(opts, signal);
    last = result;

    if (result.passed) {
      // 通ったように見えても、テストが減っていれば通過とみなさない
      let verdict = compareTests(before, await snapshotTests(opts.root));
      /*
       * テストを読めなかった。合格にはしないが、**モデルに直させない**（直すものが無い）。少し待って読み直し、
       * それでも読めなければ「確かめられなかった」で終える。前は直させに戻し、同じ要約が続いて打ち切られ、
       * 送り口では「失敗」として巻き戻しの対象にしていた（段取りと外のツールの道は「確かめられなかった・戻さない」）
       */
      for (let i = 0; verdict.ok && verdict.unsure && i < UNSURE_RETRIES && !signal.aborted; i += 1) {
        await new Promise((r) => setTimeout(r, UNSURE_WAIT_MS));
        verdict = compareTests(before, await snapshotTests(opts.root));
      }
      if (!verdict.ok) {
        return {
          passed: false, digest: `tampered:${verdict.reason}`,
          feedback: verdict.reason, tampered: verdict.reason, result,
        };
      }
      // 読み直しの最中に止められたときは、ループが結果を見る前に「止めた」で終える（`harness/loop.ts`）。ここで分けなくてよい
      if (verdict.unsure) {
        return { passed: false, digest: `unreadable:${verdict.unsure}`, unsure: verdict.unsure, result };
      }
      return { passed: true, digest: 'passed', result };
    }

    // 時間切れは落ちたのではない。直させず「確かめられなかった」で終える（段取りの道と同じ。前は「無限ループを疑って」と直させ、
    // 上限まで回してから落ちた扱いにし、長いテストの作業場では正しい変更まで巻き戻しえた）
    if (result.timedOut) {
      return { passed: false, digest: 'timeout', unsure: `確かめが時間内に終わりませんでした（${opts.command}）`, result };
    }

    const digest = digestFailure(result.output);

    // 作業前と同じ失敗なら、この作業が原因ではない
    // 何回目でも比べる（1 回目だけ比べていたので、新しい失敗を直して作業前と同じ失敗だけになった回を、作業前からと言えなかった）
    if (baseline && !baseline.passed
        && digestFailure(baseline.output) === digest) {
      // 落ちたテストを消して作業前と同じ失敗に戻した回を、作業前からと言わない（減っていれば、消して通したのと同じ扱い）
      const verdict = compareTests(before, await snapshotTests(opts.root));
      if (!verdict.ok) {
        return {
          passed: false, digest: `tampered:${verdict.reason}`,
          feedback: verdict.reason, tampered: verdict.reason, result,
        };
      }
      preexistingFailure = true;
      return { passed: false, digest, preexisting: true, result };
    }

    return { passed: false, digest, feedback: feedbackFor(result, opts.command, round), result };
  };

  const gen = runLoop<VerifyCheck>(
    {
      name: 'verify',
      maxRounds: opts.maxRounds ?? 5,
      timeBudgetMs: opts.timeBudgetMs,
      stallLimit: 3,
    },
    check,
    (feedback, _round, sig) => fix(feedback, sig),
    signal,
  );

  let next = await gen.next();
  let rounds = 0;

  while (!next.done) {
    const ev = next.value;
    if (ev.type === 'round') {
      rounds = ev.round;
      yield { type: 'running', round: ev.round, command: opts.command };
    } else if (ev.type === 'checked') {
      const c = ev.check;
      if (c.preexisting) {
        yield { type: 'preexisting', digest: c.digest };
        // これ以上回しても直らないので、ここで終える
        return {
          passed: false, rounds: ev.round, last, preexistingFailure: true,
          reason: '作業前から同じ失敗が出ています。この作業が原因ではありません。',
        };
      }
      if (c.unsure) {
        yield { type: 'giveUp', reason: 'unsure', detail: c.unsure };
        // 直させても直るものではないので、ここで終える
        return { passed: false, rounds: ev.round, last, preexistingFailure, unsure: c.unsure, reason: c.unsure };
      }
      if (c.tampered) yield { type: 'tampered', reason: c.tampered };
      else if (c.passed) yield { type: 'passed', round: ev.round, durationMs: c.result?.durationMs ?? 0 };
      else yield { type: 'failed', round: ev.round, digest: c.digest };
    } else if (ev.type === 'retrying') {
      yield { type: 'fixing', round: ev.round };
    } else if (ev.type === 'stopped' && ev.reason !== 'passed') {
      yield {
        type: 'giveUp',
        reason: ev.reason === 'noProgress' ? 'noProgress'
          : ev.reason === 'timeBudget' ? 'timeBudget'
          : ev.reason === 'aborted' ? 'aborted' : 'maxRounds',
        detail: ev.detail,
      };
    }
    next = await gen.next();
  }

  const result = next.value;
  return {
    passed: result.passed,
    rounds: result.rounds || rounds,
    last,
    preexistingFailure,
    reason: result.passed ? undefined : result.detail,
  };
}
