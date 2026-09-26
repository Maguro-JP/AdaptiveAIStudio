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
 *   ・git 管理外の置き場がある（社用PCで git は入れられない）
 *   ・未コミットの直しは git でも戻せない
 * ので、git の有無に関わらず効くものを別に持つ。
 */
import { readFile, writeFile, mkdir, unlink, stat, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { safeResolve } from '../agent/tools/paths.ts';
import { putBack, putBackOrder, contentOf, contentBytes, type FileContent } from '../harness/put-back.ts';

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
}

interface Saved {
  path: string;
  /** 元々無かったファイルは undefined。戻すときは消す。utf8 で往復しないものはバイト列。 */
  content?: FileContent;
}

/**
 * 記録に書く形。文字は `content`、バイト列は `base64` に入れる（JSON にバイト列は書けない）。
 * どちらも無ければ「元々無かった」。`base64` を足す前の記録は `content` だけなので、そのまま読める。
 */
interface StoredFile {
  path: string;
  content?: string;
  base64?: string;
}

interface Stored extends UndoPoint {
  files: StoredFile[];
  /**
   * どの作業場の戻り先か。保存先は作業場をまたいで一つなので、持たないと、作業場を変えたあとに前の作業場の
   * 戻り先が今の作業場に当たり、別の作業場のファイルを上書きし、作ったものを消していた。
   */
  root?: string;
}

/** 作業場の根を比べられる形にする（Windows と macOS は大文字小文字を区別しない）。 */
export function rootKey(root: string, platform: NodeJS.Platform = process.platform): string {
  const r = resolve(root);
  return platform === 'linux' ? r : r.toLowerCase();
}

