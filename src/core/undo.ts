/**
 * 戻せるようにする。
 *
 * **これが無いと、手元の小さいモデルは使えない。**間違った直しを当てられた
 * とき、利用者にできることが「自分で書き戻す」しか無いなら、任せられない。
 * 一度そうなれば、次からは何を頼むにも身構えることになる。
 *
 * `src/harness/checkpoint.ts` は**一往復の中**の控えで、確かめて落ちたときに
 * 自動で戻すためのもの。終われば捨てる。ここはその逆で、**終わった後に、
 * 人が自分の判断で戻す**ためのもの。だから記録に残す。
 *
 * git がある置き場なら git が本来の安全網。ただし
 *   ・git 管理外の置き場がある（git の無い環境もある）
 *   ・未コミットの直しは git でも戻せない
 * ので、git の有無に関わらず効くものを別に持つ。
 */
import { readFile, writeFile, mkdir, unlink, stat, readdir, rename, rm, realpath, open as openFile, chmod } from 'node:fs/promises';
import { statSync, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { safeResolve } from '../agent/tools/paths.ts';
import { putBack, putBackOrder, contentOf, contentBytes, isAbsent, pathKey, foldsCase, type FileContent } from '../harness/put-back.ts';

export { pathKey };

/** 一つの戻り先。 */
export interface UndoPoint {
  id: string;
  /** いつ（ミリ秒）。 */
  at: number;
  /** 何を頼んだときの直しか。人がどれに戻すか選ぶための手がかり。 */
  request: string;
  /** 触ったファイル（作業場からの相対）。 */
  paths: string[];
  /**
   * 大きすぎて控えなかったファイル。**戻らないものを、黙って持たない。**
   *
   * 知らせは流れ（`log`）にだけ出していた。既定の並びにそのパネルは無いので、
   * 人は見ていない。戻り先の行は普通に見えるのに、そのファイルは戻らない。
   * 選ぶ所に出せるように、戻り先そのものに書いておく。
   */
  skipped?: string[];
  /**
   * 始めた順の番号。並びは時計でなくこれで決める（時計を戻すと、新しい回が古い回より下に並び、「ここまで戻す」が
   * 新しい回を飛ばして途中の姿にした）。この番号を持たない前の記録は 0 として、時計で並べる。
   */
  seq?: number;
}

interface Saved {
  path: string;
  /** 元々無かったファイルは undefined。戻すときは消す。utf8 で往復しないものはバイト列。 */
  content?: FileContent;
  /** 書く前の権限（実行の権限など）。消されたファイルを作り直すときに戻す。 */
  mode?: number;
}

/**
 * 記録に書く形。文字は `content`、バイト列は `base64` に入れる（JSON にバイト列は書けない）。
 * どちらも無ければ「元々無かった」。`base64` を足す前の記録は `content` だけなので、そのまま読める。
 */
interface StoredFile {
  path: string;
  content?: string;
  base64?: string;
  mode?: number;
}

interface Stored extends UndoPoint {
  files: StoredFile[];
  /**
   * どの作業場の戻り先か。保存先は作業場をまたいで一つなので、持たないと、作業場を変えたあとに前の作業場の
   * 戻り先が今の作業場に当たり、別の作業場のファイルを上書きし、作ったものを消していた。
   */
  root?: string;
  /**
   * その回が書き終えた姿（道ごとの中身のハッシュ。無いなら null）。戻す前に、いまの中身と比べる。
   * 比べずに戻していたので、戻り先の後に外のエディタ等で入れた直しを、黙って消していた。
   */
  after?: Record<string, string | null>;
}

/** 戻す前に、選んだ一覧が古くなっていた（その間に新しい戻り先ができた）。名前を出していない回まで戻さない。 */
export class UndoStale extends Error {}

/** 戻り先の後に、記録の外で変わったファイルがある。黙って消さない（`force` で、それでも戻す）。 */
export class UndoConflict extends Error {
  readonly paths: string[];
  constructor(paths: string[]) {
    super(`戻り先の後に変わったファイルがあります（${paths.join(', ')}）。戻すと、その変更も消えます`);
    this.paths = paths;
  }
}

/** 中身のハッシュ。無いファイルは null。 */
async function digestOf(abs: string): Promise<string | null> {
  // 流しながら取る（丸ごと読むと、作業場に作られた大きなファイルで毎回メモリに載せ、2GiB を超えると読めなかった）
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(abs)
      .on('error', (e) => (isAbsent(e) ? resolve(null) : reject(e)))
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/** ファイルの頭だけを読む（並びの番号は記録の頭にあるので、丸ごと読まない）。 */
async function readHead(path: string, bytes = 512): Promise<string> {
  const fh = await openFile(path, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

/** 作業場の根を比べられる形にする（Windows と macOS は大文字小文字を区別しない）。 */
export function rootKey(root: string, platform: NodeJS.Platform = process.platform): string {
  const r = resolve(root);
  return platform === 'linux' ? r : r.toLowerCase();
}

/**
 * 作業場の根の鍵を、**実体の綴り**で作る。
 *
 * `rootKey` は字の上でしか揃えない。同じフォルダでも 8.3 の短い名前（`C:\Users\TANAKA~1\…`）・junction・symlink・
 * 割り当てたドライブ（`Z:` と `\\server\share`）では鍵が割れ、片方の綴りで残した戻り先が、もう片方で開くと一覧から消える。
 * 消えた側を残したままもう片方で「戻す」と、「選んだものより新しい戻り先を全部当てる」が、見えない側の分を飛ばして
 * どこにも無かった姿にする。だから鍵は realpath の先で作る（Windows では libuv が GetFinalPathNameByHandle で引く）。
 *
 * `also` は、字の上の鍵。この直しより前に残した戻り先は、そちらで書いてあるので読む側だけで受ける。
 * 実体が取れない（まだ無い・見られない）ときは、字の上の鍵だけにする。
 */
export async function rootKeys(root: string, platform: NodeJS.Platform = process.platform): Promise<{ key: string; also: string[] }> {
  const lexical = rootKey(root, platform);
  const real = await realpath(resolve(root)).catch(() => undefined);
  const key = real === undefined ? lexical : rootKey(real, platform);
  return { key, also: key === lexical ? [] : [lexical] };
}

let tmpSeq = 0;
/** 戻り先を書く。一時ファイルに書いてから置き換える（書きかけの戻り先を残さない）。 */
async function writeStored(path: string, point: Stored): Promise<void> {
  const tmp = `${path}.${process.pid}.${++tmpSeq}.tmp`;
  try {
    // 書いた中身をディスクに落としてから名前を付け替える（落とさずに付け替えると、直後に電源が落ちたとき、長さ 0 の戻り先が残る）
    await writeFile(tmp, JSON.stringify(point), 'utf8');
    const fh = await openFile(tmp, 'r+');
    try { await fh.sync(); } finally { await fh.close(); }
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}

function toStored(saved: Saved): StoredFile {
  const mode = saved.mode === undefined ? {} : { mode: saved.mode };
  if (saved.content === undefined) return { path: saved.path };
  return typeof saved.content === 'string'
    ? { path: saved.path, content: saved.content, ...mode }
    : { path: saved.path, base64: saved.content.toString('base64'), ...mode };
}

function fromStored(file: StoredFile): Saved {
  const mode = typeof file.mode === 'number' && Number.isInteger(file.mode) ? { mode: file.mode & 0o777 } : {};
  if (typeof file.base64 === 'string') return { path: file.path, content: Buffer.from(file.base64, 'base64'), ...mode };
  return typeof file.content === 'string' ? { path: file.path, content: file.content, ...mode } : { path: file.path };
}

/** 戻り先の記録として読める形か（壊れた記録を、読めたことにしない）。 */
function isStored(v: unknown): v is Stored {
  if (v === null || typeof v !== 'object') return false;
  const p = v as Partial<Stored>;
  return typeof p.id === 'string' && typeof p.at === 'number' && Array.isArray(p.files)
    && (p.paths === undefined || Array.isArray(p.paths));
}

/** 画面へ配るための中身。文字として読めないもの（二進）は配らない（`undefined` と区別するため `false`）。 */
async function readText(abs: string): Promise<string | undefined | false> {
  const bytes = await readFile(abs).catch(() => undefined);
  if (bytes === undefined) return undefined;
  const content = contentOf(bytes);
  return typeof content === 'string' ? content : false;
}

/** 戻したファイル一つ。無かった・消した所は undefined。 */
export interface RestoredFile {
  path: string;
  /** 戻す前の中身（いまディスクに在ったもの）。 */
  before?: string;
  /** 戻した後の中身。消したときは undefined。 */
  after?: string;
}

/** 戻した結果。`changed` は、戻したことを画面へ伝えるために持つ。 */
export interface Restored {
  paths: string[];
  /** 何往復ぶん戻したか。 */
  points: number;
  changed: RestoredFile[];
  /**
   * 置き戻しに失敗した道（掴まれている・フォルダに入れ替わった・作業場の外を指す）。
   * **黙って落とさない。**戻ったつもりで開くと、半分だけ戻った作業場を見ることになる。
   */
  failed: string[];
  /**
   * 当て終えたのに消せなかった戻り先。一覧に残るが、もう全部当ててある。
   * **黙らない。**残ったものをもう一度押すと、その後の直しを古い姿で上書きする。
   */
  leftover?: string[];
  /**
   * 戻せなかった道だけに縮められなかった戻り先。一覧には、戻せた道も入ったまま残る。
   * もう一度押すと、戻せなかった道と一緒に、戻せた道も古い姿で当て直す。
   */
  unshrunk?: string[];
}

/**
 * 戻した結果のうち、利用者に言わなければいけないこと（画面の「戻す」と、確かめて落ちたときの自動の巻き戻しで同じ文にする）。
 * `failed` は呼ぶ側が別の形で出すことがあるので、`withFailed` で選ぶ。
 */
export function restoreWarnings(done: Restored, opts: { withFailed?: boolean } = {}): string[] {
  const out: string[] = [];
  if (opts.withFailed && done.failed.length > 0) {
    out.push(`戻せなかったファイルがあります（掴まれている等）: ${done.failed.join(', ')}。その分は戻り先に残してあるので、少し置いてからもう一度戻してください`);
  }
  if (done.leftover) {
    out.push(`戻し終えた戻り先を一覧から消せませんでした（${done.leftover.length} 件）。一覧に残っていても、もう当ててあります。もう一度押すと、その後の直しを古い姿で上書きします`);
  }
  if (done.unshrunk) {
    out.push(`戻せなかったファイルの分だけを戻り先に残せませんでした（${done.unshrunk.length} 件）。一覧のその戻り先には戻せたファイルも入ったままです。もう一度押すと、戻せたファイルも古い姿で当て直します`);
  }
  return out;
}

/**
 * 残す数。
 *
 * 多すぎると選べない。少なすぎると、気づいたときには消えている。
 * 一日分の作業（十数往復）が残る程度にする。
 */
export const MAX_POINTS = 30;

/**
 * 一つの戻り先に控える大きさの上限。
 *
 * 大きなファイルを丸ごと控えると、置き場が膨らむ。超えた分は控えないが、
 * **控えなかったことは言う**（戻せると思って戻せない、をなくす）。
 */
export const MAX_POINT_BYTES = 8 * 1024 * 1024;

/**
 * 「直近で触った」として覚えておくファイルの数。
 *
 * 地図の起点にするためのものなので、多くしても効かない（地図に載る数の方が
 * 先に尽きる）。少なすぎると、少し前に直したファイルが起点から外れる。
 */
export const RECENT_PATHS = 12;

export class UndoStore {
  readonly #root: string;
  readonly #dir: string;
  #open: { id: string; at: number; seq: number; request: string; files: Map<string, Saved>; bytes: number; skipped: string[] } | undefined;
  /** 大きすぎて控えられなかったもの。黙って落とさないために持つ。 */
  #skipped: string[] = [];
  /**
   * 直近で書き換えたファイル（新しい順）。
   *
   * 戻すためではなく、**次にどこを見せるか**を決めるために持つ。
   * いま直しているファイルは、次の依頼でもほぼ確実に要る。
   * `list()` を読みに行かないのは、依頼のたびに 30 件の JSON を
   * 開くことになるため（画面は待たされる）。
   */
  #recent: string[] = [];

  constructor(root: string, dir: string) {
    this.#root = root;
    this.#dir = dir;
  }

  #fold: boolean | undefined;
  /** 道の鍵。作業場が大文字小文字を区別しないかは、作業場ごとに確かめた値を使う（`foldsCase`）。 */
  #key(relPath: string): string {
    this.#fold ??= foldsCase(this.#root);
    return pathKey(relPath, undefined, this.#fold);
  }

  /**
   * 一往復を始める。
   *
   * 前の一往復が閉じていなければ、そちらを先に閉じる。開きっぱなしにすると、
   * 別々の依頼の直しが一つの戻り先に混ざり、戻しすぎることになる。
   */
  async begin(request: string, now = Date.now()): Promise<void> {
    if (this.#open) await this.end();
    // 番号は始めたときに振る（並びは「始めた順」。書き終えた順で振ると、後に始まった別の作業が先に閉じたとき、この回の方が新しく見えた）
    const seq = await this.#nextSeq();
    this.#open = {
      id: `u${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      at: now,
      seq,
      request: request.split('\n')[0]?.slice(0, 120) ?? '',
      files: new Map(),
      bytes: 0,
      skipped: [],
    };
  }

  /**
   * 開いている記録を、戻り先として残さずに捨てる。書こうとして書けなかったとき。
   * 捨てずに放っておくと、次の `begin` が閉じて残し、書けなかったものまで「前は無かった」等で戻り先になる。
   */
  discard(): void {
    this.#open = undefined;
  }

  /**
   * 書き込む直前の中身を控える。同じファイルは最初の一度だけ。
   *
   * `previous` を受け取るのは、**書く側が既に読んでいるものを二度読まない**ため。
   */
  capture(relPath: string, previous: FileContent | undefined): void {
    const open = this.#open;
    // 記録できなかった道は、後の書き込みで記録し直さない（そのときの中身は途中の姿。「戻らない」と言ったのに、押すと途中の姿に書き換わった）
    // 鍵は綴りをそろえて使う（`src/Foo.ts` と `src/foo.ts` を別に記録すると、二つ目は一つ目が書いた後の中身になり、戻すと途中の姿になる）
    if (!open || open.files.has(this.#key(relPath)) || this.#skippedHas(relPath)) return;
    const size = contentBytes(previous);
    if (open.bytes + size > MAX_POINT_BYTES) {
      open.skipped.push(relPath);
      this.#note(relPath);
      return;
    }
    open.bytes += size;
    open.files.set(this.#key(relPath), { path: relPath, content: previous, ...this.#modeOf(relPath, previous) });
    this.#note(relPath);
  }

  /** この回で前の中身を記録した道か。 */
  has(relPath: string): boolean {
    return this.#open?.files.has(this.#key(relPath)) ?? false;
  }

  #skippedHas(relPath: string): boolean {
    const key = this.#key(relPath);
    return this.#open?.skipped.some((p) => this.#key(p) === key) ?? false;
  }

  /** 書く前の権限。在るファイルだけ。取れなければ持たない（戻すときに今の権限のまま）。 */
  #modeOf(relPath: string, previous: FileContent | undefined, platform: NodeJS.Platform = process.platform): { mode?: number } {
    if (previous === undefined || platform === 'win32') return {};
    const abs = safeResolve(this.#root, relPath);
    if (!abs) return {};
    try { return { mode: statSync(abs).mode & 0o777 }; } catch { return {}; }
  }

  /**
   * 前の中身を**置き換える**。先に記録したものより、こちらが「前」として正しいと分かっているとき。
   *
   * 段取り（plan）は依頼全体を一度の前後比べで挟むので、そこで分かる前の中身は依頼の前の姿そのもの。
   * 担当が先に `run_command` で変えた後に `write_file` で書くと、書く手前の記録（`capture`）は
   * `run_command` の後の姿になり、最初の一度が勝つせいで「戻す」が途中の姿に戻っていた。
   */
  replace(relPath: string, previous: FileContent | undefined): void {
    const open = this.#open;
    if (!open) return;
    const old = open.files.get(this.#key(relPath));
    const size = contentBytes(previous);
    const freed = contentBytes(old?.content);
    if (open.bytes - freed + size > MAX_POINT_BYTES) {
      this.forget(relPath);
      return;
    }
    open.bytes += size - freed;
    // 書く手前に取った権限は残す（前後比べで中身だけ入れ替えると、消したファイルを作り直すときに権限が落ちた）
    open.files.set(this.#key(relPath), { path: old?.path ?? relPath, content: previous, ...(old?.mode !== undefined && previous !== undefined ? { mode: old.mode } : {}) });
    this.#note(relPath);
  }

  /**
   * 記録したものを捨てて「戻せない」にする。記録した「前」が正しいと言えなくなったとき。
   * 途中の姿へ戻すより、戻せないと言う方がよい。
   */
  forget(relPath: string): void {
    const open = this.#open;
    if (!open) return;
    const old = open.files.get(this.#key(relPath));
    if (old) {
      open.bytes -= contentBytes(old.content);
      open.files.delete(this.#key(relPath));
    }
    if (!this.#skippedHas(relPath)) open.skipped.push(relPath);
    this.#note(relPath);
  }

  /**
   * 記録できなかったことだけを記す。
   *
   * 外のツールが変えた大きなファイルは、前の中身を読まない（読めば同じ上限に当たる）。
   * 名前だけ残して「戻せない」と言う。
   */
  skip(relPath: string): void {
    const open = this.#open;
    if (!open || open.files.has(this.#key(relPath)) || this.#skippedHas(relPath)) return;
    open.skipped.push(relPath);
    this.#note(relPath);
  }

  /** いまの一往復を閉じて、戻り先として残す。何も触っていなければ残さない。 */
  async end(): Promise<UndoPoint | undefined> {
    const open = this.#open;
    this.#open = undefined;
    if (!open) return undefined;
    this.#skipped = open.skipped;
    if (open.files.size === 0) return undefined;

    // その回が書き終えた姿を記録する（戻す前に、後から入った変化を見つけるため）。読めないものは比べない
    const after: Record<string, string | null> = {};
    for (const relPath of [...open.files.values()].map((f) => f.path)) {
      const abs = safeResolve(this.#root, relPath);
      if (!abs) continue;
      const d = await digestOf(abs).catch(() => undefined);
      if (d !== undefined) after[relPath] = d;
    }
    await mkdir(this.#dir, { recursive: true });
    const seq = open.seq;
    const point: Stored = {
      id: open.id,
      at: open.at,
      seq,
      request: open.request,
      paths: [...open.files.values()].map((f) => f.path),
      files: [...open.files.values()].map(toStored),
      ...(open.skipped.length > 0 ? { skipped: [...open.skipped] } : {}),
      root: (await rootKeys(this.#root)).key,
      after,
    };
    await writeStored(join(this.#dir, `${point.id}.json`), point);
    // 古い戻り先の片づけに失敗しても、この戻り先は書けている。書けなかったことにしない（呼ぶ側が「戻せません」と言ってしまう）
    await this.#prune().catch(() => undefined);
    return {
      id: point.id, at: point.at, seq, request: point.request, paths: point.paths,
      ...(point.skipped ? { skipped: point.skipped } : {}),
    };
  }

  /** 次の番号。今ある戻り先（どの作業場のものでも）の最大の次。並んで始めた回が同じ番号になったときは、始めた時刻で並べる。 */
  async #nextSeq(): Promise<number> {
    let max = 0;
    for (const name of await readdir(this.#dir).catch(() => [] as string[])) {
      if (!name.endsWith('.json')) continue;
      const raw = await readHead(join(this.#dir, name)).catch(() => '');
      const m = /"seq":(\d+)/.exec(raw);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return max + 1;
  }

  /** 最後に閉じた 1 ターンで、記録できなかったもの。空にしない（画面へ言う側が後で `takeSkipped` で取る）。 */
  peekSkipped(): readonly string[] { return this.#skipped; }

  /** 大きすぎて控えられなかったもの。読んだら空にする。 */
  takeSkipped(): string[] {
    const out = this.#skipped;
    this.#skipped = [];
    return out;
  }

  /**
   * 直近で書き換えたファイル。新しい順、上限 `RECENT_PATHS` 件。
   *
   * 控えられなかったもの（大きすぎたファイル）も、**触ったことは確か**なので
   * ここには入れる。戻せるかどうかと、いま作業しているかどうかは別の話。
   */
  recent(): readonly string[] { return this.#recent; }

  #note(relPath: string): void {
    const at = this.#recent.indexOf(relPath);
    if (at >= 0) this.#recent.splice(at, 1);
    this.#recent.unshift(relPath);
    if (this.#recent.length > RECENT_PATHS) this.#recent.length = RECENT_PATHS;
  }

  /** 戻り先の一覧。新しい順。 */
  async list(): Promise<UndoPoint[]> {
    return (await this.#scan()).points;
  }

  /**
   * 一覧と、**在るのに読めなかった戻り先**（ファイル名）。読めなかったものを黙って外すと、それを挟んだ古い戻り先まで戻すとき、
   * その回の分だけ当てずに「戻した」と返し、途中だけ新しい、どこにも無かった姿にしていた。
   */
  async #scan(): Promise<{ points: UndoPoint[]; unreadable: string[] }> {
    const points: UndoPoint[] = [];
    const unreadable: string[] = [];
    let names: string[];
    try {
      names = await readdir(this.#dir);
    } catch (e) {
      // フォルダそのものを見られないのを「戻り先がもう無い」と読まない
      if (!isAbsent(e)) throw new Error(`戻り先のフォルダを読めません: ${(e as Error).message}`);
      names = [];
    }
    const { key, also } = await rootKeys(this.#root);
    const mine = new Set([key, ...also]);
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      let raw: string | undefined;
      try {
        raw = await readFile(join(this.#dir, name), 'utf8');
      } catch (e) {
        if (!isAbsent(e)) unreadable.push(name);
        continue;
      }
      /*
       * 空・JSON でない・形が違う記録も「読めない」に入れる（黙って外すと、それを挟んだ古い戻り先まで戻すとき、その回の分だけ当てずに
       * 「戻した」と返し、どこにも無かった姿にしていた）。1 件壊れても一覧は出す。
       */
      let p: unknown;
      try { p = raw ? JSON.parse(raw) : undefined; } catch { p = undefined; }
      if (!isStored(p)) { unreadable.push(name); continue; }
      // 今の作業場の戻り先だけ。根の無い古い記録は、どの作業場のものか分からないので出さない（ここでは消さない。古くなったら `npm run clean` が挙げる）。
      if (typeof p.root === 'string' && mine.has(p.root)) {
        points.push({
          id: p.id, at: p.at, request: p.request, paths: p.paths ?? [],
          ...(typeof p.seq === 'number' ? { seq: p.seq } : {}),
          ...(p.skipped && p.skipped.length > 0 ? { skipped: p.skipped } : {}),
        });
      }
    }
    return { points: points.sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0) || b.at - a.at), unreadable };
  }

  /**
   * ここまで戻す。
   *
   * **選んだ一つだけを戻さない。**その後の直しが上に乗っているので、
   * 一つだけ戻すと、途中だけ古い、どこにも無かった状態になる。
   * 選んだ戻り先を含めて、それより新しいものを新しい方から順に当てる。
   */
  async restore(id: string, opts: { latest?: string; force?: boolean } = {}): Promise<Restored | undefined> {
    const { points: all, unreadable } = await this.#scan();
    // 画面が見ていた一番新しい戻り先と違えば、その間に新しい回ができている。名前を出していない回まで戻さない
    if (opts.latest !== undefined && all[0] && all[0].id !== opts.latest) {
      throw new UndoStale('戻り先の一覧が変わりました（新しい回が増えています）。一覧を見直してから、もう一度押してください');
    }
    const at = all.findIndex((p) => p.id === id);
    if (at === -1) {
      // 選んだ戻り先そのものが読めない。「もう無い」と言わない
      if (unreadable.includes(`${id}.json`)) throw new Error(`その戻り先を読めません（${id}）`);
      return undefined;
    }
    /*
     * 戻す範囲に挟まりうる、読めない戻り先があるときは戻さない（挟まっていれば、その回の分だけ抜けて、どこにも無かった姿になる）。
     * 範囲は「選んだ戻り先より後に書かれたもの」。書かれた時刻はファイルの更新時刻で見る（中身は読めないので）。
     * 時刻も取れないものは、挟まっているかもしれないとして止める。選んだ戻り先より前に書かれたもの（古い・別の作業場の記録）では止めない。
     * 止めないと、読めない古い記録が一つあるだけで、どの作業場の「戻す」もずっと止まる。
     */
    const since = all[at]!.at;
    const inRange: string[] = [];
    for (const name of unreadable) {
      const s = await stat(join(this.#dir, name)).catch(() => undefined);
      if (!s || s.mtimeMs >= since) inRange.push(name);
    }
    if (inRange.length > 0) {
      throw new Error(`読めない戻り先があるので戻しません（${inRange.join(', ')}）。途中の回を飛ばして戻すと、どこにも無かった姿になります。`
        + `壊れている・別の作業場のものと分かっているなら、${this.#dir} からそのファイルを消すと戻せます`);
    }

    const touched: string[] = [];
    /** 道ごとの、最後に当てた結果。古い記録ほど後に当てるので、最後の一回が今の姿を決める。 */
    const last = new Map<string, 'restored' | 'unchanged' | 'failed'>();
    /*
     * 戻す前の中身を、ファイルごとに最初の一度だけ控える。
     *
     * **戻したことを画面へ伝えるために要る。**ここまで戻した結果を配って
     * いなかったので、開いているエディタは古い中身のまま「保存してあります」
     * と出していた（画面を押して実測）。何往復ぶん戻しても、人が見たいのは
     * 「戻す前 → 戻した後」なので、控えるのは最初の一度でよい。
     */
    const was = new Map<string, string | undefined | false>();
    /** 読めた戻り先と、その記録。戻し終えてから、消すか残すかを決める。 */
    const read: { id: string; stored: Stored }[] = [];
    /** 道ごとに、いちばん古い（最後に当てた）戻り先。戻したい姿はそこに在る。 */
    const oldest = new Map<string, string>();
    // 先に全部読む。途中で読めなくなったら、何も当てずにやめる（当ててから気づくと、途中だけ戻した姿が残る）
    for (const point of all.slice(0, at + 1)) {
      let raw: string;
      try {
        raw = await readFile(join(this.#dir, `${point.id}.json`), 'utf8');
      } catch (e) {
        if (isAbsent(e)) continue; // 並んで走る片づけが消した
        throw new Error(`戻り先 ${point.id} を読めないので戻しません（${(e as Error).message}）`);
      }
      let stored: unknown;
      try { stored = JSON.parse(raw); } catch { stored = undefined; }
      // 一覧のときは読めたのに壊れていた（並んで書き換えられた等）。飛ばして当てると途中の姿になるので、何も当てずにやめる
      if (!isStored(stored)) throw new Error(`戻り先 ${point.id} が壊れているので戻しません`);
      read.push({ id: point.id, stored });
    }
    /*
     * 戻り先の後に、記録の外で変わったファイルを探す。道ごとに、いちばん新しくその道を書いた回が「書き終えた姿」を持っている。
     * いまの中身がそれと違えば、その後に外のエディタ・ツールで変わっている。黙って消さない（`force` で、それでも戻す）
     */
    if (!opts.force) {
      const seen = new Set<string>();
      // 大文字小文字を区別しない OS では、綴りの大小だけ違う道を同じものとして扱う（違うものとして古い回とも比べ、必ず断っていた）
      const fold = (p: string) => this.#key(p);
      const changedOutside: string[] = [];
      for (const { stored } of read) {
        // 新しい回で記録できなかった道（大きすぎる・前後比べで捨てた）も、その回が触った道。古い回の書き終えた姿とは比べない
        //（比べると、その回の AI 自身の変更を「後から変わった」と言っていた）
        const skippedHere = (stored.skipped ?? []).map(fold);
        for (const f of stored.files) {
          const key = fold(f.path);
          if (seen.has(key)) continue;
          seen.add(key);
          const expected = stored.after && Object.hasOwn(stored.after, f.path) ? stored.after[f.path] : undefined;
          if (expected === undefined) continue; // 書き終えた姿を持たない前の記録は比べない
          const abs = safeResolve(this.#root, f.path);
          if (!abs) continue;
          const now = await digestOf(abs).catch(() => undefined);
          if (now !== undefined && now !== expected) changedOutside.push(f.path);
        }
        for (const k of skippedHere) seen.add(k);
      }
      if (changedOutside.length > 0) throw new UndoConflict(changedOutside);
    }
    // 新しい方から当てる。古い控えが後に来るので、いちばん古い姿が残る。
    /*
     * 道ごとの持ち物は、綴りをそろえた鍵で持つ（戻り先ごとに綴りが違う同じファイル——AI が打った `src/Foo.ts` と git の `src/foo.ts`——を
     * 別の道として数えると、戻せた道を縮めた戻り先に残し、もう一度押すと途中の姿で上書きした）。言うときは最初の綴り
     */
    const spelled = new Map<string, string>();
    for (const { id: pointId, stored } of read) {
      const point = { id: pointId };
      for (const raw of putBackOrder((stored.files ?? []).map(fromStored))) {
        const abs = safeResolve(this.#root, raw.path);
        // 作業場の外を指す道（記録を手で直した等）は戻せない。黙って飛ばすと失敗に数えず、戻り先ごと消して戻す手が残らなかった
        if (!abs) {
          last.set(raw.path, 'failed');
          oldest.set(raw.path, point.id);
          continue;
        }
        const key = this.#key(raw.path);
        if (!spelled.has(key)) spelled.set(key, raw.path);
        const saved = { ...raw, path: spelled.get(key)! };
        if (!was.has(saved.path)) was.set(saved.path, await readText(abs));
        // リンクは辿らず、フォルダには書かず、戻せなければ飛ばす（1件戻せなくても他は戻す）。
        const r = await putBack(this.#root, saved.path, saved.content);
        // 書く前の権限に戻す（消されたファイルを作り直すと、実行の権限が落ちていた）
        if (r === 'restored' && saved.mode !== undefined && saved.content !== undefined) await chmod(abs, saved.mode).catch(() => undefined);
        if (r === 'restored' && !touched.includes(saved.path)) touched.push(saved.path);
        last.set(saved.path, r);
        oldest.set(saved.path, point.id);
      }
    }
    /*
     * **戻せなかった道がある戻り先は消さない。**消すと、Windows で掴まれていた等で戻せなかったファイルを
     * 戻す手が残らない。
     *
     * 残すかは、道ごとの**最後の結果**で決め、残すのは**いちばん古い戻り先の分だけ**にする。
     * 戻り先ごとの失敗で決めていたときは、新しい戻り先で失敗して古い戻り先で戻せた道まで残り、
     * あとでそれを戻すと、戻した姿より新しい姿を当ててファイルを消していた。
     */
    const leftover: string[] = [];
    const unshrunk: string[] = [];
    for (const { id: pointId, stored } of read) {
      const file = join(this.#dir, `${pointId}.json`);
      const same = (p: string) => spelled.get(this.#key(p)) ?? p;
      const keep = (stored.files ?? []).filter((f) => last.get(same(f.path)) === 'failed' && oldest.get(same(f.path)) === pointId);
      // 片づけられなかったら、そう返す（もう無いなら片づいている）
      if (keep.length === 0) {
        if (!await unlink(file).then(() => true, (e: unknown) => isAbsent(e))) leftover.push(pointId);
      } else if (!await writeStored(file, {
        ...stored, paths: keep.map((f) => f.path), files: keep,
        // 一度当てようとした道は、書き終えた姿と比べない（当てようとした後の中身は、もう書き終えた姿ではない。比べると、
        // 原因を除いてもう一度押したときに「後から変わった」で断っていた）
        after: Object.fromEntries(Object.entries(stored.after ?? {}).filter(([k]) => !keep.some((f) => f.path === k))),
      }).then(() => true, () => false)) {
        unshrunk.push(pointId);
      }
    }
    const paths = touched.filter((p) => last.get(p) !== 'failed');
    const failed = [...last].filter(([, r]) => r === 'failed').map(([p]) => p);
    const changed: RestoredFile[] = [];
    for (const path of paths) {
      const abs = safeResolve(this.#root, path);
      const after = abs ? await readText(abs) : undefined;
      const before = was.get(path);
      // 二進は差分にできない。戻したことは `paths` で言い、画面へは配らない（化けた差分を見せない）。
      if (before === false || after === false) continue;
      changed.push({ path, before, after });
    }
    return {
      paths, points: at + 1, changed, failed,
      ...(leftover.length > 0 ? { leftover } : {}), ...(unshrunk.length > 0 ? { unshrunk } : {}),
    };
  }

  /** 溜めすぎない。落とした数を返す。 */
  async #prune(max = MAX_POINTS): Promise<number> {
    const all = await this.list();
    if (all.length <= max) return 0;
    const drop = all.slice(max);
    for (const p of drop) await unlink(join(this.#dir, `${p.id}.json`)).catch(() => undefined);
    return drop.length;
  }
}
