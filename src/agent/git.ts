/**
 * 自動書き込みの安全網は Git。
 * 未コミットの変更がある状態で自動書き込みを始めると、
 * 巻き戻し先が無くなるため、開始前に必ず確認する。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { chunkReader } from '../core/text.ts';
import { killTree } from './shell-exec.ts';
import { SAFE_GIT_ARGS, SAFE_GIT_ENV, workspaceScope } from './workspace-stamp.ts';

export type GitState =
  | { kind: 'clean'; branch: string }
  | { kind: 'dirty'; branch: string; changed: string[] }
  | { kind: 'notRepo' }
  | { kind: 'unavailable'; reason: string };

export async function inspectGit(root: string): Promise<GitState> {
  /*
   * **道は -z で受ける。**`--porcelain` だけでは、日本語の名前を `"\350\250\255..."` と引用し、名前の変更を `a -> b` と一行にする。
   * その文字をそのまま道として使っていたので、段取りの受け入れで無い道を「計画に無いファイル」として挙げていた。
   * 新しいフォルダは `sub/` のまま受ける（中を一つずつ出させると、node_modules を無視していない作業場では何千件も歩く）。
   * フォルダの扱いは受け入れの側（`dropCoveredDirs`）でする
   */
  /*
   * **道は作業場から。**porcelain の道は、作業場がリポジトリのサブフォルダでもリポジトリの根からになる（git の決まり）。
   * 作業場からの道（書いた・宣言した道）と並べて比べるので、同じファイルが二つの形で並び「計画に無いファイル」になり、
   * 作業場の外の変更まで数えていた。作業場の中だけに絞り、根から作業場までの分を落とす。
   * 絞り方と落とし方は作業場の記録と同じもの（`workspaceScope`）を使う。大小を区別しないリポジトリで作業場のフォルダの
   * 大小がディスクと索引で違うとき、`-- .` と素の `startsWith` では一件も挙がらず「クリーン」になる（記録の側で一度直した）
   */
  const scope = await workspaceScope(root);
  const status = await runGit(['status', '--porcelain=v1', '-z', '--branch', '--', scope?.spec ?? '.'], root);
  if (status.code !== 0) {
    if (/not a git repository/i.test(status.out)) return { kind: 'notRepo' };
    return { kind: 'unavailable', reason: status.out.trim().split('\n')[0] ?? 'git を実行できません' };
  }

  /*
   * 欄は標準出力だけから読む。標準エラーの警告を混ぜて読んでいたので、出力が大きいと警告が欄の途中に割り込み（`?? a.` +
   * 警告 + `ts`）、欄が崩れて読み飛ばされた。それが唯一の変更なら「クリーン」になり、巻き戻し先の無いまま自動の書き込みを始めていた
   */
  const parts = status.stdout.split('\0').filter((l) => l.length > 0);
  const branchLine = parts.find((l) => l.startsWith('##')) ?? '## (不明)';
  const branch = branchLine.replace(/^##\s*/, '').split(/\.{3}|\s/)[0] ?? '(不明)';
  // status は通ったのに作業場までが取れない（打ち切りなど）。道を直せないまま「クリーン」と言わない
  if (!scope) return { kind: 'unavailable', reason: '作業場がリポジトリのどこかを確かめられません' };
  const changed: string[] = [];
  const add = (p: string) => {
    const k = scope.key(p);
    if (k !== undefined && k !== '') { changed.push(k); return; }
    /*
     * 作業場そのもの、またはその上のフォルダが丸ごと未追跡（`?? packages/app/`・`?? packages/`）。中のファイルは一つも挙がらないが、
     * 何もコミットされていない＝git では戻せない。「クリーン」にしない。作業場全体を指す `./` で数える
     */
    if (k === '' || (p.endsWith('/') && scope.fold(scope.prefix).startsWith(scope.fold(p)))) changed.push('./');
    // それ以外は作業場の外（名前を変えた元が外にある、など）。作業場からの道で比べる側に、外の道を混ぜない
  };
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i]!;
    if (entry.startsWith('##') || entry.length < 4) continue;
    add(entry.slice(3));
    // 名前を変えた・写したものは、次の欄に元の名前が来る。元の道も変わったものとして数える
    if (/[RC]/.test(entry.slice(0, 2)) && i + 1 < parts.length) {
      add(parts[i + 1]!);
      i += 1;
    }
  }

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
export function runGit(args: string[], cwd: string): Promise<RunResult> {
  return runWithin('git', [...SAFE_GIT_ARGS, ...args], cwd, GIT_TIMEOUT_MS, {
    ...SAFE_GIT_ENV,
    // 資格情報を訊かせない（端末の入力待ち・Windows の資格情報を訊く画面で、返らないまま止まる）。訊かれる場面は失敗として返る
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
  });
}

/**
 * git を待つ上限。取得（fetch）が途中で止まっても、git は既定で打ち切らない。画面の更新の口・CLI の /update が返らないまま
 * 固まっていた。遅い回線でも取り終わる長さにしておく。
 */
export const GIT_TIMEOUT_MS = 5 * 60_000;

/** 走っている git の一群。こちらが終わるときに止める。 */
const live = new Set<ChildProcess>();
let exitWatched = false;
function watchExit(platform: NodeJS.Platform): void {
  if (exitWatched || platform === 'win32') return;
  exitWatched = true;
  process.on('exit', () => {
    for (const c of live) { if (c.pid !== undefined) { try { process.kill(-c.pid, 'SIGTERM'); } catch { /* 既に終わっている */ } } }
  });
}

/** 走らせた結果。`out` は人に見せる文（標準出力と標準エラーを届いた順に）、`stdout` は読み取りに使う標準出力だけ。 */
export interface RunResult { code: number; out: string; stdout: string }

/** 命令を走らせ、`timeoutMs` を過ぎたら打ち切って `code: -1` で返す。 */
export function runWithin(
  cmd: string, args: string[], cwd: string, timeoutMs: number, env: Record<string, string> = {},
  platform: NodeJS.Platform = process.platform,
): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    /*
     * 打ち切るときは子のプロセスツリーごと止める（POSIX では一群にして群ごと、Windows ではプロセスツリーをたどる）。`child.kill()` は呼んだ一つしか止めず、
     * 取得の下で動く `git-remote-https` などが残り、止まった `merge` は `index.lock` を掴んだままになりうる。
     * 入力は渡さない（訊かれても答えられないので、待たずに失敗させる）
     */
    const child = spawn(cmd, args, {
      cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: platform !== 'win32',
    });
    // 一群に分けたので、こちらが止められても（Ctrl+C）合図は届かない。こちらが終わるときに、走っている一群も止める
    live.add(child);
    watchExit(platform);
    child.on('close', () => live.delete(child));
    let out = '';
    let stdout = '';
    let settled = false;
    const finish = (r: RunResult) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => {
      killTree(child, platform);
      finish({ code: -1, out: `${out}\n${Math.round(timeoutMs / 1000)} 秒たっても終わらないので打ち切りました`, stdout });
    }, timeoutMs);
    const readOut = chunkReader();
    const readErr = chunkReader();
    child.stdout?.on('data', (b: Buffer) => { const t = readOut(b); stdout += t; out += t; });
    child.stderr?.on('data', (b: Buffer) => { out += readErr(b); });
    child.on('error', (e) => finish({ code: -1, out: e.message, stdout }));
    child.on('close', (code) => finish({ code: code ?? -1, out, stdout }));
  });
}
