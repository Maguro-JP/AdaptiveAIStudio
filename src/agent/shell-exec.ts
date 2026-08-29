/**
 * コマンド実行の共通部。
 * ツール(run_command)と検証ループの両方から使う。
 */
import { spawn } from 'node:child_process';

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
      : spawn('/bin/sh', ['-c', command], { cwd });

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
      child.kill();
      finish({ code: null, output: out, timedOut: true, aborted: false });
    }, timeoutMs);

    const onAbort = () => {
      child.kill();
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
