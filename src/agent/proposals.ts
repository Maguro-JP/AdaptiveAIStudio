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
import { redactSecrets } from '../core/redact.ts';
import { readFile, writeFile, mkdir, rename, rm, copyFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
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
  /**
   * どの作業場の提案か（`placeKey` の形）。提案は全部の作業場で一つのファイルに溜まるので、これが無いと、別の作業場で
   * 採用したときにその作業場で走っていた。無い（前からある記録）なら、どの作業場の提案か分からない（今までどおり扱う）
   */
  root?: string;
  /** どの思考から出たか。採否をその思考の実績にする（手元だけに持っていたので、立ち上げ直すと実績に乗らなかった）。 */
  origin?: string;
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
    && typeof p.suggestedAction === 'string' && typeof p.kind === 'string' && typeof p.rationale === 'string'
    && Array.isArray(p.evidence);
}

function idNumber(id: string): number {
  const n = /^p(\d+)$/.exec(id);
  const v = n ? Number(n[1]) : 0;
  return Number.isSafeInteger(v) ? v : 0;
}

let tmpSeq = 0;

interface DiskState { items: Proposal[]; odd: unknown[]; examined: string[]; dropped: number; broken: boolean }

export class ProposalQueue {
  readonly #path?: string;
  #items: Proposal[] = [];
  #dropped = 0;
  /** この実体が刈って落とした数のうち、まだファイルに足していない分。 */
  #droppedDelta = 0;
  /** 配った番号の数。**減らさない。**刈っても後戻りしない。 */
  #issued = 0;
  /**
   * 調べ終えた手がかりの指紋。
   * 提案にならなかった（＝問題なしだった）ものも覚えておく。
   * これが無いと、同じところを何度も調べ直して計算を捨てることになる。
   */
  #examined = new Set<string>();
  /** この実体が刈って落とした提案（番号と作った時刻）。保存で合わせるとき、ファイルに残っていても戻さない。 */
  #droppedKeys = new Set<string>();
  /** この実体が採否を変えて、まだ保存していない提案の番号。合わせるときは、これだけ手元を勝たせる。 */
  #changed = new Set<string>();

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
        if (code === 'ENOENT') return { items: [], odd: [], examined: [], dropped: 0, broken: false };
        if (tries >= 3 || !(code === 'EBUSY' || code === 'EPERM')) throw e;
        await new Promise((r) => setTimeout(r, 100 * (tries + 1)));
      }
    }
    return parseDisk(text);
  }

  async load(): Promise<void> {
    if (!this.#path) return;
    try {
      const got = await this.#readDisk();
      if (got.broken) await this.#setAside();
      this.#items = got.items;
      this.#examined = new Set();
      for (const f of got.examined) this.markExamined(f);
      this.#dropped = got.dropped;
    } catch {
      this.#items = [];
      this.#examined = new Set();
      this.#dropped = 0;
    }
    // 読み込んだ後も、**既にある番号の続きから**配る。件数から決めていたので、
    // 刈って抜けた番号をもう一度配っていた。
    this.#issued = this.#items.reduce((max, x) => Math.max(max, idNumber(x.id)), 0);
    this.#changed.clear();
  }

  /**
   * JSON として読めないファイルは、空で上書きする前に脇へ移す（`<名前>.broken-<時刻>`）。書きかけで落ちたものでも、
   * 中身の大半は手で拾える。移せなければ写しを取る。**どちらもできなければ false**（呼んだ側は書かない）。
   */
  async #setAside(): Promise<boolean> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const to = `${this.#path}.broken-${stamp}`;
    try { await rename(this.#path!, to); return true; } catch { /* 下で写しを取る */ }
    try { await copyFile(this.#path!, to); return true; } catch { return false; }
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
   *
   * 番号は、**ファイルにある一番大きい番号の続き**から配る（画面と端末が別々に持つので、手元の続きだけだと同じ番号を
   * 二つの提案に配っていた）。ファイルが読めないときは足さない（残せない番号を配って表示すると、後で別の提案を指す）。
   */
  add(given: Omit<Proposal, 'id' | 'status' | 'createdAt'>): Proposal | undefined {
    // 秘密は伏せてから残す（モデルが .env を読んだ結果を理由や手順に書くと、proposals.json と画面に残っていた）
    const p = {
      ...given,
      title: redactSecrets(given.title), rationale: redactSecrets(given.rationale), suggestedAction: redactSecrets(given.suggestedAction),
    };
    const contentKey = normalizeTitle(p.title);
    const duplicate = this.#items.find(
      (x) => x.status !== 'rejected' &&
        (x.fingerprint === p.fingerprint || normalizeTitle(x.title) === contentKey),
    );
    if (duplicate) return undefined;
    if (this.#path) {
      try {
        const onDisk = parseDisk(readFileSync(this.#path, 'utf8'));
        for (const d of onDisk.items) this.#issued = Math.max(this.#issued, idNumber(d.id));
        if (onDisk.items.some((x) => x.status !== 'rejected'
          && (x.fingerprint === p.fingerprint || normalizeTitle(x.title) === contentKey))) return undefined;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
      }
    }

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
  #nextId(among: Proposal[] = this.#items): string {
    for (;;) {
      this.#issued += 1;
      const id = `p${this.#issued.toString().padStart(3, '0')}`;
      if (!among.some((x) => x.id === id) && !this.#items.some((x) => x.id === id)) return id;
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
    const kept = new Set([...keepSettled, ...keepOpen]);
    for (const x of [...settled, ...open]) if (!kept.has(x)) this.#droppedKeys.add(keyOf(x));
    const n = (settled.length - keepSettled.length) + (open.length - keepOpen.length);
    this.#dropped += n;
    this.#droppedDelta += n;
  }

  /** 溜めすぎて落とした数。黙って消さないために持つ。 */
  get dropped(): number { return this.#dropped; }

  setStatus(id: string, status: ProposalStatus): Proposal | undefined {
    const item = this.find(id);
    if (item) { item.status = status; this.#changed.add(item.id); }
    return item;
  }

  /**
   * 採否を決めて保存する。**ファイルを読み直して合わせてから決める**（一列の中で）。
   *
   * 手元だけを見て決めていたので、もう一方（画面と端末）が決めた提案を、古い手元がもう一度決められた
   * （却下された提案をそのまま実行した）。`onlyOpen` のときは、開いている提案だけを決める。
   */
  settle(id: string, status: ProposalStatus, opts: { onlyOpen?: boolean } = {}): Promise<Proposal | undefined> {
    const path = this.#path;
    if (!path) {
      const item = this.find(id);
      if (!item || (opts.onlyOpen && item.status !== 'open')) return Promise.resolve(undefined);
      return Promise.resolve(this.setStatus(item.id, status));
    }
    return inOrder(path, async () => {
      let disk: DiskState;
      // 読めないときは決めない。前は「見つからないか、もう決まっている」と同じ返事にしていた。
      try { disk = await this.#readDisk(); } catch (e) {
        throw new Error(`提案の記録を読めませんでした（${(e as Error).message}）。採否は決めていません`);
      }
      this.#merge(disk);
      const item = this.find(id);
      if (!item || (opts.onlyOpen && item.status !== 'open')) return undefined;
      const before = item.status;
      const wasChanged = this.#changed.has(item.id);
      this.setStatus(item.id, status);
      const failed = await this.#write(disk);
      if (failed) {
        // **書けなかった採否を、決まったことにしない。**前は手元だけ決まったまま返し、採用なら実行まで進めた。
        // ファイルは開いたままなので、もう一方（画面と端末）や立ち上げ直した後に、同じ提案がもう一度決められた。
        item.status = before;
        if (!wasChanged) this.#changed.delete(item.id);
        throw new Error(`提案の採否を保存できませんでした（${failed.message}）。採否は決めていません`);
      }
      return item;
    });
  }

  /**
   * 保存する。同じファイルへの保存は一列に並べる。
   *
   * **保存の直前に読み直して合わせる。**画面と端末は別々に読み込んで持つので、手元を丸ごと書くと、
   * もう一方が足した提案・決めた採否を消していた。
   *
   * 残せなかったときは、その失敗を返す（投げない。保存できなくても本体は止めない）。**黙らない。**呼ぶ側は
   * 「登録しました」と言うので、残せていないのに言うと、立ち上げ直したときに提案が消えて見える。
   */
  save(): Promise<Error | undefined> {
    const path = this.#path;
    if (!path) return Promise.resolve(undefined);
    return inOrder(path, async () => {
      let disk: DiskState;
      // 読めない間は書かない（空と取り違えて、溜めていた提案を上書きしない）。
      try { disk = await this.#readDisk(); } catch (e) { return new Error(`提案の記録を読めないので、残せませんでした（${(e as Error).message}）`); }
      // 脇へ移せないなら、壊れたファイルを上書きしない
      if (disk.broken && !(await this.#setAside())) return new Error('提案の記録が壊れていて、脇へ移せないので、残せませんでした');
      this.#merge(disk);
      // 何を残せなかったかが分かる文にする（書き込みの失敗は、一時ファイルの道を含む生の英文になる）
      const failed = await this.#write(disk);
      return failed ? new Error(`提案を残せませんでした（${(failed as NodeJS.ErrnoException).code ?? failed.message}）`) : undefined;
    });
  }

  /** 書く。書けなかったときはその失敗を返す（投げない。保存できなくても本体は止めない）。 */
  async #write(disk: DiskState): Promise<Error | undefined> {
    const path = this.#path!;
    try {
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.${++tmpSeq}.tmp`;
      try {
        await writeFile(tmp, JSON.stringify({
          // 形の違う一件は、元のまま書き戻す（手で直している途中・別の版が書いたもの。記憶のファイルと同じ扱い）。
          items: [...this.#items, ...disk.odd],
          examined: [...this.#examined],
          // **落とした数も残す。**数えているのに残していなかったので、立ち上げ直すと「無かったこと」になっていた。
          dropped: this.#dropped,
        }, null, 2), 'utf8');
        await rename(tmp, path);
      } catch (e) {
        await rm(tmp, { force: true }).catch(() => undefined);
        throw e;
      }
      this.#changed.clear();
      this.#droppedDelta = 0;
      return undefined;
    } catch (e) {
      // 保存できなくても本体は止めない。決めた採否のように、書けたかで答えが変わる所は呼ぶ側が見る
      return e instanceof Error ? e : new Error(String(e));
    }
  }

  /**
   * ファイルにある分と手元を合わせる。
   * - 手元に無い提案は足す（もう一方が足したもの）。この実体が刈った提案は戻さない
   * - 同じ提案の採否は、この実体が変えたものだけ手元を採り、ほかはファイルを採る
   * - 同じ番号で中身が違う（ほぼ同時に足して同じ番号を配った）なら、手元の方を振り直す
   * - 手元にしか無い提案が、ファイルの提案と同じ発見なら、手元の方を落とす
   * - 指紋はファイルの分を先に、手元の分を後に並べて、古い方から刈る
   * - 落とした数は、ファイルの数にこの実体が落とした分を足す
   */
  #merge(disk: DiskState): void {
    const mine = new Map(this.#items.map((x) => [x.id, x]));
    for (const d of disk.items) this.#issued = Math.max(this.#issued, idNumber(d.id));
    const merged: Proposal[] = [];
    const taken = new Set<Proposal>();
    for (const d of disk.items) {
      if (this.#droppedKeys.has(keyOf(d))) continue;
      const m = mine.get(d.id);
      if (m && keyOf(m) === keyOf(d)) {
        if (!this.#changed.has(m.id)) m.status = d.status;
        merged.push(m);
        taken.add(m);
      } else {
        merged.push(d);
      }
    }
    for (const m of this.#items) {
      if (taken.has(m)) continue;
      const key = normalizeTitle(m.title);
      const same = merged.some((x) => x.status !== 'rejected'
        && (x.fingerprint === m.fingerprint || normalizeTitle(x.title) === key));
      if (same) continue;
      if (merged.some((x) => x.id === m.id)) m.id = this.#nextId(merged);
      merged.push(m);
    }
    this.#items = merged.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    const mineExamined = [...this.#examined];
    this.#examined = new Set();
    for (const f of [...disk.examined, ...mineExamined]) {
      this.#examined.delete(f);
      this.markExamined(f);
    }
    this.#dropped = disk.dropped + this.#droppedDelta;
    this.#prune();
  }
}

/** 同じ提案かを見る鍵（番号と作った時刻と指紋）。番号だけだと、別の実体が同じ番号で足した新しい提案を取り違える。 */
function keyOf(p: Proposal): string {
  return `${p.id}\u0000${p.createdAt}\u0000${p.fingerprint}`;
}

/** ファイルの中身を読む。形の違う一件は `odd` に元のまま分ける。 */
function parseDisk(text: string): DiskState {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { items: [], odd: [], examined: [], dropped: 0, broken: true }; }
  if (raw === null || typeof raw !== 'object') return { items: [], odd: [], examined: [], dropped: 0, broken: true };
  const list = Array.isArray(raw) ? raw : (raw as { items?: unknown }).items;
  const obj = (Array.isArray(raw) ? {} : raw) as { examined?: unknown; dropped?: unknown };
  const all = Array.isArray(list) ? list : [];
  return {
    // 形の違う一件（null 等）は、その一件だけ除く。
    items: all.filter(isProposal),
    odd: all.filter((x) => !isProposal(x) && x !== null && typeof x === 'object'),
    examined: Array.isArray(obj.examined) ? obj.examined.filter((x): x is string => typeof x === 'string') : [],
    /*
     * **書いたものを、読み返す。**落とした数を保存に残していたのに読む側が見ていなかったので、
     * 立ち上げ直すと 0 に戻り、次の保存でその 0 を書き込んでいた。
     */
    dropped: typeof obj.dropped === 'number' && Number.isFinite(obj.dropped) ? obj.dropped : 0,
    broken: false,
  };
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

/** その作業場で扱ってよい提案か。作業場の分からない古い提案は、どこでも今までどおり扱う。 */
export function proposalHere(p: Pick<Proposal, 'root'>, rootKey: string): boolean {
  return p.root === undefined || p.root === rootKey;
}
