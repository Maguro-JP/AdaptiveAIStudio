/**
 * 自動書き込みの安全網は Git。
 * 未コミットの変更がある状態で自動書き込みを始めると、
 * 巻き戻し先が無くなるため、開始前に必ず確認する。
 */
import { spawn } from 'node:child_process';

export type GitState =
  | { kind: 'clean'; branch: string }
  | { kind: 'dirty'; branch: string; changed: string[] }
  | { kind: 'notRepo' }
  | { kind: 'unavailable'; reason: string };

export async function inspectGit(root: string): Promise<GitState> {
  const status = await run('git', ['status', '--porcelain', '--branch'], root);
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

function run(cmd: string, args: string[], cwd: string) {
  return new Promise<{ code: number; out: string }>((resolve) => {
    const child = spawn(cmd, args, { cwd });
    let out = '';
    const append = (b: Buffer) => { out += b.toString(); };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('error', (e) => resolve({ code: -1, out: e.message }));
    child.on('close', (code) => resolve({ code: code ?? -1, out }));
  });
}
