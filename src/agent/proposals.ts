/**
 * 提案キュー — AIが自分で気づいたことを、実行せずに溜める場所。
 *
 * 目指しているのは「LLMを動かす場所」ではなく「AIが動く場所」。
 * そのためには、依頼を待つだけでなく、自分で調べて考えて提案する必要がある。
 *
 * ただし勝手に手を出させはしない。**提案は提案のまま置く。**
 * 実行するかは利用者が決める。自発性と暴走は紙一重なので、
 * 「気づくこと」と「やること」の間に必ず承認を挟む。
 */
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { inOrder } from '../core/in-order.ts';

export type ProposalKind =
  | 'bug'          // 壊れている可能性
  | 'risk'         // 将来困りそうなところ
  | 'test'         // 検査が足りていない
  | 'cleanup'      // 整理できる
  | 'question';    // 判断を仰ぎたい

export type ProposalStatus = 'open' | 'accepted' | 'rejected' | 'done';

export interface Proposal {
  id: string;
  kind: ProposalKind;
  title: string;
  /** なぜそう考えたか。根拠のない提案は雑音になる。 */
  rationale: string;
  /** 根拠となったファイルや出力 */
  evidence: string[];
  /** 実行するとしたら何をするか。依頼文としてそのまま使える形にする。 */
  suggestedAction: string;
  status: ProposalStatus;
  createdAt: string;
  /** 同じ提案を何度も出さないための指紋 */
  fingerprint: string;
}

/**
 * 溜めてよい上限。
 *
 * 人が一覧で選べる数を超えたら、それは溜まっているだけで使われない。
 */
export const MAX_ITEMS = 200;

/**
 * 調べ終えた指紋を覚えておく上限。指紋にはファイルの大きさと時刻が入るので、書き換えるたびに増える。
 * 刈らずにいたので、提案は 200 件でもファイルが際限なく大きくなった（5 万件で 1MB）。古い方から落とす。
 */
export const MAX_EXAMINED = 2000;

const STATUSES = new Set<ProposalStatus>(['open', 'accepted', 'rejected', 'done']);

/** 一件の形を確かめる（一覧・番号・重複の判定で使う所まで）。形が違うと、起動ごと止まっていた。 */
function isProposal(v: unknown): v is Proposal {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Record<string, unknown>;
  return typeof p.id === 'string' && typeof p.title === 'string' && typeof p.fingerprint === 'string'
    && typeof p.createdAt === 'string' && STATUSES.has(p.status as ProposalStatus)
    && typeof p.suggestedAction === 'string';
}

function idNumber(id: string): number {
  const n = /^p(\d+)$/.exec(id);
  const v = n ? Number(n[1]) : 0;
  return Number.isSafeInteger(v) ? v : 0;
}

let tmpSeq = 0;

interface DiskState { items: Proposal[]; examined: string[]; dropped: number; broken: boolean }

export class ProposalQueue {
  readonly #path?: string;
  #items: Proposal[] = [];
  #dropped = 0;
  /** 配った番号の数。**減らさない。**刈っても後戻りしない。 */
  #issued = 0;
  /**
   * 調べ終えた手がかりの指紋。
   * 提案にならなかった（＝問題なしだった）ものも覚えておく。
   * これが無いと、同じところを何度も調べ直して計算を捨てることになる。
   */
  #examined = new Set<string>();
  /**
   * 読めなかった（EBUSY 等）。この間は保存しない。空として始めて保存すると、溜めていた提案を全部上書きしていた。
   */
  #unreadable?: string;
  /** この実体が刈って落とした番号。保存で合わせるとき、ファイルに残っていても戻さない。 */
  #droppedIds = new Set<string>();

  constructor(path?: string) {
    this.#path = path;
  }

  /** ファイルを読む。**無い**は空、**読めない**は投げる、**壊れている**は `broken` を立てて空。 */
  async #readDisk(): Promise<DiskState> {
    let text: string;
    for (let tries = 0; ; tries += 1) {
      try {
        text = await readFile(this.#path!, 'utf8');
        break;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return { items: [], examined: [], dropped: 0, broken: false };
        if (tries >= 3 || !(code === 'EBUSY' || code === 'EPERM')) throw e;
        await new Promise((r) => setTimeout(r, 100 * (tries + 1)));
      }
    }
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { return { items: [], examined: [], dropped: 0, broken: true }; }
    const list = Array.isArray(raw) ? raw : (raw as { items?: unknown } | null)?.items;
    const obj = (Array.isArray(raw) ? {} : raw ?? {}) as { examined?: unknown; dropped?: unknown };
    return {
      // 形の違う一件（null 等）は、その一件だけ除く。
      items: Array.isArray(list) ? list.filter(isProposal) : [],
      examined: Array.isArray(obj.examined) ? obj.examined.filter((x): x is string => typeof x === 'string') : [],
      /*
       * **書いたものを、読み返す。**落とした数を保存に残していたのに読む側が見ていなかったので、
       * 立ち上げ直すと 0 に戻り、次の保存でその 0 を書き込んでいた。
       */
      dropped: typeof obj.dropped === 'number' && Number.isFinite(obj.dropped) ? obj.dropped : 0,
      broken: raw === null || (typeof raw !== 'object'),
    };
  }

