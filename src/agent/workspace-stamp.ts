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
import { lstat, stat, readFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import { contentOf, isAbsent, type FileContent } from '../harness/put-back.ts';

/**
 * 作業場の記録で git を待つ上限。外のツールや run_command の前後で毎回走るので、大きなリポジトリや遅いドライブで長引くと、■が効かないまま
 * 待っていた。過ぎたら打ち切って「比べられない」（`undefined`）にする。呼ぶ側はそう言う。
 */
export const STAMP_GIT_TIMEOUT_MS = 2 * 60_000;

/**
 * git を呼び、**標準出力だけ**を返す。
 *
 * `runGit` は標準エラーも同じ文字列に足す。git は status の最中に警告を出すことがあり
 * （`core.autocrlf` の「LF will be replaced by CRLF」など）、それが NUL 区切りの欄に
 * 紛れ込むと、欄がずれて壊れた記録になる。ここでは二つを混ぜない。
 */
/**
 * 製品が自分で走らせる git には、作業場の設定の `core.fsmonitor` を効かせない。fsmonitor に書かれた命令は `git status` のたびに走るので、
 * 作業場の `.git/config`（作業の中で書き換えられうる）が、承認なしに命令を走らせる道になる。
 */
// 値は空にする。`false` は git 2.36 より前では「false という命令」と読まれ、呼ぶたびに sh を起こす。空ならどの版でも「無し」（2.43 で、空でも命令が走らないことを測った）
// `--no-optional-locks`: 裏で走らせる `git status` が index.lock を取りに行かない（同じ時に担当が打った `git add`・`git commit` を
// 「index.lock exists」で落とさない。git 2.15 から）
export const SAFE_GIT_ARGS: readonly string[] = ['--no-optional-locks', '-c', 'core.fsmonitor='];

function gitOut(args: string[], cwd: string, maxBuffer = 16 * 1024 * 1024): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('git', [...SAFE_GIT_ARGS, ...args], { cwd, maxBuffer, encoding: 'utf8', timeout: STAMP_GIT_TIMEOUT_MS }, (err, stdout) => {
      resolve(err ? undefined : stdout);
    });
  });
}

