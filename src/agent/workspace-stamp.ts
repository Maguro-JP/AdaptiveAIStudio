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
function gitOut(args: string[], cwd: string, maxBuffer = 16 * 1024 * 1024): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer, encoding: 'utf8' }, (err, stdout) => {
      resolve(err ? undefined : stdout);
    });
  });
}

/**
 * リポジトリの根から作業場までの道（`sub/dir/`、根なら空）。
 *
 * git が返す名前はリポジトリの根からの道なので、この分を落とすと作業場からの道になる。
 * `--show-toplevel` から `relative()` で作る形にしていたが、作業場がシンボリックリンク
 * 越しのとき（`--show-toplevel` は実体を返す）に `../../real/...` の道を作った。
 * `--show-prefix` は git 自身が「cwd は根からどこか」を答えるので、綴りに左右されない。
 */
async function prefixOf(root: string): Promise<string | undefined> {
  const out = await gitOut(['rev-parse', '--show-prefix'], root);
  return out === undefined ? undefined : out.trim();
}

/**
 * 変わっているファイルごとの記録。鍵は**作業場からの道**（`toDisplayPath` と同じ形）。
 * 値は `状態 大きさ 時刻`。消えたものは `状態 -`。
 */
export type WorkspaceStamp = Map<string, string>;

export async function workspaceStamp(root: string): Promise<WorkspaceStamp | undefined> {
  const prefix = await prefixOf(root);
  if (prefix === undefined) return undefined;
  // 見る範囲は `-- .` で作業場の中に絞る（外の変化をこの作業場の変化と数えない）。
  // -z: 名前に空白や全角が入っても切れ目を取り違えない。
  const out = await gitOut(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.'], root);
  if (out === undefined) return undefined;
  // 根からの道を、作業場からの道に。作業場の外（`-- .` で絞っても、名前変更の元は外に在り得る）は捨てる。
  const key = (gitPath: string): string | undefined =>
    gitPath.startsWith(prefix) ? gitPath.slice(prefix.length) : undefined;

  const stamp: WorkspaceStamp = new Map();
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i]!;
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const path = key(entry.slice(3));
    // 名前を変えたものは、次の欄に元の名前が来る。索引の側（X）でも作業ツリーの側（Y）でも起きる。
    // 元の名前も「消えた」として記録する。`run_command` が `git mv` をすると元の道が
    // 作業ツリーから消えるので、戻すときにはそこへ HEAD の中身を置き直す必要がある。
    if ('RC'.includes(code[0]!) || 'RC'.includes(code[1]!)) {
      i += 1;
      const from = key(parts[i] ?? '');
      if (from) stamp.set(from, `${code} -`);
    }
    if (!path) continue;
    const s = await stat(join(root, path)).catch(() => undefined);
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

/**
 * HEAD に在る中身。
 *
 *   ・`absent`: HEAD にその道は無い（新しく作られたもの）。戻すときは消す
 *   ・`content`: 作業ツリーの形の中身。`--filters` で改行の変換（`core.autocrlf`）まで
 *     そろえる（blob のまま書き戻すと、Windows で全行が差分になる）
 *   ・`unavailable`: 在るが取れない（大きすぎる・読めない）。**「無い」と読まない。**
 *     読むと、戻すときに在ったファイルを消す
 */
export type HeadContent =
  | { kind: 'absent' }
  | { kind: 'content'; text: string }
  | { kind: 'unavailable'; why: 'tooLarge' | 'unreadable' };

/**
 * 外のツールが触る前に**きれいだった**ファイルは、作業ツリー・索引・HEAD が同じ。
 * だから触った後でも HEAD から「前」の中身が取れる。
 *
 * 索引ではなく HEAD を引く。`run_command` は `git rm` / `git add` / `git mv` で索引を
 * 動かせるので、触った後の索引は「前」ではない。HEAD は `git commit` でしか動かず、
 * その回は見えない（`outside-changes.ts` の「見えないところ」）。
 * `HEAD:./道` は cwd からの相対。
 */
export async function headContent(root: string, relPath: string, maxBytes: number): Promise<HeadContent> {
  const spec = `HEAD:./${relPath}`;
  const size = await gitOut(['cat-file', '-s', spec], root);
  if (size === undefined) return { kind: 'absent' };
  if (Number(size) > maxBytes) return { kind: 'unavailable', why: 'tooLarge' };
  const text = await gitOut(['cat-file', '--filters', spec], root, maxBytes * 2 + 1024);
  if (text === undefined) return { kind: 'unavailable', why: 'unreadable' };
  return { kind: 'content', text };
}
