/**
 * コマンド実行の共通部。
 * ツール(run_command)と検証ループの両方から使う。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { decodeText } from '../core/text.ts';
import { envForChild } from '../core/env.ts';

/**
 * 実行中の一群を根ごと止める。
 *
 * `child.kill()` だけでは殻(sh / cmd.exe)しか死なず、
 * その下の `node --test` などは生き残って走り続ける。
 * 時間上限を設けても効かなくなるので、必ず一群として止める。
 */
function killTree(child: ChildProcess, platform: NodeJS.Platform = process.platform): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (platform === 'win32') {
    // Windows には処理群が無いので、木をたどって落とす。
    const plan = killPlan(pid, platform);
    spawn(plan.command, plan.args, { stdio: 'ignore' }).on('error', () => child.kill());
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
    // 行儀よく終わらない相手のために、少し待って確実に落とす。
    const hard = setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* 既に終了 */ } }, 2000);
    hard.unref();
  } catch {
    child.kill();
  }
}

/**
 * 止め方の組み立て。
 *
 * 分岐を関数として取り出しているのは、**Windows の側を試験するため**。
 * 手元も CI も Linux だと、win32 の分岐は一度も実行されないまま配られる。
 * 実際に「Linux では通るが Windows では落ちる」を踏んだので、
 * せめて組み立ての内容だけは、どちらの側も試験で押せるようにしておく。
 */
export function killPlan(pid: number, platform: NodeJS.Platform): { command: string; args: string[] } {
  if (platform === 'win32') {
    // /T で子孫ごと、/F で強制。これが無いと殻の下の本体が生き残る。
    return { command: 'taskkill', args: ['/pid', String(pid), '/T', '/F'] };
  }
  return { command: 'kill', args: ['-TERM', String(-pid)] };
}

/**
 * 起動の組み立て。こちらも同じ理由で取り出してある。
 *
 * Windows は殻を cmd.exe に任せる（shell: true）。
 * それ以外は処理群を作って、上限で打ち切るときに
 * 殻の下の本体まで一緒に止められるようにする。
 */
export function spawnPlan(command: string, platform: NodeJS.Platform): {
  file: string; args: string[]; shell: boolean; detached: boolean;
} {
  if (platform === 'win32') {
    return { file: command, args: [], shell: true, detached: false };
  }
  return { file: '/bin/sh', args: ['-c', command], shell: false, detached: true };
}

/**
 * `spawn` に渡すもの。**どちらの道でも `env` を渡す**ことを、試験で押せる形にする。
 *
 * ここは殻を使う道（Windows）と使わない道（それ以外）で `spawn` の呼び方が違う。
 * 片方にだけ `env` を渡して、もう片方を素のままにしても、**走らせている機械の
 * 道しか通らないので気づけない**（実際、Windows の道は linux では一度も通らない）。
 * 呼び方を作る所を一つにして、両方まとめて見る。
 */
export function spawnCall(
  plan: { file: string; args: string[]; shell: boolean; detached: boolean },
  cwd: string,
  env: Record<string, string>,
): {
  file: string;
  /** 殻を使う道では渡さない（命令の文をそのまま殻へ渡す）。 */
  args?: string[];
  options: { cwd: string; env: Record<string, string>; shell?: boolean; detached?: boolean };
} {
  return plan.shell
    ? { file: plan.file, options: { cwd, shell: true, env } }
    : { file: plan.file, args: plan.args, options: { cwd, detached: plan.detached, env } };
}

export interface ExecResult {
  code: number | null;
  output: string;
  durationMs: number;
  timedOut: boolean;
  aborted: boolean;
}

export function execCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
  maxOutputBytes = 200_000,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const plan = spawnPlan(command, process.platform);
    /*
     * **トークンを子へ渡さない。**
     *
     * `env` を渡していなかったので、親の環境変数がそのまま全部子へ行っていた。
     * 許可している命令に `echo` と `cat` が在るので、**`echo $GITHUB_TOKEN` 一つで
     * トークンが読める**（出力はモデルの履歴と会話の記録に入る。遠くのモデルを
     * 候補に入れていれば、そこへも出て行く）。渡す環境は `envForChild` で作る。
     */
    const call = spawnCall(plan, cwd, envForChild());
    const child = call.args
      ? spawn(call.file, call.args, call.options)
      : spawn(call.file, call.options);

    // 文字に直すのは**最後に一度**。cmd の出力は日本語の Windows では CP932 で
    // 来るので、塊ごとに UTF-8 と決めて読むと丸ごと化ける。全部揃ってから
    // UTF-8 か CP932 かを見る（src/core/text.ts の decodeText）。
    const chunks: Buffer[] = [];
    let held = 0;
    const out = () => {
      let text = decodeOutput(Buffer.concat(chunks));
      if (text.length > maxOutputBytes) text = text.slice(-maxOutputBytes);
      return text;
    };
    let settled = false;
    const finish = (r: Omit<ExecResult, 'durationMs'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve({ ...r, durationMs: Date.now() - startedAt });
    };

    const timer = setTimeout(() => {
      killTree(child);
      finish({ code: null, output: out(), timedOut: true, aborted: false });
    }, timeoutMs);

    const onAbort = () => {
      killTree(child);
      finish({ code: null, output: out(), timedOut: false, aborted: true });
    };
    signal.addEventListener('abort', onAbort, { once: true });

    const append = (b: Buffer) => {
      chunks.push(b);
      held += b.length;
      // 出力が暴走しても壊れないよう、末尾だけ残す。塊ごと落とす
      // （途中で切ると文字の途中になる。頭の一文字は decodeOutput が拾う）。
      while (held > maxOutputBytes * 2 && chunks.length > 1) held -= chunks.shift()!.length;
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    child.on('error', (e) => finish({ code: null, output: `${out()}\n${e.message}`, timedOut: false, aborted: false }));
    child.on('close', (code) => finish({ code, output: out(), timedOut: false, aborted: false }));
  });
}

/**
 * 集めた出力を文字にする。
 *
 * 末尾だけ残すときに塊ごと落としているので、先頭が文字の途中から
 * 始まることがある。その1〜3バイトを捨てれば残りは読めるので、
 * 化ける前に少しずらして試す。
 */
export function decodeOutput(raw: Buffer): string {
  for (let skip = 0; skip <= 3 && skip < raw.length; skip++) {
    const r = decodeText(raw.subarray(skip));
    if (!r.lossy) return r.text;
  }
  return decodeText(raw).text;
}

/** 出力の末尾だけを残す。失敗の原因は末尾にあることが多い。 */
export function tailOf(s: string, max = 6000): string {
  return s.length > max ? `...(前略)\n${s.slice(-max)}` : s;
}
