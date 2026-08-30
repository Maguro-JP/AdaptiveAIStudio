/**
 * コマンド実行の共通部。
 * ツール(run_command)と検証ループの両方から使う。
 */
import { spawn, type ChildProcess } from 'node:child_process';

/**
 * 実行中の一群を根ごと止める。
 *
 * `child.kill()` だけでは殻(sh / cmd.exe)しか死なず、
 * その下の `node --test` などは生き残って走り続ける。
 * 時間上限を設けても効かなくなるので、必ず一群として止める。
 */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    // Windows には処理群が無いので、木をたどって落とす。
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
      .on('error', () => child.kill());
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
    const isWindows = process.platform === 'win32';
    const child = isWindows
      ? spawn(command, { cwd, shell: true })
      // 処理群を作る。上限で打ち切るとき、殻の下の本体まで止められるように。
      : spawn('/bin/sh', ['-c', command], { cwd, detached: true });

    let out = '';
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
      finish({ code: null, output: out, timedOut: true, aborted: false });
    }, timeoutMs);

    const onAbort = () => {
      killTree(child);
      finish({ code: null, output: out, timedOut: false, aborted: true });
    };
    signal.addEventListener('abort', onAbort, { once: true });

    const append = (b: Buffer) => {
      out += b.toString();
      // 出力が暴走しても壊れないよう、末尾だけ残す
      if (out.length > maxOutputBytes) out = out.slice(-maxOutputBytes);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    child.on('error', (e) => finish({ code: null, output: `${out}\n${e.message}`, timedOut: false, aborted: false }));
    child.on('close', (code) => finish({ code, output: out, timedOut: false, aborted: false }));
  });
}

/** 出力の末尾だけを残す。失敗の原因は末尾にあることが多い。 */
export function tailOf(s: string, max = 6000): string {
  return s.length > max ? `...(前略)\n${s.slice(-max)}` : s;
}
