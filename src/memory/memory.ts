/**
 * 記憶 — この場所に住み続けるための器。
 *
 * 起動するたびに何も覚えていないなら、それは道具であって住人ではない。
 * 決めたこと、試して駄目だったこと、調べて分かったこと、
 * 利用者の好み —— これが残らない限り、同じ失敗を無限に繰り返す。
 *
 * 設計で外せない点が三つある。
 *
 *   1. **確度は回数で上がる**
 *      一度見たことは仮説、何度も確かめられたことは事実に近い。
 *      同じことを覚え直したら、上書きではなく確認回数を増やす。
 *
 *   2. **決め直しは消さずに繋ぐ**
 *      古い決定を消すと「なぜ変えたのか」が失われる。
 *      新しい決定から古い決定へ矢印を張り、履歴として残す。
 *
 *   3. **矛盾は黙って飲み込まない**
 *      前と違うことを決めたなら、それは報告に値する出来事。
 *
 *   4. **役に立ったかを見る**
 *      思い出して添えた結果、その仕事が通ったのか、落ちたのか。
 *      見ないと、**外れた覚えが永遠に効き続ける**。使うほど雑音が増える形で、
 *      それは「使うほど馬鹿になる」。当たった覚えを上げ、外した覚えを下げる。
 *
 *      ただし**確かめていない回からは学ばない。**検証を回していない回の
 *      「うまくいった気がする」で重みを動かすと、思い込みが固まるだけ。
 *
 * 埋め込みも外部データベースも使わない。語の重なりと新しさと確認回数で十分に効く。
 * 動く条件を増やさないことも、止まらないための設計のうち。
 */
import { readFile, open, mkdir, rename, unlink } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { jstDate } from '../core/clock.ts';
import { redactSecrets } from '../core/redact.ts';
import { headOf } from '../agent/window.ts';
import { BUILTIN_LESSONS, lessonLine } from './builtin-lessons.ts';
import { withFileLock } from '../core/file-lock.ts';

export type MemoryKind =
  /** 決めたこと。方針・設計判断 */
  | 'decision'
  /** 試したこと。うまくいった/駄目だった */
  | 'attempt'
  /** 調べて分かったこと */
  | 'fact'
  /** 利用者の好み・流儀 */
  | 'preference'
  /** 起きたこと。障害・事故 */
  | 'incident'
  /**
   * 嫌がられたこと。
   *
   * **これだけは、話題が違っても必ず思い出す。**語の重なりで引くと、
   * 画面の不快は画面の作業のときしか出てこない。踏む地雷は、
   * どの作業でも同じように踏む。
   *
   * **刈らない。**溜まっても数十件で、そのぶんの窓は払う価値がある。
   */
  | 'displeasure';

export interface MemoryEntry {
  id: string;
  kind: MemoryKind;
  /** 一行で。あとで探すときの手がかりになる。 */
  title: string;
  detail: string;
  tags: string[];
  /** 最初に覚えた時刻 */
  at: number;
  /** 最後に確かめられた時刻 */
  seenAt: number;
  /** 何度確かめられたか。1 は仮説、重なるほど事実に近い。 */
  confirms: number;
  /** attempt のみ */
  outcome?: 'worked' | 'failed';
  /** どこで知ったか */
  source?: string;
  /**
   * どの作業場で起きたか（作業場の根）。試したこと・分かったことに付ける。記憶は作業場をまたいで一つなので、
   * 付けないと、別の作業場の同じ名前のファイル（`src/index.ts` など）で試した手が「前に駄目だった手」として出てくる。
   * 古い覚え（付いていないもの）は、どの作業場でも思い出す。
   */
  root?: string;
  /** 思い出して添えた回数。 */
  used?: number;
  /** 添えたあと、確かめて通った回数。 */
  helped?: number;
  /** 添えたあと、確かめて落ちた回数。 */
  misled?: number;
  /** この決定が置き換えた古い決定 */
  supersedes?: string;
  /** 置き換えられた側に入る */
  supersededBy?: string;
}

export interface RecallOptions {
  limit?: number;
  kinds?: MemoryKind[];
  /** 置き換えられた古い決定も含める */
  includeSuperseded?: boolean;
  /** いまの作業場の根。別の作業場で覚えた、場に依る覚え（試したこと・分かったこと・起きたこと）を混ぜない。 */
  root?: string;
  /**
   * 「二度としないこと」を混ぜるか。既定は混ぜる。
   *
   * **決まり（system）の側で載せているときは、false にする。**
   * 両方に載せると、同じ文が一往復に二度入る。狭い窓ほど効く。
   */
  lessons?: boolean;
}

/** 覚え直したときに何が起きたか。呼び出し側が周知に使う。 */
export interface RememberResult {
  entry: MemoryEntry;
  /** 初めて覚えた */
  isNew: boolean;
  /** 同じことを再び確かめた（確度が上がった） */
  reinforced: boolean;
  /** 前と食い違う決定。黙って飲み込まない。 */
  conflicts: MemoryEntry[];
}

/** ひらがなだけの 2 字。語の手がかりにならない（助詞・語尾・丁寧語）。 */
const HIRAGANA_ONLY = /^[ぁ-ん]{2}$/;

const STOP = new Set([
  'する', 'した', 'して', 'ある', 'ない', 'こと', 'もの', 'ため', 'よう',
  'the', 'a', 'an', 'is', 'to', 'of', 'and', 'in', 'for', 'on', 'with', 'it',
]);

/**
 * 語に割る。日本語は語の切れ目が無いので、
 * 記号と英数の境目で割り、2文字以上の塊を拾う。
 * 形態素解析は入れない。依存を増やしてまでの精度差が無い。
 */
