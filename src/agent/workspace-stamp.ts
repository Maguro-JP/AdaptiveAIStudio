/**
 * 作業場が変わったかを、安く見分ける。
 *
 * 外のツール（MCP）は、何をするかがこちらから分からない。書いたかもしれないし、
 * 読んだだけかもしれない。読んだだけの回にまでテストを走らせると、MCP で
 * 何かを調べるたびに待たされる。**書いたときだけ確かめたい。**
 *
 * git に「変わっているファイル」を聞き、その一つずつの大きさと更新時刻を記録する。
 *
 *   ・きれいだったファイルが変われば、一覧に新しく出てくる
 *   ・もともと変わっていたファイルがさらに変われば、大きさか時刻が動く
 *   ・消せば一覧の状態が変わり、大きさが取れなくなる
 *
 * 中身は読まない。変わっていないものを「変わった」と言うことはあっても
 * （時刻だけ触った等）、書いたものを見逃すことはない、という側に倒してある。
 *
 * `.gitignore` で外したファイルは git が挙げないので、そこだけの変化は見えない。
 *
 * git が無い・git の管理下でない作業場では、比べられない（`undefined`）。
 * **比べられないことを「変わっていない」と読まない。**呼ぶ側がそう言う。
 */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';

/**
 * git を呼び、**標準出力だけ**を返す。
 *
 * `runGit` は標準エラーも同じ文字列に足す。git は status の最中に警告を出すことがあり
 * （`core.autocrlf` の「LF will be replaced by CRLF」など）、それが NUL 区切りの欄に
 * 紛れ込むと、欄がずれて壊れた記録になる。ここでは二つを混ぜない。
 */
function gitOut(args: string[], cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (err, stdout) => {
      resolve(err ? undefined : stdout);
    });
  });
}

/** 変わっているファイルごとの記録。`状態 大きさ 時刻`。消えたものは `状態 -`。 */
export type WorkspaceStamp = Map<string, string>;

export async function workspaceStamp(root: string): Promise<WorkspaceStamp | undefined> {
  /*
   * **git が返す名前は、リポジトリの根からの道。**作業場がリポジトリの下のフォルダ
   * （monorepo の一つの包みなど）だと、作業場につないでも場所がずれて stat が必ず
   * 外れる。根を聞いてつなぐ。見る範囲は `-- .` で作業場の中に絞る（外の変化を
   * この作業場の変化と数えない）。
   */
  const top = (await gitOut(['rev-parse', '--show-toplevel'], root))?.trim();
  if (!top) return undefined;
  // -z: 名前に空白や全角が入っても切れ目を取り違えない。
  const out = await gitOut(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.'], root);
  if (out === undefined) return undefined;

  const stamp: WorkspaceStamp = new Map();
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i]!;
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    // 名前を変えたものは、次の欄に元の名前が来る。元の名前は記録に要らない。
    // 索引の側（X）でも、作業ツリーの側（Y）でも起きる。
    if ('RC'.includes(code[0]!) || 'RC'.includes(code[1]!)) i += 1;
    const s = await stat(join(top, path)).catch(() => undefined);
    stamp.set(path, s ? `${code} ${s.size} ${s.mtimeMs}` : `${code} -`);
  }
  return stamp;
}

/** 二つの記録の間で、変わったファイル。並びは名前順。 */
export function stampChanges(before: WorkspaceStamp, after: WorkspaceStamp): string[] {
  const out = new Set<string>();
  for (const [path, mark] of after) if (before.get(path) !== mark) out.add(path);
  for (const path of before.keys()) if (!after.has(path)) out.add(path);
  return [...out].sort();
}
