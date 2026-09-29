/**
 * 自動書き込みの安全網は Git。
 * 未コミットの変更がある状態で自動書き込みを始めると、
 * 巻き戻し先が無くなるため、開始前に必ず確認する。
 */
import { spawn } from 'node:child_process';
import { chunkReader } from '../core/text.ts';

export type GitState =
  | { kind: 'clean'; branch: string }
  | { kind: 'dirty'; branch: string; changed: string[] }
  | { kind: 'notRepo' }
  | { kind: 'unavailable'; reason: string };

export async function inspectGit(root: string): Promise<GitState> {
  const status = await runGit(['status', '--porcelain', '--branch'], root);
  if (status.code !== 0) {
    if (/not a git repository/i.test(status.out)) return { kind: 'notRepo' };
    return { kind: 'unavailable', reason: status.out.trim().split('\n')[0] ?? 'git を実行できません' };
  }

  const lines = status.out.split('\n').filter((l) => l.length > 0);
  const branchLine = lines.find((l) => l.startsWith('##')) ?? '## (不明)';
  const branch = branchLine.replace(/^##\s*/, '').split(/\.{3}|\s/)[0] ?? '(不明)';
  const changed = lines.filter((l) => !l.startsWith('##')).map((l) => l.slice(3));

  return changed.length === 0 ? { kind: 'clean', branch } : { kind: 'dirty', branch, changed };
}

export function describeGitState(state: GitState): { text: string; risky: boolean } {
  switch (state.kind) {
    case 'clean':
      return { text: `git: ${state.branch} (クリーン) — 変更はいつでも巻き戻せます`, risky: false };
    case 'dirty':
      return {
        text: `git: ${state.branch} に未コミットの変更が ${state.changed.length} 件あります` +
              ` — 自動書き込みで失われる可能性があります`,
        risky: true,
      };
    case 'notRepo':
      return { text: 'git 管理下ではありません — 変更を巻き戻せません', risky: true };
    case 'unavailable':
      return { text: `git を確認できません (${state.reason})`, risky: true };
  }
}

/** git を呼ぶ。更新の仕組みからも使う。 */
export function runGit(args: string[], cwd: string): Promise<{ code: number; out: string }> {
  return runWithin('git', args, cwd, GIT_TIMEOUT_MS, {
    // 資格情報を訊かせない（端末の入力待ち・Windows の資格情報を訊く画面で、返らないまま止まる）。訊かれる場面は失敗として返る
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
  });
}

/**
 * git を待つ上限。取得（fetch）（fetch）が途中で止まっても、git は既定で打ち切らない。画面の更新の口・CLI の /update が返らないまま
 * 固まっていた。遅い回線でも取り終わる長さにしておく。
 */
export const GIT_TIMEOUT_MS = 5 * 60_000;

/** 命令を走らせ、`timeoutMs` を過ぎたら打ち切って `code: -1` で返す。 */
export function runWithin(
  cmd: string, args: string[], cwd: string, timeoutMs: number, env: Record<string, string> = {},
): Promise<{ code: number; out: string }> {
  return new Promise<{ code: number; out: string }>((resolve) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env } });
    let out = '';
    let settled = false;
    const finish = (r: { code: number; out: string }) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => {
      child.kill();
      finish({ code: -1, out: `${out}\n${Math.round(timeoutMs / 1000)} 秒たっても終わらないので打ち切りました` });
    }, timeoutMs);
    const append = (read: (c: Buffer) => string) => (b: Buffer) => { out += read(b); };
    child.stdout?.on('data', append(chunkReader()));
    child.stderr?.on('data', append(chunkReader()));
    child.on('error', (e) => finish({ code: -1, out: e.message }));
    child.on('close', (code) => finish({ code: code ?? -1, out }));
  });
}