  async load(): Promise<void> {
    if (!this.#path) return;
    this.#unreadable = undefined;
    try {
      const got = await this.#readDisk();
      if (got.broken) await this.#setAside();
      this.#items = got.items;
      this.#examined = new Set(got.examined);
      this.#dropped = got.dropped;
    } catch (e) {
      this.#items = [];
      this.#examined = new Set();
      this.#dropped = 0;
      this.#unreadable = (e as NodeJS.ErrnoException).code ?? (e as Error).message;
    }
    // 読み込んだ後も、**既にある番号の続きから**配る。件数から決めていたので、
    // 刈って抜けた番号をもう一度配っていた。
    this.#issued = this.#items.reduce((max, x) => Math.max(max, idNumber(x.id)), 0);
  }

  /**
   * JSON として読めないファイルは、空で上書きする前に脇へ移す（`<名前>.broken-<時刻>`）。
   * 書きかけで落ちたものでも、中身の大半は手で拾える。上書きすると拾えない。
   */
  async #setAside(): Promise<void> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await rename(this.#path!, `${this.#path}.broken-${stamp}`).catch(() => undefined);
  }

  markExamined(fingerprint: string): void {
    this.#examined.add(fingerprint);
    // 古い方から落とす（Set は足した順に並ぶ）。
    while (this.#examined.size > MAX_EXAMINED) {
      const first = this.#examined.values().next().value;
      if (first === undefined) break;
      this.#examined.delete(first);
    }
  }