export function tokenize(text: string): string[] {
  const rough = text
    // 全角の英数（ＲＥＡＤＭＥ）を半角に揃える。揃えないと 2 字ずつに割られ、半角で覚えた題と重ならなかった
    .normalize('NFKC')
    .toLowerCase()
    // 英数の塊と日本語の境目でも割る（「READMEを直して」から readme を取る。割らないと re・ea… に刻まれていた）
    .replace(/([a-z0-9]+)/g, ' $1 ')
    .replace(/[「」『』（）()[\]{}、。,.:;!?？！\-_/\\'"`|+*=<>~@#$%^&\n\r\t]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0);

  const out: string[] = [];
  for (const chunk of rough) {
    if (/^[\x20-\x7e]+$/.test(chunk)) {
      if (chunk.length >= 2 && !STOP.has(chunk)) out.push(chunk);
      continue;
    }
    // 日本語は2文字ずつずらして拾う。部分一致で引っかかるようにする。
    if (chunk.length <= 2) {
      // 一字の語は捨てる（英字に挟まれた助詞「の」「を」が一語になり、それだけで関係の無い覚えに当たっていた）
      if (chunk.length === 2 && !STOP.has(chunk) && !HIRAGANA_ONLY.test(chunk)) out.push(chunk);
      continue;
    }
    for (let i = 0; i + 2 <= chunk.length; i += 1) {
      const gram = chunk.slice(i, i + 2);
      // ひらがなだけの 2 字（「くだ」「さい」「から」「とき」）は拾わない。丁寧語の依頼どうしがそれだけで重なり、関係の無い覚えが当たっていた
      if (!STOP.has(gram) && !HIRAGANA_ONLY.test(gram)) out.push(gram);
    }
  }
  return out;
}

/** 同じことを言っているかの判定用。表記揺れを潰す。 */
export function normalizeTitle(title: string): string {
  // 全角と半角の英数を同じ題として畳む（「ＡＰＩキー」と「APIキー」を二件にしない）
  return title.normalize('NFKC').toLowerCase().replace(/\s+/g, '').replace(/[。、,.!?！？]/g, '');
}

const DAY = 86_400_000;

/** 記憶のファイルへ書く手。試験で途中に割り込むために、別の手を渡せる。 */
export type MemoryWriter = (path: string, body: string) => Promise<void>;

/**
 * 一時ファイルに書いて、**ディスクまで書き切ってから**置き換える。途中で落ちても、半分だけ書かれたファイルを残さない。
 *
 * 書き切る（sync）前に置き換えると、電源が落ちたときに「置き換えた」だけが残り、中身が空か NUL のファイルになり得る
 * （ファイルシステム次第。確かめていない）。読むと空として始まり、覚えていたものが全部消える。会話の書き戻し
 * （`src/core/conversations.ts` の `replaceWhole`）と同じ順にそろえる。
 * Windows では、ウイルス対策や同期が元のファイルを掴んでいると置き換えが一時的に断られる（EPERM・EACCES・EBUSY）。少し待ってやり直す。
 */
const writeWhole: MemoryWriter = async (path, body) => {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    const fh = await open(tmp, 'w');
    try {
      await fh.writeFile(body, 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    for (let tries = 0; ; tries += 1) {
      try {
        await rename(tmp, path);
        break;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (tries >= 10 || !(code === 'EPERM' || code === 'EACCES' || code === 'EBUSY')) throw e;
        await new Promise((r) => setTimeout(r, 100 + tries * 50));
      }
    }
  } catch (e) {
    await unlink(tmp).catch(() => undefined);
    throw e;
  }
};

/** 忘れた覚えと、それを指していた繋がり（`Memory.remove` が返し、`Memory.restore` が受け取る）。 */
export interface Forgotten {
  entry: MemoryEntry;
  links: { id: string; field: 'supersedes' | 'supersededBy' }[];
  /** 取ったときの読み直しの代（中は見ない）。 */
  era: object;
}

/**
 * 作業場を比べる鍵。実体の道（8.3 の短い名前・junction・割り当てたドライブを揃える）で、大小を区別しない機械では小文字にする
 * （`src/core/undo.ts` の作業場の鍵と同じ考え）。字のまま比べると、CLI を `c:\\work` から、画面を `C:\\Work` で開いただけで
 * 同じ作業場の「前に駄目だった手」を思い出さず、同じ題の覚えが二つにできた。実体が取れなければ字のまま
 */
export function placeKey(root: string, platform: NodeJS.Platform = process.platform): string {
  let real = root;
  try { real = realpathSync(root); } catch { /* 無い・読めない作業場は字のまま */ }
  return platform === 'linux' ? real : real.toLowerCase();
}

/** `restore` が戻さなかった理由。 */
export type RestoreRefusal = 'reloaded' | 'taken' | 'duplicate';

export class Memory {
  readonly #path?: string;
  readonly #write: MemoryWriter;
  #entries: MemoryEntry[] = [];
  #seq = 0;
  /**
   * 読み直しの代。`load` と `#rejoin` で番号が振り直されるたびに変える。`remove` で取ったものは、同じ代の間しか
   * `restore` できない（代をまたぐと、同じ番号が別の覚えを指す）。
   */
  #era: object = {};
  /**
   * 最後に読んだ・書いたときにディスクに在った覚え（番号 → 覚えた時刻と題）。別のプロセス（画面と端末）が同じファイルを書くとき、
   * 「よそで消された」と「同じ番号をよそが別の覚えに配った」を見分けるのに使う。
   */
  #onDisk = new Map<string, string>();
  /**
   * 戻したときに繋ぎ直せなかった繋がり（相手もまだ忘れられていた）。相手が戻ったときに繋ぐ。
   * B と C を続けて忘れると、C の写しは B を忘れた時点で切られている。B を先に戻すと、C への繋がりの行き先が無い。
   */
  #waiting: { id: string; field: 'supersedes' | 'supersededBy'; to: string }[] = [];
  #dirty = false;
  /**
   * 保存の列。**同じインスタンスの中だけ**、同時に書かない。同じファイルへ別のインスタンスが書くと
   * 互いの分を上書きし得るので、会話を分けるときは共有の作業場が一つの `Memory` を持つ（DECISIONS 09-26）。
   */
  #saving: Promise<void> = Promise.resolve();

  readonly #read: (path: string) => Promise<string>;
  /**
   * 記憶のファイルが在るのに読めなかった（EBUSY・EPERM 等）。この間は保存しない。
   * 空として始めて保存すると、覚えていたものを全部上書きしていた。
   */
  #unreadable?: string;
  /**
   * 読むときに退けた行（壊れた行・形の違う行）を、元の文のまま持っておく。保存のときに書き戻す。
   * 退けたまま保存すると、手で直している途中の行や、別の版が書いた行が、次の保存でファイルから消えていた。
   */
  #kept: string[] = [];
  /**
   * 読み込んだ後に手元から外した番号（忘れた・刈った・畳んだ）。保存の直前にファイルを読み直したとき、手元に無い番号の覚えを
   * 「外した」のか「手元が知らない」（動いている間に手で直して読めるようになった行・別のプロセスが足した覚え）のかを分ける。
   */
  #gone = new Set<string>();
  /**
   * 利用者が忘れた、最初からの覚え（`seedLessons` が入れる分）の題（`normalizeTitle` の形）。ファイルに一行ずつ
   * `{"declined":"…"}` で残す。残さないと、立ち上げ直す・作業場やモデルを変えて本体を組み直すたびに `seedLessons` が入れ直し、
   * 忘れたはずの覚えが毎回の依頼に戻っていた。
   */
  #declined = new Set<string>();
  /** この起動の間に戻した、最初からの覚えの題。保存の直前に読み直したファイルの `declined` 行から、足し戻さない。 */
  #undeclined = new Set<string>();

  constructor(path?: string, opts: { write?: MemoryWriter; read?: (path: string) => Promise<string> } = {}) {
    this.#path = path;
    this.#write = opts.write ?? writeWhole;
    this.#read = opts.read ?? ((p) => readFile(p, 'utf8'));
  }

  get size(): number {
    return this.#entries.length;
  }

  /** 読むときに退けた行（形の違う行・壊れた行）の数。ファイルの末尾に元の文のまま残している。 */
  get skipped(): number {
    return this.#kept.length;
  }

  /** ファイルを読めなかった理由（権限・フォルダだった・掴まれていた）。読めた・無かったなら undefined。 */
  get unreadable(): string | undefined {
    return this.#unreadable;
  }

  all(): MemoryEntry[] {
    return [...this.#entries];
  }

  async load(): Promise<void> {
    this.#era = {};
    this.#waiting = [];
    this.#gone = new Set();
    if (!this.#path) return;
    // 読めない間に覚えた分があれば、読み直しで捨てずに合わせる（読めなければそのまま持っておく）。
    if (this.#unreadable && this.#dirty) {
      await this.#rejoin();
      return;
    }
    this.#unreadable = undefined;
    try {
      const got = parseEntries(await this.#readRetrying(this.#path));
      this.#entries = got.entries;
      this.#kept = got.kept;
      this.#declined = new Set(got.declined);
      this.#seq = Math.max(maxSeq(got.entries), got.keptSeq);
      this.#onDisk = new Map(got.entries.map((e) => [e.id, sameness(e)]));
    } catch (e) {
      this.#onDisk = new Map();
      this.#entries = [];
      this.#kept = [];
      this.#declined = new Set();
      // 無いのは正常（はじめて）。それ以外は、読めなかったと覚えて保存を断る。
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') this.#unreadable = code ?? (e as Error).message;
    }
  }

  /**
   * 一時的に掴まれているだけのことがある（Windows のウイルス対策・同期）。少し待って数回読み直す。
   * 権限が無い（EACCES）は待っても直らないので読み直さない（画面の状態を取るたびに待たせていた）。
   */
  async #readRetrying(path: string): Promise<string> {
    for (let tries = 0; ; tries += 1) {
      try {
        return await this.#read(path);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (tries >= 3 || !(code === 'EBUSY' || code === 'EPERM')) throw e;
        await new Promise((r) => setTimeout(r, 100 * (tries + 1)));
      }
    }
  }

  /**
   * 保存する。**呼ばれた順に一つずつ書く**（画面で二つの会話が同時に呼んでも重ならない）。
   *
   * `#dirty`（保存していない変更がある）は**書く前に**下ろす。書き終えてから下ろすと、書いている最中に
   * 覚えた分まで「保存済み」になり、次の保存で書かれない。書くのに失敗したら `#dirty` を戻す。
   */
  save(): Promise<void> {
    const run = this.#saving.then(() => this.#saveNow());
    // 一度失敗しても、列を止めない（次の保存は走る）。失敗は呼んだ側へ返す。
    this.#saving = run.catch(() => undefined);
    return run;
  }

  /**
   * 読めなかった記憶のファイルを、保存の手前でもう一度読む。読めたら、ファイルの中身の後ろに、
   * 読めない間に覚えた分を番号を振り直して足す（読めない間は空から始めているので、手元の分がそれに当たる）。
   *
   * 起動時に一度読めなかっただけで、その後ずっと保存しない形を止める（画面は保存の断りを見せる口を持たない）。
   */
  async #rejoin(): Promise<boolean> {
    if (!this.#path) return false;
    let raw: string;
    try {
      raw = await this.#readRetrying(this.#path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return false;
      raw = '';
    }
    const got = parseEntries(raw);
    const onDisk = got.entries;
    this.#kept = got.kept;
    for (const d of got.declined) this.#declined.add(d);
    let seq = Math.max(maxSeq(onDisk), got.keptSeq);
    const renamed = new Map<string, string>();
    /*
     * **ファイルに同じ覚え（同じ種類・同じ題・決め直されていない）が在れば、二つにしない。**読めない間は空から始めるので、
     * 立ち上げのときの最初からの覚え（`seedLessons`）は必ずファイルの分と重なる。そのまま後ろへ足すと、新しい時刻の写しが
     * 「二度としないこと」の 12 件を占め、利用者が教えた分が依頼に載らなくなっていた。最初からの覚えは数えずに捨て、
     * ほかは `relabel` と同じく数え直してファイルの側へ畳む。
     */
    const fresh: MemoryEntry[] = [];
    const folded: [MemoryEntry, MemoryEntry][] = [];
    for (const e of this.#entries) {
      const key = normalizeTitle(e.title);
      // 忘れた最初からの覚え（ファイルの declined）は、読めない間に入れ直していても足し戻さない
      if (e.source === 'builtin' && this.#declined.has(key)) { renamed.set(e.id, e.id); continue; }
      const twin = e.supersededBy === undefined
        ? onDisk.find((d) => d.kind === e.kind && normalizeTitle(d.title) === key && !d.supersededBy && d.root === e.root)
        : undefined;
      if (twin) {
        renamed.set(e.id, twin.id);
        if (e.source !== 'builtin') folded.push([twin, e]);
        continue;
      }
      seq += 1;
      renamed.set(e.id, `m${seq}`);
      fresh.push(e);
    }
    for (const [twin, e] of folded) {
      twin.confirms += e.confirms;
      twin.seenAt = Math.max(twin.seenAt, e.seenAt);
      if (e.used) twin.used = (twin.used ?? 0) + e.used;
      if (e.helped) twin.helped = (twin.helped ?? 0) + e.helped;
      if (e.misled) twin.misled = (twin.misled ?? 0) + e.misled;
      if (e.outcome) twin.outcome = e.outcome;
      if (betterDetail(e.detail, twin.detail)) twin.detail = e.detail;
      for (const t of e.tags) if (!twin.tags.includes(t)) twin.tags.push(t);
      if (twin.supersedes === undefined && e.supersedes !== undefined) twin.supersedes = renamed.get(e.supersedes) ?? e.supersedes;
    }
    const mine = fresh.map((e) => ({
      ...e,
      id: renamed.get(e.id)!,
      ...(e.supersedes !== undefined ? { supersedes: renamed.get(e.supersedes) ?? e.supersedes } : {}),
      ...(e.supersededBy !== undefined ? { supersededBy: renamed.get(e.supersededBy) ?? e.supersededBy } : {}),
    }));
    this.#entries = [...onDisk, ...mine];
    this.#seq = seq;
    this.#onDisk = new Map(onDisk.map((e) => [e.id, sameness(e)]));
    this.#unreadable = undefined;
    this.#era = {};
    this.#waiting = [];
    this.#gone = new Set();
    return true;
  }

  async #saveNow(): Promise<void> {
    if (!this.#path || !this.#dirty) return;
    // 別のプロセス（画面と端末）が同じファイルを書く。読んで合わせて書く間を錠で包む（包まないと、読んだ後によそが書いた分を消す）
    const path = this.#path;
    // 錠の中では読み直しと置き換えのやり直し（Windows で掴まれたとき、合わせて数秒）が走る。待つ側はそれより長く待ち、
    // 古い錠と見るのはさらに長くする（持っている間に古いと見られて、二人が同時に書くことにしない）
    await withFileLock(path, () => this.#saveLocked(), { timeoutMs: 8_000, staleMs: 30_000 });
  }

  async #saveLocked(): Promise<void> {
    if (!this.#path || !this.#dirty) return;
    if (this.#unreadable && !(await this.#rejoin())) {
      throw new Error(`記憶のファイルを読めなかった（${this.#unreadable}）ので、上書きしないよう保存を止めています: ${this.#path}`);
    }
    this.#dirty = false;
    /*
     * 退けた行は、**保存の直前のファイルから取り直す。**読み込んだときの形を書くと、動いている間に手で消した行
     * （秘密を書いてしまった行など）や手で直した行を、古い形のまま書き戻していた。
     */
    try {
      const now = parseEntries(await this.#readRetrying(this.#path));
      this.#kept = now.kept;
      // 戻した分（restore で外した題）は、手元に無いので足し戻さない。手元で忘れた分は手元の Set に在る
      for (const d of now.declined) if (!this.#undeclined.has(d)) this.#declined.add(d);
      this.#seq = Math.max(this.#seq, now.keptSeq);
      /*
       * **手元が知らない覚えを、ファイルから消さない。**退けていた行を動いている間に手で直すと、その行は退けた行（kept）から
       * 外れて覚えの側へ移る。手元の覚えだけを書いていたので、直した行が次の保存で消えていた。手元で外した番号は足し戻さない。
       */
      const disk = new Map(now.entries.map((e) => [e.id, e]));
      /*
       * **よそで消された覚えを書き戻さない。**前に読んだときディスクに在り、いまは無い番号は、別のプロセスが忘れた（消した）もの。
       * 手元は持ったままなので、そのまま書くと忘れた覚えが戻っていた。退けた行に回っただけ（手で読めなくした）なら消さない
       */
      const keptIds = new Set(now.kept.flatMap((l) => [...l.matchAll(/"id"\s*:\s*"(m\d+)"/g)].map((m) => m[1]!)));
      // 前に見た覚えか（同じ番号で、覚えた時刻・種類・題も同じ）。番号だけで見ると、よそが消した番号を別の覚えに使い回したときに取り違える
      const knew = (d: MemoryEntry): boolean => this.#onDisk.get(d.id) === sameness(d);
      const goneElsewhere = new Set([...this.#onDisk].filter(([id, was]) => {
        if (keptIds.has(id)) return false;
        const there = disk.get(id);
        return !there || sameness(there) !== was;
      }).map(([id]) => id));
      if (goneElsewhere.size > 0) {
        // 手元の写し（前に見たときのまま）だけを外す。同じ番号で手元が新しく覚え直したもの（付け直しの対象）は残す
        this.#entries = this.#entries.filter((e) => !(goneElsewhere.has(e.id) && this.#onDisk.get(e.id) === sameness(e)));
        for (const e of this.#entries) {
          if (e.supersedes !== undefined && goneElsewhere.has(e.supersedes) && !this.#entries.some((x) => x.id === e.supersedes)) delete e.supersedes;
          if (e.supersededBy !== undefined && goneElsewhere.has(e.supersededBy) && !this.#entries.some((x) => x.id === e.supersededBy)) delete e.supersededBy;
        }
      }
      /*
       * 手元で新しく覚えた分（前に見たときディスクに無かった番号）を、ディスクと合わせる。
       * - **よそが同じ題を覚えていれば、そちらへ畳む**（両方が空から最初の覚えを入れると、同じ題が二件になっていた）。最初からの覚えは捨てる
       * - **同じ番号をよそが別の覚えに配っていたら、手元の側を付け直す。**両方が m40 まで読んでから別々に覚えると、どちらも m41 を配り、
       *   番号が同じなので手元の側だけが書かれ、よその覚えが消えていた
       */
      let top = Math.max(this.#seq, maxSeq(now.entries), now.keptSeq);
      const moved = new Map<string, string>();
      const folded = new Set<MemoryEntry>();
      for (const e of this.#entries) {
        if (this.#onDisk.has(e.id) && knew(e)) continue;
        const there = disk.get(e.id);
        if (there && sameness(there) === sameness(e)) continue;
        const key = normalizeTitle(e.title);
        const twin = e.supersededBy === undefined
          ? now.entries.find((d) => !knew(d) && d.kind === e.kind && normalizeTitle(d.title) === key && d.root === e.root && !d.supersededBy)
          : undefined;
        if (twin) {
          if (e.source !== 'builtin') {
            twin.confirms += e.confirms;
            twin.seenAt = Math.max(twin.seenAt, e.seenAt);
            if (e.used) twin.used = (twin.used ?? 0) + e.used;
            if (e.helped) twin.helped = (twin.helped ?? 0) + e.helped;
            if (e.misled) twin.misled = (twin.misled ?? 0) + e.misled;
            for (const t of e.tags) if (!twin.tags.includes(t)) twin.tags.push(t);
          }
          moved.set(e.id, twin.id);
          folded.add(e);
          continue;
        }
        if (there) {
          top += 1;
          moved.set(e.id, `m${top}`);
        }
      }
      if (moved.size > 0) {
        this.#entries = this.#entries.filter((e) => !folded.has(e)).map((e) => ({
          ...e,
          id: folded.has(e) ? e.id : (moved.get(e.id) ?? e.id),
          ...(e.supersedes !== undefined ? { supersedes: moved.get(e.supersedes) ?? e.supersedes } : {}),
          ...(e.supersededBy !== undefined ? { supersededBy: moved.get(e.supersededBy) ?? e.supersededBy } : {}),
        }));
        this.#seq = Math.max(this.#seq, top);
        // 番号が変わったので、番号で記録していたもの（忘れた棚・添えた覚えの点付け・戻るのを待つ繋がり）は使わせない
        this.#era = {};
        this.#waiting = [];
      }
      const mine = new Set(this.#entries.map((e) => e.id));
      // 手元で忘れた番号でも、ディスクの中身が前に見たものと違えば、よそが新しく覚えた別の覚え（取り込む）
      const foreign = now.entries.filter((e) => !mine.has(e.id) && !(this.#gone.has(e.id) && knew(e)));
      if (foreign.length > 0) {
        this.#entries = [...this.#entries, ...foreign].sort((a, b) => a.at - b.at);
        this.#seq = Math.max(this.#seq, maxSeq(foreign));
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        // 錠の中で読めなければ書かない。合わせずに手元の分だけを書くと、よそが書いた分を消し、消えたことも残らなかった
        this.#dirty = true;
        throw e;
      }
      this.#kept = [];
    }
    const body = [
      ...this.#entries.map((e) => JSON.stringify(e)),
      ...[...this.#declined].map((d) => JSON.stringify({ declined: d })),
      ...this.#kept,
    ].join('\n') + '\n';
    try {
      await mkdir(dirname(this.#path), { recursive: true });
      await this.#write(this.#path, body);
      this.#onDisk = new Map(this.#entries.map((e) => [e.id, sameness(e)]));
      // 書けたら、手元で忘れた番号はもう要らない（ディスクにも無い。残すと、よそが同じ番号を使い回した覚えを取り込まずに消していた）
      this.#gone = new Set();
    } catch (e) {
      this.#dirty = true;
      throw e;
    }
  }

  /**
   * 覚える。
   * 同じことを既に覚えていれば、上書きではなく確認回数を増やす。
   * 何度も確かめられたことほど、思い出されやすくなる。
   */
  remember(input: {
    kind: MemoryKind;
    title: string;
    detail?: string;
    tags?: string[];
    outcome?: 'worked' | 'failed';
    source?: string;
    supersedes?: string;
    root?: string;
    now?: number;
  }): RememberResult {
    const now = input.now ?? Date.now();
    // 秘密は伏せてから覚える（打った文や添付の中身に入っていた API キーが、題として残り、語が重なるたびに依頼へ差し込まれていた）
    const title = redactSecrets(input.title.trim());
    if (input.detail !== undefined) input = { ...input, detail: redactSecrets(input.detail) };
    // 札にも秘密を残さない（題と中身は伏せていたのに、札は元の字のまま残し、呼び戻しの語にもなっていた）
    const safeTags = (input.tags ?? []).map((t) => redactSecrets(t));
    const key = normalizeTitle(title);
    const root = input.root !== undefined ? placeKey(input.root) : undefined;

    /*
     * 別の作業場で覚えた同じ題は、別の覚え（「テストを直して」は作業場ごとに別の話）。作業場の無い古い覚えにも畳まない
     * （畳むと作業場が付かないまま、別の作業場で起きたことが混ざり続ける）
     */
    const existing = this.#entries.find(
      (e) => e.kind === input.kind && normalizeTitle(e.title) === key && !e.supersededBy && e.root === root,
    );

    if (existing) {
      existing.confirms += 1;
      existing.seenAt = now;
      // 詳しい話が増えたなら受け取る。減らしはしない。
      // **ただし、汲み取れた話は、長さに関係なく受け取る。**
      // 長さだけで決めていたので、決め文句（未消化）のほうが長いと、
      // 考えて掴んだ中身が捨てられていた。
      // 試したことの結果が来たら、中身もその回のものにする（結果だけ新しくなり、中身は前の「通らなかった」のまま食い違った）
      if (input.detail && ((existing.kind === 'attempt' && input.outcome) || betterDetail(input.detail, existing.detail))) existing.detail = input.detail;
      for (const t of safeTags) if (!existing.tags.includes(t)) existing.tags.push(t);
      if (input.outcome) existing.outcome = input.outcome;
      this.#dirty = true;
      return { entry: existing, isNew: false, reinforced: true, conflicts: [] };
    }

    this.#seq += 1;
    const entry: MemoryEntry = {
      id: `m${this.#seq}`,
      kind: input.kind,
      title,
      detail: input.detail ?? '',
      tags: [...new Set(safeTags)],
      at: now,
      seenAt: now,
      confirms: 1,
      outcome: input.outcome,
      source: input.source,
      supersedes: input.supersedes,
      ...(root !== undefined ? { root } : {}),
    };

    // 決め直しは消さずに繋ぐ。なぜ変えたのかを失わないため。
    if (input.supersedes) {
      const old = this.#entries.find((e) => e.id === input.supersedes);
      if (old) old.supersededBy = entry.id;
    }

    const conflicts = entry.kind === 'decision' && !input.supersedes
      ? this.#contradicting(entry)
      : [];

    this.#entries.push(entry);
    this.#dirty = true;
    return { entry, isNew: true, reinforced: false, conflicts };
  }

  /**
   * 前の決定と食い違っていないか。
   * 同じ話題（tag が重なる）で、まだ生きている別の決定を挙げる。
   * 食い違いかどうかの最終判断は人がする。ここは見つけて出すまで。
   */
  #contradicting(entry: MemoryEntry): MemoryEntry[] {
    if (entry.tags.length === 0) return [];
    return this.#entries.filter((e) =>
      e.kind === 'decision'
      && !e.supersededBy
      && e.id !== entry.id
      && e.tags.some((t) => entry.tags.includes(t))
      && normalizeTitle(e.title) !== normalizeTitle(entry.title));
  }

  /**
   * 思い出す。
   * 語の重なり・新しさ・確認回数で並べる。
   * 確認回数を効かせるのは、「一度きりの思いつき」より
   * 「何度も確かめられたこと」を先に出すため。
   */
  /**
   * 嫌がられたこと。**新しい順に。**
   * 話題に関係なく効くので、思い出すときは必ず先頭に付ける。
   */
  displeasures(limit = 12): MemoryEntry[] {
    // **同じ時刻のときの順を決めておく。**最初に入れる分は同じミリ秒で並ぶので、
    // 時刻だけで並べると、どれが載るかが呼ぶたびに変わる（実際に変わった）。
    // 決まらないと、載る中身が回ごとに入れ替わって、追いかけられない。
    const order = (e: MemoryEntry): number => Number(e.id.replace(/^m/, '')) || 0;
    return this.#entries
      // 置き換えられた古い覚えは出さない（必ず混ぜる枠を通ると、話題に関係なく新旧の二つが並んだ）
      .filter((e) => e.kind === 'displeasure' && !e.supersededBy)
      .sort((a, b) => b.seenAt - a.seenAt || order(b) - order(a))
      .slice(0, limit);
  }

  recall(query: string, opts: RecallOptions = {}): MemoryEntry[] {
    // 作業場は鍵に揃えて比べる（覚えるときと同じ `placeKey`）
    const here = opts.root !== undefined ? placeKey(opts.root) : undefined;
    const now = Date.now();
    const q = new Set(tokenize(query));
    const limit = opts.limit ?? 8;

    /*
     * **語が一つも取れない依頼では、話題では思い出さない。**
     *
     * 下の当たり判定は `overlap === 0 && q.size > 0` で外していた。語がゼロだと
     * この条件が成り立たず、**全部が当たりとして残り**、新しい順に 12 件が
     * 依頼へ差し込まれる。実機で「1+1=」と送ったら、関係の無い
     * 「src/a.txt を書き換えて」が付いて出た（tokenize('1+1=') は []）。
     * 重ねる根拠が無いのだから、何も足さないのが正しい。
     */
    if (q.size === 0) {
      if (opts.lessons === false) return [];
      if (opts.kinds && !opts.kinds.includes('displeasure')) return [];
      return this.displeasures();
    }

    const scored = this.#entries
      .filter((e) => (opts.includeSuperseded ? true : !e.supersededBy))
      .filter((e) => (opts.kinds ? opts.kinds.includes(e.kind) : true))
      .filter((e) => !here || !e.root || e.root === here || !boundToPlace(e))
      .map((e) => {
        // 触ったものも語に割る。`src/auth.ts` を丸ごと一語で持つと、
        // 「src/auth.ts を直す」と書いても重ならない（区切りで割れるため）。
        const words = new Set([
          ...tokenize(e.title), ...tokenize(e.detail),
          ...e.tags.map((t) => t.toLowerCase()), ...e.tags.flatMap((t) => tokenize(t)),
        ]);
        let overlap = 0;
        for (const t of q) if (words.has(t)) overlap += 1;
        // 話題が全く重ならないものは思い出さない。雑音になるだけ。
        if (overlap === 0 && q.size > 0) return undefined;

        /*
         * **成功と失敗を、同じ引き方にしない。**
         *
         *   成功は、その場の事情込みで成り立っている。他所へ持ち出すと外れる。
         *   失敗は、やってはいけない形なので、場所が変わっても効く。
         *
         * だから成功には**近いことの証拠**を要求し（語が二つ以上重なるか、
         * 触ったものが同じか）、失敗は一つ掠っただけでも拾う。
         * ここを対称にしていたので、うまくいった手が別の場所へ流れ出て、
         * 「その手しか取らない」を作っていた。
         */
        const sameGround = overlap >= 2 || e.tags.some((t) => q.has(t.toLowerCase()));
        if (transfersOnlyNearby(e) && q.size > 0 && !sameGround) return undefined;

        // 未来の時刻（時計のずれ）は今として数える（負の年数で点が跳ね上がる・無限・負になり、並びが崩れていた）
        const ageDays = Math.max(0, now - e.seenAt) / DAY;
        const recency = 1 / (1 + ageDays / 30);
        const trust = Math.log2(1 + e.confirms);
        // 決めたことと好みは、古くても効き続ける
        const kindWeight = e.kind === 'decision' || e.kind === 'preference' ? 1.5 : 1;
        // 失敗は、遠くまで効く。同じ重なりなら、こちらを先に出す。
        const reach = carriesFar(e) ? 1.4 : 1;
        // **役に立ったかで重みを変える。**当たった覚えは上へ、外した覚えは下へ。
        // 一度も使っていないものは 1（下げも上げもしない）。
        return { e, score: (overlap * 2 + recency + trust) * kindWeight * reach * usefulness(e) };
      })
      .filter((x): x is { e: MemoryEntry; score: number } => !!x);

    scored.sort((a, b) => b.score - a.score || b.e.seenAt - a.e.seenAt);

    // **嫌がられたことは、話題に関係なく必ず混ぜる。**
    // 語が重ならないから外す、をやると、別の作業で同じ地雷を踏む。
    // 限度（limit）にも数えない。減らしてよい種類のものではない。
    // 必ず混ぜる分（と、混ぜないと言われた分）は、件数で切る**前に**外す。切った後で外していたので、枠を嫌がられたことが食い、
    // ほかの覚えが 1 件も残らないことがあった。必ず混ぜる枠から押し出された古いものは、話題で当たれば残す
    const takeLessons = opts.lessons !== false && !(opts.kinds && !opts.kinds.includes('displeasure'));
    const must = takeLessons ? this.displeasures() : [];
    const mustIds = new Set(must.map((e) => e.id));
    const hits = scored
      .filter((x) => (opts.lessons === false ? x.e.kind !== 'displeasure' : !mustIds.has(x.e.id)))
      .slice(0, limit)
      .map((x) => x.e);
    return [...must, ...hits];
  }

  /**
   * 思い出して添えたことを控える。**添えた事実だけ**で、まだ良し悪しは付けない。
   */
  noteRecalled(ids: readonly string[]): void {
    for (const id of ids) {
      const e = this.#entries.find((x) => x.id === id);
      if (!e) continue;
      e.used = (e.used ?? 0) + 1;
      this.#dirty = true;
    }
  }

  /**
   * 添えた結果を書き戻す。
   *
   * **確かめていない回では呼ばない。**呼ぶ側が `passed` / `failed` を
   * 確かめてから渡す。確かめていない回で重みを動かすと、思い込みが固まる。
   */
  noteOutcome(ids: readonly string[], ok: boolean): void {
    for (const id of ids) {
      const e = this.#entries.find((x) => x.id === id);
      if (!e) continue;
      if (ok) e.helped = (e.helped ?? 0) + 1;
      else e.misled = (e.misled ?? 0) + 1;
      this.#dirty = true;
    }
  }

  /**
   * 同じことを前に試して駄目だったか。
   * これを見ずに始めるから、同じ失敗を繰り返す。
   */
  failedBefore(approach: string, limit = 3, root?: string): MemoryEntry[] {
    // 絞ってから件数で切る（先に limit×3 で切っていたので、重なりの多い「うまくいった」手が枠を埋め、本当に駄目だった手が落ちた）。
    // 駄目だったと分かっている手（failed と、起きたこと）だけを返す。確かめていない回は「駄目だった」ではない
    return this.recall(approach, { kinds: ['attempt', 'incident'], limit: Number.MAX_SAFE_INTEGER, ...(root ? { root } : {}) })
      .filter((e) => e.outcome === 'failed' || e.kind === 'incident')
      .slice(0, limit);
  }

  /**
   * 忘れる。
   *
   * **人が消せない記憶は、溜まる一方になる。**外れた覚えは重みで下がるが、
   * 「そもそも間違っている」と分かったものは、下げるのではなく消す。
   * 消したかどうかを返す（黙って何もしない、を作らない）。
   */
  forget(id: string): boolean {
    return this.remove(id) !== undefined;
  }

  /**
   * 忘れて、戻すのに要るもの（消した覚えと、それを指していた繋がり）を返す。無ければ `undefined`。
   *
   * 画面の「忘れる」は一押しで効く。押し間違えた覚えを戻せないと、覚え直すまで同じ失敗を繰り返す。
   */
  remove(id: string): Forgotten | undefined {
    const entry = this.#entries.find((e) => e.id === id);
    if (!entry) return undefined;
    this.#entries = this.#entries.filter((e) => e !== entry);
    this.#gone.add(id);
    if (entry.source === 'builtin') {
      const key = normalizeTitle(entry.title);
      this.#declined.add(key);
      this.#undeclined.delete(key);
    }
    // 繋がりも切っておく。消した先を指したままにすると、履歴が辿れなくなる。
    const links: Forgotten['links'] = [];
    for (const e of this.#entries) {
      if (e.supersedes === id) { delete e.supersedes; links.push({ id: e.id, field: 'supersedes' }); }
      if (e.supersededBy === id) { delete e.supersededBy; links.push({ id: e.id, field: 'supersededBy' }); }
    }
    this.#dirty = true;
    return { entry: { ...entry }, links, era: this.#era };
  }

  /**
   * `remove` で忘れたものを戻す。戻したら `true`、戻さなければその理由を返す。
   *
   * - `reloaded`: 取った後に読み直した（番号が振り直されたか、別のファイルの中身になった）。同じ番号が別の覚えを指すので戻さない
   * - `taken`: 同じ番号が既に在る
   * - `duplicate`: 同じ種類・同じ題の覚えが、決め直されずに在る（忘れている間に覚え直した）。二つにしない
   *
   * 繋がりは、相手が居るものだけ戻す。自分の側の `supersedes` / `supersededBy` も、相手が居なければ外し、
   * 相手の向こう側の欄が空なら繋ぎ直す（片側だけ残ると、居ない相手に決め直された扱いで、思い出されなくなる）。
   * 相手が、その間に別の先を指すようになっていたら上書きしない。並びは覚えた時刻の順に戻す。
   */
  restore(f: Forgotten): true | RestoreRefusal {
    if (f.era !== this.#era) return 'reloaded';
    if (this.#entries.some((e) => e.id === f.entry.id)) return 'taken';
    const key = normalizeTitle(f.entry.title);
    // 同じ作業場の分だけを見る（覚えるときの畳みと同じ。別の作業場に同じ題が在ると戻せず、棚からも消えていた）
    if (this.#entries.some((e) => e.kind === f.entry.kind && normalizeTitle(e.title) === key && !e.supersededBy && e.root === f.entry.root)) return 'duplicate';
    const entry = { ...f.entry };
    const find = (id: string): MemoryEntry | undefined => this.#entries.find((x) => x.id === id);
    // 自分が戻るのを待っていた繋がり（先に戻った相手から、自分へ。向こう側は下で揃える）
    for (const w of this.#waiting.filter((x) => x.id === entry.id)) {
      if (entry[w.field] === undefined && find(w.to)) entry[w.field] = w.to;
    }
    this.#waiting = this.#waiting.filter((x) => x.id !== entry.id);
    if (entry.supersedes !== undefined) {
      const other = find(entry.supersedes);
      if (!other) delete entry.supersedes;
      else if (other.supersededBy === undefined) other.supersededBy = entry.id;
    }
    if (entry.supersededBy !== undefined) {
      const other = find(entry.supersededBy);
      if (!other) delete entry.supersededBy;
      else if (other.supersedes === undefined) other.supersedes = entry.id;
    }
    for (const link of f.links) {
      const e = find(link.id);
      if (!e) this.#waiting.push({ ...link, to: entry.id });
      else if (e[link.field] === undefined) e[link.field] = entry.id;
    }
    if (entry.source === 'builtin' && this.#declined.delete(key)) this.#undeclined.add(key);
    this.#gone.delete(entry.id);
    const at = this.#entries.findIndex((e) => e.at > entry.at);
    if (at < 0) this.#entries.push(entry); else this.#entries.splice(at, 0, entry);
    this.#dirty = true;
    return true;
  }

  /** いまの読み直しの代。保存の前後で比べると、その間に番号が振り直されたかが分かる。 */
  get era(): object {
    return this.#era;
  }

  /**
   * 最初から持っている「二度としないこと」を入れる。
   *
   * **入れた直後の何も知らない状態から、同じ地雷を踏み直させない。**
   * 既に在るものは触らない（覚え直した中身を、決め打ちで上書きしない）。
   *
   * @returns 入れた数
   */
  seedLessons(): number {
    const have = new Set(this.#entries.filter((e) => e.kind === 'displeasure')
      .map((e) => normalizeTitle(e.title)));
    let added = 0;
    for (const l of BUILTIN_LESSONS) {
      if (have.has(normalizeTitle(l.title)) || this.#declined.has(normalizeTitle(l.title))) continue;
      this.remember({
        kind: 'displeasure',
        title: l.title,
        detail: lessonLine(l),
        tags: ['builtin'],
        source: 'builtin',
      });
      added += 1;
    }
    return added;
  }

  /**
   * 表題を付け直す。同じ表題が既に在れば、そちらへ畳む。
   *
   * 覚えた時点では場面が分からないことがある（会話の最初など）。
   * あとで場面が分かったときに、**同じ場面の覚えを二つに割らない**ために要る。
   */
  relabel(id: string, given: string): MemoryEntry | undefined {
    // 覚えるときと同じく、秘密は伏せてから題にする
    const title = redactSecrets(given);
    const entry = this.#entries.find((e) => e.id === id);
    if (!entry) return undefined;
    const key = normalizeTitle(title);
    if (normalizeTitle(entry.title) === key) return entry;

    const other = this.#entries.find(
      // 同じ作業場のものだけ畳む（覚えるときと同じ。別の作業場の覚えに畳み、中身を混ぜていた）
      (e) => e.id !== id && e.kind === entry.kind && e.root === entry.root && normalizeTitle(e.title) === key && !e.supersededBy,
    );
    if (!other) {
      entry.title = title;
      this.#dirty = true;
      return entry;
    }
    // 同じ場面の覚えが既に在る。数え直して、良いほうの中身を残す。
    other.confirms += entry.confirms;
    other.seenAt = Math.max(other.seenAt, entry.seenAt);
    other.used = (other.used ?? 0) + (entry.used ?? 0);
    other.helped = (other.helped ?? 0) + (entry.helped ?? 0);
    other.misled = (other.misled ?? 0) + (entry.misled ?? 0);
    if (betterDetail(entry.detail, other.detail)) other.detail = entry.detail;
    for (const t of entry.tags) if (!other.tags.includes(t)) other.tags.push(t);
    this.#entries = this.#entries.filter((e) => e.id !== id);
    this.#gone.add(id);
    this.#dirty = true;
    return other;
  }

  /** 中身を直に書き換えたときに呼ぶ。保存し忘れを防ぐ。 */
  touch(): void { this.#dirty = true; }

  /** 決め直しの履歴を古い順に辿る。 */
  history(id: string): MemoryEntry[] {
    const chain: MemoryEntry[] = [];
    let cur = this.#entries.find((e) => e.id === id);
    while (cur) {
      chain.unshift(cur);
      const prev: string | undefined = cur.supersedes;
      cur = prev ? this.#entries.find((e) => e.id === prev) : undefined;
    }
    return chain;
  }

  /**
   * 記憶を刈る。
   * 決めたことと好みは残す。それが土台だから。
   * 一度しか見ていない古い事実から先に落とす。
   */
  compact(opts: { max?: number; now?: number } = {}): number {
    const max = opts.max ?? 500;
    if (this.#entries.length <= max) return 0;
    const now = opts.now ?? Date.now();

    // **嫌がられたことは刈らない。**忘れた瞬間に、同じ地雷を踏む。
    const isKeeper = (e: MemoryEntry) =>
      e.kind === 'decision' || e.kind === 'preference' || e.kind === 'displeasure' || !!e.supersededBy;
    const keep = this.#entries.filter(isKeeper);
    const rest = this.#entries.filter((e) => !isKeeper(e));

    // **効いた実績を、新しさより重く見る。**
    // 新しさと確認回数だけで刈ると、「今日覚えたばかりの外れ」が残り、
    // 「半年前から何度も効いている当たり」が消える。それは、使うほど
    // 手持ちが悪くなるということ。
    const worth = (e: MemoryEntry): number => {
      const base = Math.log2(1 + e.confirms) + 1 / (1 + Math.max(0, now - e.seenAt) / DAY / 30);
      // **失敗は長く持つ。**他所でも効くものを、その場限りのものと同じ速さで
      // 捨てない。うまくいった手は、その場の事情ごと古くなる。
      const reach = carriesFar(e) ? 1.5 : 1;
      return (base * usefulness(e) + (e.helped ?? 0) * 0.5 - (e.misled ?? 0) * 0.5) * reach;
    };
    // **同じ重さのときに、何を残すかを決めておく。**
    // ここを配列の並び任せにしていたので、同点になった瞬間に、
    // どちらが残るかが「いつ走らせたか」で変わった（60日前の失敗と、
    // たった今の分かったことが、ちょうど同じ重さになる場合がある）。
    // 走らせる場所や時刻で結果が変わるものを、残しておかない。
    const EVEN = 1e-6; // ミリ秒のずれで生まれる差は、差と見ない
    rest.sort((a, b) => {
      const d = worth(b) - worth(a);
      if (Math.abs(d) > EVEN) return d;
      // 同点なら、他所でも効く方（失敗・嫌がられたこと）を残す。
      const reach = Number(carriesFar(b)) - Number(carriesFar(a));
      if (reach !== 0) return reach;
      if (b.seenAt !== a.seenAt) return b.seenAt - a.seenAt;
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    });

    const room = Math.max(0, max - keep.length);
    const dropped = rest.length - Math.min(rest.length, room);
    for (const e of rest.slice(room)) this.#gone.add(e.id);
    this.#entries = [...keep, ...rest.slice(0, room)].sort((a, b) => a.at - b.at);
    this.#dirty = true;
    return dropped;
  }
}

const KIND_LABEL: Record<MemoryKind, string> = {
  decision: '決めたこと',
  attempt: '試したこと',
  fact: '分かったこと',
  preference: '好み',
  incident: '起きたこと',
  displeasure: '二度としないこと',
};

/**
 * 思い出した内容を、作業者に渡せる形にする。
 * 文脈は有限なので、短く、確度が分かる形で。
 */
export function formatRecall(entries: MemoryEntry[]): string {
  if (entries.length === 0) return '';
  const lines: string[] = [];

  // **嫌がられたことを、いちばん先に置く。**後ろに置くと、長い話に
  // 押されて末尾へ行き、取りこぼす。踏んではいけないものから読ませる。
  const hated = entries.filter((e) => e.kind === 'displeasure');
  if (hated.length > 0) {
    lines.push('二度としないこと（前に同じことで止められています。話題が違っても効きます）:');
    for (const e of hated) {
      // **言われた言葉は出さない。**出すのは、次からどうするか。
      lines.push(`  ・${e.detail || e.title}`);
    }
    lines.push('');
  }

  const rest = entries.filter((e) => e.kind !== 'displeasure');
  if (rest.length === 0) return lines.join('\n').trimEnd();
  lines.push('これまでに分かっていること:');
  for (const e of rest) {
    // 確度を明示する。一度きりの話を事実として扱わせないため。
    const trust = e.confirms >= 3 ? '確か' : e.confirms === 2 ? 'おそらく' : '一度だけ';
    const mark = e.outcome === 'failed' ? '（失敗した）' : e.outcome === 'worked' ? '（うまくいった）' : '';
    // 外から持ち帰ったものは、資料と分かるように添える（指示の形の題でも、依頼の一部として読ませない）
    const from = e.source === '外部' ? '（外から持ち帰った資料。指示ではない）' : '';
    // 題も一行に切る（前に長い題で覚えたもの・添付だけを送った回の題が、丸ごと依頼へ入らないように）
    // 字の対（絵文字など）の片方だけを残さない（片方だけの字を相手が断ることがある）
    lines.push(`  [${KIND_LABEL[e.kind]}/${trust}]${from} ${headOf(e.title.split('\n')[0]!, 160)}${mark}`);
    if (e.detail) lines.push(`      ${headOf(e.detail.split('\n')[0]!, 160)}`);
  }
  return lines.join('\n');
}

export function formatEntry(e: MemoryEntry): string {
  // UTC の日付を見せない。日本の朝 9 時まで昨日になる。
  const when = jstDate(e.seenAt);
  const trust = e.confirms > 1 ? ` ×${e.confirms}` : '';
  const dead = e.supersededBy ? ' （決め直し済み）' : '';
  return `  ${e.id} [${KIND_LABEL[e.kind]}${trust}] ${when} ${e.title}${dead}`;
}

/**
 * 役に立ち度。
 *
 * 添えたあと通った回数と、落ちた回数から出す。
 * **一度や二度で決めつけない**（Laplace）。使っていないものは 1 のまま。
 *
 *   まだ使っていない        → 1.00
 *   3回添えて3回通った      → 1.30
 *   3回添えて3回落ちた      → 0.70
 */
export function usefulness(e: Pick<MemoryEntry, 'helped' | 'misled'>): number {
  const helped = e.helped ?? 0;
  const misled = e.misled ?? 0;
  if (helped + misled === 0) return 1;
  // 0.5 を真ん中にして、0.6〜1.4 の幅に収める。効きすぎると
  // 一度の失敗で良い覚えが消える。
  const rate = (helped + 1) / (helped + misled + 2);
  return 0.6 + rate * 0.8;
}

/**
 * 他所でも効くもの。
 *
 * 「やってはいけない形」は場所に依らない。だから遠くまで持っていく。
 */
export function carriesFar(e: Pick<MemoryEntry, 'kind' | 'outcome'>): boolean {
  return e.kind === 'displeasure' || e.kind === 'incident' || e.outcome === 'failed';
}

/** 場に依る覚え（作業場をまたいで持ち出さない）。決めたこと・好み・嫌がられたことは、どの作業場でも効く。 */
function boundToPlace(e: Pick<MemoryEntry, 'kind'>): boolean {
  return e.kind === 'attempt' || e.kind === 'fact' || e.kind === 'incident';
}

/**
 * 近くでしか効かないもの。
 *
 * うまくいった手は、その場の事情込みで成り立っている。
 * 別の場所へ持ち出すと、たいてい外れる（しかも「その手しか取らない」を作る）。
 */
export function transfersOnlyNearby(e: Pick<MemoryEntry, 'kind' | 'outcome'>): boolean {
  return e.outcome === 'worked';
}

/**
 * どちらの中身を残すか。
 *
 * **汲み取れた話を、決め文句で上書きしない。**長さだけで決めていたので、
 * 「未消化」の決め文句のほうが長いと、考えて掴んだ中身が捨てられていた。
 */
export function betterDetail(next: string, current: string): boolean {
  if (!next) return false;
  if (!current) return true;
  const rawNext = next.includes('未消化');
  const rawCurrent = current.includes('未消化');
  if (rawNext !== rawCurrent) return rawCurrent; // 汲み取れたほうを採る
  return next.length > current.length;
}

/** 同じ番号が同じ覚えを指しているかを見る鍵（覚えた時刻と題）。 */
function sameness(e: MemoryEntry): string {
  return `${e.at}\n${e.kind}\n${e.title}`;
}

/** 記憶の一件の形を確かめる（思い出すときに使う所だけ）。 */
function isEntry(e: unknown): e is MemoryEntry {
  if (typeof e !== 'object' || e === null) return false;
  const m = e as Partial<MemoryEntry>;
  // 思い出す・並べる・日付を出す所で触る欄の形も見る（`tags:[1]`・`seenAt:"x"` を通すと、思い出すたびに落ちていた）
  // null は無いのと同じに扱う（NaN を JSON にすると null になる。退けると棚から消え、最初からの覚えなら入れ直されて二重になる）
  const optNum = (v: unknown): boolean => v === undefined || v === null || (typeof v === 'number' && Number.isFinite(v));
  return typeof m.id === 'string' && typeof m.kind === 'string' && typeof m.title === 'string'
    && Array.isArray(m.tags) && m.tags.every((t) => typeof t === 'string')
    && (m.detail === undefined || typeof m.detail === 'string')
    && optNum(m.at) && optNum(m.seenAt) && optNum(m.confirms);
}

/** 無い欄を埋める（`detail` の無い行を通して、思い出すときに `undefined` を割ろうとして落ちていた）。 */
function filled(e: MemoryEntry): MemoryEntry {
  const m = e as Partial<MemoryEntry> & MemoryEntry;
  if (m.detail == null) m.detail = '';
  if (m.at == null) m.at = 0;
  if (m.seenAt == null) m.seenAt = m.at;
  if (m.confirms == null) m.confirms = 1;
  return m;
}

/**
 * 記憶のファイルの中身を一件ずつに。1行壊れても記憶全体を失わない（JSONL にしているのはこのため）。
 * 壊れた行・形の違う行は、思い出す側には渡さず（止まるため）、元の文のまま `kept` に分ける（保存で書き戻す）。
 * `keptSeq` は分けた行が持つ番号のいちばん大きいもの（直して戻されたときに、新しく配る番号とぶつけない）。
 */
/**
 * 記録ファイルを読む。読み方は一つ（起動・読めなかった後の合わせ直し・保存のときの取り込み）。
 *
 * 未来の時刻（時計が進んでいた間に覚えた）は、読んだ時点に丸める。丸めないと、時計を直した後もその一件が
 * 「いちばん新しい」まま嫌がられたことの先頭に居座り、後から覚えた分が載らない。
 */
function parseEntries(raw: string): { entries: MemoryEntry[]; kept: string[]; keptSeq: number; declined: string[] } {
  const got = parseEntriesRaw(raw);
  const now = Date.now();
  for (const e of got.entries) if (e.seenAt > now) e.seenAt = now;
  return got;
}

function parseEntriesRaw(raw: string): { entries: MemoryEntry[]; kept: string[]; keptSeq: number; declined: string[] } {
  const entries: MemoryEntry[] = [];
  const kept: string[] = [];
  const declined: string[] = [];
  let keptSeq = 0;
  // 先頭の BOM（古いメモ帳で直すと付く）を外す。付いたままだと一行目が読めず、退けた行として残り続ける。
  for (const line of raw.replace(/^\uFEFF/, '').split('\n')) {
    // 空白と NUL だけの行は捨てる（電源が落ちたあとに NUL で埋まることがある。退けて残すと消えなくなる）。
    if (/^[\s\0]*$/.test(line)) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { value = undefined; }
    if (isEntry(value)) { entries.push(filled(value)); continue; }
    if (isDeclined(value)) { declined.push(value.declined); continue; }
    kept.push(line.replace(/\r$/, ''));
    // 番号を拾う（読めない行・二件がくっついた行からも）。直されて戻ってきたときに、同じ番号を配らない。
    for (const n of line.matchAll(/"id"\s*:\s*"m(\d+)"/g)) keptSeq = Math.max(keptSeq, seqOf(n[1]!));
  }
  return { entries, kept, keptSeq, declined };
}

/** 忘れた最初からの覚えの記録（`{"declined":"…"}`）。番号を持たない。 */
function isDeclined(v: unknown): v is { declined: string } {
  return typeof v === 'object' && v !== null && !('id' in v) && typeof (v as { declined?: unknown }).declined === 'string';
}

/**
 * **件数ではなく、いちばん大きい番号から続ける。**
 * 刈り込みで途中が抜けると（m1, m3 が残るなど）件数は 2 になり、次に配る番号が m3 になって
 * **既にあるものとぶつかる**。ぶつかると supersedes の繋ぎ先と、忘れる先が壊れる。
 */
function maxSeq(entries: MemoryEntry[]): number {
  return entries.reduce((max, e) => {
    const n = /^m(\d+)$/.exec(e.id);
    return n ? Math.max(max, seqOf(n[1]!)) : max;
  }, 0);
}

/** 番号の数。**丸まる大きさの番号は数えない**（数えると次の番号が同じ値のまま進まず、同じ id を何度も配った）。 */
function seqOf(digits: string): number {
  const n = Number(digits);
  return Number.isSafeInteger(n) && n < Number.MAX_SAFE_INTEGER ? n : 0;
}