/** 同じく、バイト列のまま返す。中身は utf8 と限らない（二進・Shift_JIS）。 */
function gitBytes(args: string[], cwd: string, maxBuffer: number): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    execFile('git', [...SAFE_GIT_ARGS, ...args], { cwd, maxBuffer, encoding: 'buffer', timeout: STAMP_GIT_TIMEOUT_MS }, (err, stdout) => {
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
  // 落とすのは行末だけ。`trim()` だと、名前が空白（全角空白も）で始まるフォルダの分まで消えて、鍵が一つも合わない。
  return out === undefined ? undefined : out.replace(/\r?\n$/, '');
}

/**
 * 道の大小を区別しないリポジトリか（`core.ignorecase`。Windows・macOS の `git init` が true を書く）。
 * 確かめられなかった・書いていないときは区別する側（git と同じ既定）。
 */
async function ignoresCase(root: string): Promise<boolean> {
  return (await gitOut(['config', '--bool', 'core.ignorecase'], root))?.trim() === 'true';
}

/**
 * 変わっているファイルごとの記録。鍵は**作業場からの道**（`toDisplayPath` と同じ形）。
 * 値は `状態 大きさ 時刻`。消えたものは `状態 -`。
 */
export type WorkspaceStamp = Map<string, string>;

/** 見られなかったものに振る番号。回をまたいで増やし、二つの記録で同じ値にならないようにする。 */
let unseen = 0;

/**
 * 作業場が、リポジトリの根からどこか。git の道を作業場からの道に直すのに使う（`inspectGit` も使う）。
 * `spec` は作業場の中に絞る pathspec、`key` は根からの道を作業場からの道に（外なら undefined、作業場そのものなら空）。
 */
export interface WorkspaceScope {
  prefix: string;
  icase: boolean;
  spec: string;
  fold: (s: string) => string;
  key: (gitPath: string) => string | undefined;
}

export async function workspaceScope(root: string): Promise<WorkspaceScope | undefined> {
  const prefix = await prefixOf(root);
  if (prefix === undefined) return undefined;
  /*
   * 大小を区別しないリポジトリでは、作業場までの道も大小を区別せずに比べる。
   *
   * `--show-prefix` は cwd の**ディスク上の**大小で返す（Git for Windows の getcwd は GetFinalPathNameByHandleW で引く）。
   * 索引の道は**索引の**大小。フォルダの大小だけを変えた後（エクスプローラーで `src` → `Src`、上流で大小だけ変えたのを
   * 引いた後）は二つが食い違う。そのとき `-- .` は cwd の綴りで比べるので追跡しているファイルを一つも挙げず
   * （`core.ignorecase` は pathspec を大小無視にしない）、挙がった道も `startsWith` で落ちる。外のツールが書いても
   * 記録は空のまま「変わっていない」になる。`:(icase)` は cwd の分を区別したままなので、`top` で根から書く。
   */
  const icase = prefix !== '' && await ignoresCase(root);
  // 見る範囲は作業場の中に絞る（外の変化をこの作業場の変化と数えない）。`literal` は、フォルダ名の `*` `?` を型として読ませないため。
  const spec = icase ? `:(top,icase,literal)${prefix}` : '.';
  const fold = (s: string): string => (icase ? s.toLowerCase() : s);
  const head = fold(prefix);
  const key = (gitPath: string): string | undefined =>
    fold(gitPath.slice(0, prefix.length)) === head ? gitPath.slice(prefix.length) : undefined;
  return { prefix, icase, spec, fold, key };
}

export async function workspaceStamp(root: string): Promise<WorkspaceStamp | undefined> {
  const scope = await workspaceScope(root);
  if (!scope) return undefined;
  const { spec, key } = scope;
  // -z: 名前に空白や全角が入っても切れ目を取り違えない。
  // 上限は大きめに取る。`.gitignore` の無い作業場で `node_modules` が丸ごと untracked だと 16MiB を超え、
  // 超えた回を「git の管理下でない」と読むと、了解された作業場では二度と比べなくなる。
  const out = await gitOut(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', spec], root, 256 * 1024 * 1024);
  if (out === undefined) return undefined;
  // 根からの道を、作業場からの道に（`key`）。作業場の外（絞っても、名前変更の元は外に在り得る）は捨てる。

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
    try {
      // リンクは辿らない。git が記録するのはリンクそのもので、辿れないリンク（自分を指す・読めない所を指す）を毎回「変わった」と数えない
      const s = await lstat(join(root, path));
      stamp.set(path, `${code} ${s.size} ${s.mtimeMs}`);
    } catch (e) {
      // 見られないものは、前の回と同じ値にしない（前後とも見られないと「変わらない」と数え、確かめずに済ませていた）
      stamp.set(path, isAbsent(e) ? `${code} -` : `${code} ? ${++unseen}`);
    }
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
 * まだ一度もコミットしていない（HEAD が指すブランチがまだ無い）か。**確かめられたときだけ true。**
 *
 * `rev-parse --verify HEAD` が落ちるのは、コミットが無いときだけではない。ブランチの ref ファイルが壊れていても同じ形で落ちる
 * （電源断・同期ソフトで空やゼロ埋めになる）。そこで「無い」と読むと、HEAD に在るファイルを戻すときに消す。だから:
 *   ・HEAD が指すブランチ名が取れる（`symbolic-ref`。壊れた ref では落ちる）
 *   ・そのブランチの ref ファイルが無い（「無い」と確かめられた。読めない・在るなら違う）
 *   ・packed-refs にもそのブランチが無い
 * の全部を満たすときだけ、まだコミットが無いとする。
 */
async function unbornHead(root: string): Promise<boolean> {
  const ref = (await gitOut(['symbolic-ref', '-q', 'HEAD'], root))?.trim();
  if (!ref) return false;
  const resolveGitPath = async (p: string): Promise<string | undefined> => {
    const out = (await gitOut(['rev-parse', '--git-path', p], root))?.trim();
    return out ? (isAbsolute(out) ? out : join(root, out)) : undefined;
  };
  const loose = await resolveGitPath(ref);
  if (!loose) return false;
  try {
    await stat(loose);
    return false; // 在る（壊れている）
  } catch (e) {
    if (!isAbsent(e)) return false;
  }
  const packedPath = await resolveGitPath('packed-refs');
  if (!packedPath) return false;
  let packed = '';
  try {
    packed = await readFile(packedPath, 'utf8');
  } catch (e) {
    if (!isAbsent(e)) return false;
  }
  return !packed.split('\n').some((line) => line.endsWith(` ${ref}`));
}

/**
 * HEAD に在る中身。
 *
 *   ・`absent`: HEAD にその道は無い（新しく作られたもの）。戻すときは消す
 *   ・`content`: 作業ツリーの形の中身。`--filters` で改行の変換（`core.autocrlf`）まで
 *     そろえる（blob のまま書き戻すと、Windows で全行が差分になる）。utf8 で往復しないもの
 *     （二進・Shift_JIS）はバイト列のまま（文字列にすると別の中身にして戻す）
 *   ・`unavailable`: 在るが取れない。**「無い」と読まない。**読むと、戻すときに在ったファイルを消す
 *       - `tooLarge`: 大きすぎる
 *       - `symlink`: HEAD ではリンク。blob はリンク先の文字列なので、書き戻すと普通のファイルになる
 *       - `submodule`: gitlink。中の変化はこの repository から戻せない
 *       - `unreadable`: 読めなかった
 */
export type HeadContent =
  | { kind: 'absent' }
  | { kind: 'content'; content: FileContent }
  | { kind: 'unavailable'; why: 'tooLarge' | 'symlink' | 'submodule' | 'unreadable' };

/**
 * cwd からの道（`./道`）で HEAD に何も無かったときに、引き直す道。`spec` は ls-tree に渡す pathspec、`object` は `HEAD:` の後ろ。
 *
 * 大小を区別しないリポジトリで、作業場までのフォルダの大小がディスクと HEAD で違うと（`workspaceStamp` が拾う形）、cwd の分は
 * ディスクの大小で HEAD と照らされて何も引けない。作業場までのフォルダを HEAD の中で一段ずつ引き、HEAD の綴りで根からの道を作る
 * （`ls-tree` は `icase` を受け付けない）。**綴りが完全に一致する名前を先に取る。**大小だけ違う二つのフォルダが HEAD に在るとき、
 * 大小を無視した最初の一致を取ると、別のフォルダのファイルを「前」にして、戻すときにその中身を書いていた。
 * 当てはまらない（区別する・作業場が根・HEAD に無い）なら undefined。git が落ちたら 'unreadable'（「無い」と読まない）。
 */
async function headPathAgain(root: string, relPath: string): Promise<{ spec: string; object: string } | 'unreadable' | undefined> {
  const prefix = await prefixOf(root);
  if (prefix === undefined) return 'unreadable';
  if (prefix === '' || !(await ignoresCase(root))) return undefined;
  let at = '';
  // `--full-tree`: ls-tree は cwd の分で絞って並べるので、作業場の中から引くと根の tree が空に見える
  for (const part of prefix.split('/').filter((x) => x !== '')) {
    const listed = await gitOut(['ls-tree', '--full-tree', '-z', '--name-only', `HEAD:${at}`], root);
    if (listed === undefined) return 'unreadable';
    const names = listed.split('\0');
    const want = part.toLowerCase();
    const hit = names.find((name) => name === part) ?? names.find((name) => name.toLowerCase() === want);
    if (hit === undefined) return undefined;
    at += `${hit}/`;
  }
  return { spec: `:(top,literal)${at}${relPath}`, object: `${at}${relPath}` };
}

/**
 * 外のツールが触る前に**きれいだった**ファイルは、作業ツリー・索引・HEAD が同じ。
 * だから触った後でも HEAD から「前」の中身が取れる。
 *
 * 索引ではなく HEAD を引く。`run_command` は `git rm` / `git add` / `git mv` で索引を
 * 動かせるので、触った後の索引は「前」ではない。HEAD は `git commit` でしか動かず、
 * その回は見えない（`outside-changes.ts` の「見えないところ」）。
 * 道は cwd からの相対（`ls-tree` も `HEAD:./道` も）。
 */
export async function headContent(root: string, relPath: string, maxBytes: number): Promise<HeadContent> {
  /*
   * 引く道。普通は cwd からの道（`./道`）。大小を区別しないリポジトリで、作業場までのフォルダの大小がディスクと HEAD で
   * 違うと（`workspaceStamp` が拾う形）、cwd の分はディスクの大小で HEAD と照らされて**何も引けず**、「前は無かった」と
   * 記録して、戻すときにそのファイルを消していた。そのときは HEAD の大小で作業場までの道を引き直す（`headPathAgain`）
   */
  let object = `./${relPath}`;
  // `ls-tree -l` は一度で、在るか・種類（mode）・大きさを返す。
  let entry = await gitOut(['ls-tree', '-l', '-z', 'HEAD', '--', object], root);
  // 普通の形では git は一回で済む。cwd からの道で何も無かったときだけ、HEAD の綴りで引き直す
  if (entry === '') {
    const again = await headPathAgain(root, relPath);
    if (again === 'unreadable') return { kind: 'unavailable', why: 'unreadable' };
    if (again !== undefined) {
      entry = await gitOut(['ls-tree', '-l', '-z', 'HEAD', '--', again.spec], root);
      object = again.object;
    }
  }
  // **git が落ちたのを「無い」と読まない。**HEAD に無い道は、正常に終わって空を返す。落ちた（起動の失敗・壊れた ref・読めない object）
  // のを「無い」と読むと、HEAD に在るファイルを「前は無かった」と記録し、戻すときに消していた
  if (entry === undefined) {
    // まだ一度もコミットしていないリポジトリは HEAD が無く、ls-tree は落ちる。そこでは何も HEAD に無いので「無い」
    return (await unbornHead(root)) ? { kind: 'absent' } : { kind: 'unavailable', why: 'unreadable' };
  }
  if (entry === '') return { kind: 'absent' };
  const m = /^(\d{6}) (\w+) [0-9a-f]+ +(\d+|-)\t/.exec(entry);
  // 読めない形で返ってきたものも「無い」と読まない
  if (!m) return { kind: 'unavailable', why: 'unreadable' };
  const [, mode, type, size] = m;
  if (type === 'commit' || mode === '160000') return { kind: 'unavailable', why: 'submodule' };
  if (mode === '120000') return { kind: 'unavailable', why: 'symlink' };
  if (type !== 'blob') return { kind: 'absent' };
  if (Number(size) > maxBytes) return { kind: 'unavailable', why: 'tooLarge' };
  const bytes = await gitBytes(['cat-file', '--filters', `HEAD:${object}`], root, maxBytes * 2 + 1024);
  if (bytes === undefined) return { kind: 'unavailable', why: 'unreadable' };
  return { kind: 'content', content: contentOf(bytes) };
}