  /** 提案済み・調査済みの両方。次に何を調べるかの判断に使う。 */
  seen(): Set<string> {
    return new Set([...this.#examined, ...this.#items.map((p) => p.fingerprint)]);
  }

  all(): Proposal[] {
    return [...this.#items];
  }

  open(): Proposal[] {
    return this.#items.filter((p) => p.status === 'open');
  }

  find(id: string): Proposal | undefined {
    if (id.length === 0) return undefined; // 空は、どれにも当てない（前方一致で先頭の提案に当たっていた）
    const exact = this.#items.find((p) => p.id === id);
    if (exact) return exact;
    // 前方一致でも引けるようにする（毎回全部打たせない）。ただし**当たりが一つだけのとき**に限る。
    // 最初の当たりを返していたので、`p01` が p010 に、消えた `p100` が p1000 に当たり、別の提案を実行した。
    const hits = this.#items.filter((p) => p.id.startsWith(id));
    return hits.length === 1 ? hits[0] : undefined;
  }

  /**
   * 追加する。重複は入れない。
   *
   * 手がかりの指紋だけで見ると取りこぼす。
   * 別々の手がかりから調べても、行き着く先が同じ発見になることがあるため、
   * 提案の中身でも重複を判定する。
   */
  add(p: Omit<Proposal, 'id' | 'status' | 'createdAt'>): Proposal | undefined {
    const contentKey = normalizeTitle(p.title);
    const duplicate = this.#items.find(
      (x) => x.status !== 'rejected' &&
        (x.fingerprint === p.fingerprint || normalizeTitle(x.title) === contentKey),
    );
    if (duplicate) return undefined;

    const item: Proposal = {
      ...p,
      id: this.#nextId(),
      status: 'open',
      createdAt: new Date().toISOString(),
    };
    this.#items.push(item);
    this.#prune();
    return item;
  }

  /**
   * 次の番号。
   *
   * **件数から決めていたので、刈った後に同じ番号を配っていた**
   * （200 件のうち 49 件が同じ名前。p201 が繰り返し出る）。
   * 同じ番号があると、採用も却下も、狙った提案とは別のものに当たる。
   */
  #nextId(): string {
    for (;;) {
      this.#issued += 1;
      const id = `p${this.#issued.toString().padStart(3, '0')}`;
      if (!this.#items.some((x) => x.id === id)) return id;
    }
  }

  /**
   * 溜めすぎない。
   *
   * 提案は暇なときに勝手に増える。**上限が無かったので、放っておくと
   * 際限なく溜まる**（500 件で 877KB。画面にも全部並ぶ）。
   * 人が選べる数を超えたものは、見てもらえないのと同じ。
   *
   * 落とすのは**片づいたものから**。開いているものは、古くても人の宿題なので
   * 勝手に消さない。それでも超えるときだけ、開いているものの古い順に落とす。
   */
  #prune(max = MAX_ITEMS): void {
    if (this.#items.length <= max) return;
    const settled = this.#items.filter((x) => x.status !== 'open');
    const open = this.#items.filter((x) => x.status === 'open');
    // 片づいたものは、新しい方から少しだけ残す（何を採ったかの手がかり）。
    const keepSettled = settled.slice(-Math.floor(max * 0.2));
    const room = max - keepSettled.length;
    // 開いているものは新しい方を残す。古いものは、たいてい状況が変わっている。
    const keepOpen = open.slice(-room);
    this.#items = [...keepSettled, ...keepOpen].sort(
      (a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0),
    );
    const kept = new Set([...keepSettled, ...keepOpen].map((x) => x.id));
    for (const x of [...settled, ...open]) if (!kept.has(x.id)) this.#droppedIds.add(x.id);
    this.#dropped += (settled.length - keepSettled.length) + (open.length - keepOpen.length);
  }

  /** 溜めすぎて落とした数。黙って消さないために持つ。 */
  get dropped(): number { return this.#dropped; }

  setStatus(id: string, status: ProposalStatus): Proposal | undefined {
    const item = this.find(id);
    if (item) item.status = status;
    return item;
  }

  /**
   * 保存する。同じファイルへの保存は一列に並べる。
   *
   * **保存の直前に読み直して合わせる。**画面と端末は別々に読み込んで持つので、手元を丸ごと書くと、
   * もう一方が足した提案・決めた採否を消していた。同じ番号を別の提案に配ることもあった（端末で「p003 を採る」と
   * 打つと、見ていたものと別の提案が実行される）。
   */
  save(): Promise<void> {
    const path = this.#path;
    if (!path) return Promise.resolve();
    return inOrder(path, async () => {
      try {
        let disk: DiskState;
        try {
          disk = await this.#readDisk();
        } catch {
          // 読めない間は書かない（空と取り違えて、溜めていた提案を上書きしない）。
          return;
        }
        if (this.#unreadable) this.#unreadable = undefined; // 読めるようになった。合わせて書く
        if (disk.broken) await this.#setAside();
        this.#merge(disk.items, disk.examined, disk.dropped);
        await mkdir(dirname(path), { recursive: true });
        const tmp = `${path}.${process.pid}.${++tmpSeq}.tmp`;
        try {
          await writeFile(tmp, JSON.stringify({
            items: this.#items,
            examined: [...this.#examined],
            // **落とした数も残す。**数えているのに残していなかったので、立ち上げ直すと「無かったこと」になっていた。
            dropped: this.#dropped,
          }, null, 2), 'utf8');
          await rename(tmp, path);
        } catch (e) {
          await rm(tmp, { force: true }).catch(() => undefined);
          throw e;
        }
      } catch {
        // 保存できなくても本体は止めない
      }
    });
  }

  /**
   * ファイルにある分と手元を合わせる。
   * - 手元に無い番号は足す（もう一方が足したもの）。この実体が刈った番号は戻さない
   * - 同じ番号で中身が違う（別々に同じ番号を配った）なら、手元の方を新しい番号に振り直す
   * - 同じ提案で採否が違うなら、決まっている方を採る（開いたままの側が、決めたことを戻さない）
   */
  #merge(onDisk: Proposal[], examined: string[], dropped: number): void {
    const mine = new Map(this.#items.map((x) => [x.id, x]));
    for (const d of onDisk) this.#issued = Math.max(this.#issued, idNumber(d.id));
    const merged: Proposal[] = [];
    for (const d of onDisk) {
      if (this.#droppedIds.has(d.id)) continue;
      const m = mine.get(d.id);
      if (!m) { merged.push(d); continue; }
      if (m.fingerprint !== d.fingerprint || m.createdAt !== d.createdAt) {
        merged.push(d);
        continue; // 手元の方は、下で新しい番号を付けて足す
      }
      mine.delete(d.id);
      merged.push(m.status === 'open' && d.status !== 'open' ? d : m);
    }
    const onDiskIds = new Set(onDisk.map((d) => d.id));
    for (const m of this.#items) {
      if (!mine.has(m.id)) continue;
      if (onDiskIds.has(m.id)) m.id = this.#nextIdAmong(merged);
      merged.push(m);
    }
    this.#items = merged.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    for (const f of examined) if (!this.#examined.has(f)) this.markExamined(f);
    this.#dropped = Math.max(this.#dropped, dropped);
    this.#prune();
  }

  #nextIdAmong(list: Proposal[]): string {
    for (;;) {
      this.#issued += 1;
      const id = `p${this.#issued.toString().padStart(3, '0')}`;
      if (!list.some((x) => x.id === id) && !this.#items.some((x) => x.id === id)) return id;
    }
  }
}

/** 表記ゆれを吸収して、同じ発見を同じと見なす。 */
function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[\s、。,.:：「」"'`]/g, '');
}

const KIND_LABEL: Record<ProposalKind, string> = {
  bug: '不具合の疑い',
  risk: 'リスク',
  test: '検査不足',
  cleanup: '整理',
  question: '要判断',
};

export function formatProposal(p: Proposal, verbose = false): string {
  const head = `${p.id} [${KIND_LABEL[p.kind]}] ${p.title}`;
  if (!verbose) return head;
  const lines = [head, `  理由: ${p.rationale}`];
  if (p.evidence.length > 0) lines.push(`  根拠: ${p.evidence.join(', ')}`);
  lines.push(`  やること: ${p.suggestedAction}`);
  return lines.join('\n');
}