let tmpSeq = 0;
/** 戻り先を書く。一時ファイルに書いてから置き換える（書きかけの戻り先を残さない）。 */
async function writeStored(path: string, point: Stored): Promise<void> {
  const tmp = `${path}.${process.pid}.${++tmpSeq}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(point), 'utf8');
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}

function toStored(saved: Saved): StoredFile {
  if (saved.content === undefined) return { path: saved.path };
  return typeof saved.content === 'string'
    ? { path: saved.path, content: saved.content }
    : { path: saved.path, base64: saved.content.toString('base64') };
}

function fromStored(file: StoredFile): Saved {
  if (typeof file.base64 === 'string') return { path: file.path, content: Buffer.from(file.base64, 'base64') };
  return typeof file.content === 'string' ? { path: file.path, content: file.content } : { path: file.path };
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
  #open: { id: string; at: number; request: string; files: Map<string, Saved>; bytes: number; skipped: string[] } | undefined;
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

  /**
   * 一往復を始める。
   *
   * 前の一往復が閉じていなければ、そちらを先に閉じる。開きっぱなしにすると、
   * 別々の依頼の直しが一つの戻り先に混ざり、戻しすぎることになる。
   */
  async begin(request: string, now = Date.now()): Promise<void> {
    if (this.#open) await this.end();
    this.#open = {
      id: `u${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      at: now,
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
    if (!open || open.files.has(relPath)) return;
    const size = contentBytes(previous);
    if (open.bytes + size > MAX_POINT_BYTES) {
      open.skipped.push(relPath);
      this.#note(relPath);
      return;
    }
    open.bytes += size;
    open.files.set(relPath, { path: relPath, content: previous });
    this.#note(relPath);
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
    const old = open.files.get(relPath);
    const size = contentBytes(previous);
    const freed = contentBytes(old?.content);
    if (open.bytes - freed + size > MAX_POINT_BYTES) {
      this.forget(relPath);
      return;
    }
    open.bytes += size - freed;
    open.files.set(relPath, { path: relPath, content: previous });
    this.#note(relPath);
  }

  /**
   * 記録したものを捨てて「戻せない」にする。記録した「前」が正しいと言えなくなったとき。
   * 途中の姿へ戻すより、戻せないと言う方がよい。
   */
  forget(relPath: string): void {
    const open = this.#open;
    if (!open) return;
    const old = open.files.get(relPath);
    if (old) {
      open.bytes -= contentBytes(old.content);
      open.files.delete(relPath);
    }
    if (!open.skipped.includes(relPath)) open.skipped.push(relPath);
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
    if (!open || open.files.has(relPath) || open.skipped.includes(relPath)) return;
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

    const point: Stored = {
      id: open.id,
      at: open.at,
      request: open.request,
      paths: [...open.files.keys()],
      files: [...open.files.values()].map(toStored),
      ...(open.skipped.length > 0 ? { skipped: [...open.skipped] } : {}),
      root: rootKey(this.#root),
    };
    await mkdir(this.#dir, { recursive: true });
    await writeStored(join(this.#dir, `${point.id}.json`), point);
    await this.#prune();
    return {
      id: point.id, at: point.at, request: point.request, paths: point.paths,
      ...(point.skipped ? { skipped: point.skipped } : {}),
    };
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
    const points: UndoPoint[] = [];
    for (const name of await readdir(this.#dir).catch(() => [])) {
      if (!name.endsWith('.json')) continue;
      const raw = await readFile(join(this.#dir, name), 'utf8').catch(() => undefined);
      if (!raw) continue;
      try {
        const p = JSON.parse(raw) as Stored;
        // 今の作業場の戻り先だけ。根の無い古い記録は、どの作業場のものか分からないので出さない（消しもしない）。
        if (typeof p.id === 'string' && p.root === rootKey(this.#root)) {
          points.push({
            id: p.id, at: p.at, request: p.request, paths: p.paths ?? [],
            ...(p.skipped && p.skipped.length > 0 ? { skipped: p.skipped } : {}),
          });
        }
      } catch { /* 1件壊れても全部は失わない */ }
    }
    return points.sort((a, b) => b.at - a.at);
  }

  /**
   * ここまで戻す。
   *
   * **選んだ一つだけを戻さない。**その後の直しが上に乗っているので、
   * 一つだけ戻すと、途中だけ古い、どこにも無かった状態になる。
   * 選んだ戻り先を含めて、それより新しいものを新しい方から順に当てる。
   */
  async restore(id: string): Promise<Restored | undefined> {
    const all = await this.list();
    const at = all.findIndex((p) => p.id === id);
    if (at === -1) return undefined;

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
    // 新しい方から当てる。古い控えが後に来るので、いちばん古い姿が残る。
    for (const point of all.slice(0, at + 1)) {
      const raw = await readFile(join(this.#dir, `${point.id}.json`), 'utf8').catch(() => undefined);
      if (!raw) continue;
      let stored: Stored;
      try { stored = JSON.parse(raw) as Stored; } catch { continue; }
      /** この戻り先の中で戻せなかった道。残して、原因を除いたあとにもう一度戻せるようにする。 */
      const notBack = new Set<string>();
      for (const saved of putBackOrder((stored.files ?? []).map(fromStored))) {
        const abs = safeResolve(this.#root, saved.path);
        if (!abs) continue;
        if (!was.has(saved.path)) was.set(saved.path, await readText(abs));
        // リンクは辿らず、フォルダには書かず、戻せなければ飛ばす（1件戻せなくても他は戻す）。
        const r = await putBack(this.#root, saved.path, saved.content);
        if (r === 'restored' && !touched.includes(saved.path)) touched.push(saved.path);
        last.set(saved.path, r);
        if (r === 'failed') notBack.add(saved.path);
      }
      /*
       * **戻せなかった分がある戻り先は消さない。**消すと、Windows で掴まれていた等で戻せなかったファイルを
       * 戻す手が残らない。戻せなかった道の分だけを残して書き直す。
       */
      const file = join(this.#dir, `${point.id}.json`);
      if (notBack.size === 0) {
        await unlink(file).catch(() => undefined);
      } else {
        const keep = (stored.files ?? []).filter((f) => notBack.has(f.path));
        await writeStored(file, { ...stored, paths: keep.map((f) => f.path), files: keep }).catch(() => undefined);
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
    return { paths, points: at + 1, changed, failed };
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
