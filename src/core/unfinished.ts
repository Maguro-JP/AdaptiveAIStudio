/**
 * やり残しを控える。**忘れないための場所。**
 *
 * ここまで、40往復で打ち切ったり、押し戻しても動かなかったりしたとき、
 * そこで**終わり**だった。次に人が同じことを言い直すまで、誰も続けない。
 * 「自律的に進める」と言いながら、続きは人が覚えていることが前提だった。
 *
 * 覚えるのはこちらの仕事。だから控える。
 *
 * **ファイルに残す。**窓を閉じても、機械を落としても残る。
 * 記憶の中だけだと、いちばん続きが要るとき（長い作業の途中で落ちた）に
 * きれいに消える。
 *
 * 一行ずつ足すだけで書く（会話の残し方と同じ）。丸ごと書き直すと、
 * 書いている最中に落ちたときに全部を失う。
 */
import { appendFile, mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { idMaker } from './ordered-id.ts';
import { inOrder } from './in-order.ts';
import { keptOdd } from './odd-lines.ts';
import { isAbsent } from '../harness/put-back.ts';

/** なぜ終わっていないか。**符丁で持つ**（表示のときに日本語へ引き直す）。 */
export type UnfinishedWhy = 'maxTurns' | 'noProgress' | 'unverified' | 'failed';

export interface Unfinished {
  id: string;
  /** 元の依頼。**そのまま残す。**要約すると、続きが別の作業になる。 */
  request: string;
  why: UnfinishedWhy;
  /** 何が起きたか。人に見せる一行。 */
  note: string;
  /** どの会話の続きか。分かれば、そこへ戻して続ける。 */
  conversationId?: string;
  /**
   * どの作業場の作業か（絶対の道）。続けるのは、同じ作業場を開いているときだけ。
   * 無い（前からある記録）なら、どこでも続ける。
   */
  root?: string;
  /** 何回やり直したか。 */
  attempts: number;
  /** 次に手を付けてよい時刻（ミリ秒）。 */
  nextAt: number;
  createdAt: string;
}

/**
 * やり直しの間隔。**すぐには戻らない。**
 *
 * 落ちた直後にそのまま戻すと、同じところで同じように落ちて、
 * ただ枠と電気を使う。少し置く。置くたびに長くする。
 */
export const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000];

/** ここまで試して動かなければ、諦めて、諦めたと言う。 */
export const MAX_ATTEMPTS = BACKOFF_MS.length;

type Line =
  | { t: 'add'; item: Unfinished }
  | { t: 'bump'; id: string; attempts: number; nextAt: number }
  /** `at` はやめた時刻（ms）。前の版が書いた行には無い（その分は「最近やめたもの」に並べない）。 */
  | { t: 'close'; id: string; how: 'done' | 'gaveUp' | 'canceled'; at?: number }
  /** 利用者がやめたもの（`canceled`）を、押し間違えとして戻す。前の版は知らない行として読み飛ばす（やめたまま）。 */
  | { t: 'reopen'; id: string; nextAt?: number };

/** `reopen` の結果。 */
export type ReopenResult = 'reopened' | 'open' | 'gone' | 'duplicate' | 'full';

/**
 * 抱えてよい上限。
 *
 * 人が見て選べる数を超えたら、それは溜まっているだけで手が付かない。
 */
export const MAX_OPEN = 50;

const makeId = idMaker('u');

/** 名前を配る。**同じミリ秒でも、必ず別のものにする**（`ordered-id.ts`）。 */
export function nextId(now: number, rand = Math.random): string {
  return makeId(now, rand);
}

let tmpSeq = 0;

export class UnfinishedWork {
  readonly #path: string;

  /** 試験で読む手をモックにするためのもの。 */
  readonly #readText: (path: string) => Promise<string>;

  constructor(path: string, ops: { read?: (path: string) => Promise<string> } = {}) {
    this.#path = path;
    this.#readText = ops.read ?? ((p) => readFile(p, 'utf8'));
  }

  async #append(line: Line): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    // 途中で落ちた書き込みの続きに繋げない。半端な行が残っていることがある。
    // 読めないときは区切りを入れる（空行は読むときに飛ばす）。「無い」と読んで入れないと、半端な行と繋がって両方読めなくなる
    const raw = await this.#readText(this.#path).catch((e: unknown) => (isAbsent(e) ? '' : undefined));
    const sep = raw === undefined ? '\n' : raw.length === 0 || raw.endsWith('\n') ? '' : '\n';
    await appendFile(this.#path, `${sep}${JSON.stringify(line)}\n`, 'utf8');
  }

  /** いま残っているもの。古い順。 */
  /**
   * いま抱えているもの。`strict` のときは、ファイルが無い以外の読み失敗で投げる（読めないのを「空」と取り違えない。
   * 空と読んで、段取りを全部閉じる側に倒れるため）。
   */
  async list(opts: { strict?: boolean } = {}): Promise<Unfinished[]> {
    return (await this.#read(opts)).open;
  }

  /** 抱えているものと、利用者がやめたもの（戻せる分）。 */
  async #read(opts: { strict?: boolean } = {}): Promise<{
    open: Unfinished[]; canceled: Map<string, Unfinished>; canceledAt: Map<string, number>;
  }> {
    const raw = await this.#readText(this.#path).catch((e: NodeJS.ErrnoException) => {
      // 無い（ENOENT・ENOTDIR）だけを空にする。ほかを空と読むと、回数を進める所で「諦めた」と取り違える
      if (opts.strict && !isAbsent(e)) throw e;
      return '';
    });
    return parseLines(raw);
  }

  /** 控える。**同じ依頼を二重に控えない。** */
  /**
   * 溜めすぎて閉じたもの。**黙って消さないために持つ。**
   *
   * 上限（50件）を超えると古い方から諦めて閉じるが、それが誰にも見えないと、
   * **頼んだことが黙って消えたようにしか見えない。**
   */
  #dropped: Unfinished[] = [];

  /** 溜めすぎて閉じたものを、一度だけ取り出す。 */
  takeDropped(): Unfinished[] {
    const got = this.#dropped;
    this.#dropped = [];
    return got;
  }

  add(
    item: Omit<Unfinished, 'id' | 'attempts' | 'nextAt' | 'createdAt'>,
    now = Date.now(),
  ): Promise<Unfinished | undefined> {
    return inOrder(this.#path, () => this.#add(item, now));
  }

  async #add(
    item: Omit<Unfinished, 'id' | 'attempts' | 'nextAt' | 'createdAt'>,
    now: number,
  ): Promise<Unfinished | undefined> {
    // 読めないときは投げる（重なりを確かめられないまま足すと、同じ依頼を二重に記録する）
    // 同じ依頼でも、別の作業場のものは別の作業
    const already = (await this.list({ strict: true })).find((u) => u.request === item.request && u.root === item.root);
    if (already) return undefined;
    const full: Unfinished = {
      ...item,
      id: nextId(now),
      attempts: 0,
      nextAt: now + BACKOFF_MS[0]!,
      createdAt: new Date(now).toISOString(),
    };
    await this.#append({ t: 'add', item: full });
    this.#dropped.push(...await this.#prune());
    return full;
  }

  /**
   * 溜めすぎない。
   *
   * やり残しは、落ちるたびに増える。**上限が無かったので、放っておくと
   * 際限なく溜まる**（500 件で 521KB。画面にも全部並ぶ）。
   * 古いものほど、もう状況が変わっていて、そのままでは通らない。
   *
   * 落とすのは**古い方から**。落としたことは黙らない（記録に残す）。
   */
  async #prune(max = MAX_OPEN): Promise<Unfinished[]> {
    const all = await this.list();
    const gone = all.length > max ? all.slice(0, all.length - max) : [];
    for (const item of gone) {
      // **諦めた**として閉じる。片づいた（done）と混ぜない。
      await this.#append({ t: 'close', id: item.id, how: 'gaveUp' });
    }
    await this.#compact(max);
    return gone;
  }

  /**
   * 記録そのものを畳む。
   *
   * 追記式なので、**閉じたものの行も残り続ける。**生きているのが 50 件でも、
   * ファイルは何百KBにもなる（実測で 542KB）。読むたびに全部を解くので、
   * 増えるほど遅くなる。生きている分だけで書き直す。
   */
  async #compact(max: number): Promise<void> {
    // 一度だけ読み、読めた同じ中身から畳む。読めなければ畳まない（前は二度読み、二度目が一瞬読めないと空で書き戻して全部消した）
    let raw: string;
    try { raw = await this.#readText(this.#path); } catch { return; }
    const lines = raw.split('\n').filter((l) => l.trim().length > 0).length;
    if (lines <= Math.max(200, max * 4)) return;
    const { open: live, odd } = parseLines(raw);
    // 別の版が書いた行（JSON として読めて `t` を持つ）は、元の文のまま残す（畳むたびに黙って捨てない）
    const body = live.map((item) => `${JSON.stringify({ t: 'add', item })}\n`).join('') + keptOdd(odd).map((l) => `${l}\n`).join('');
    await mkdir(dirname(this.#path), { recursive: true });
    // 一時ファイルに書いてから置き換える（書き戻しの途中で落ちると、記録が丸ごと消えていた）。
    const tmp = `${this.#path}.${process.pid}.${++tmpSeq}.tmp`;
    try {
      await writeFile(tmp, body, 'utf8');
      await rename(tmp, this.#path);
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw e;
    }
  }

  /**
   * いま手を付けてよいもの。**一つだけ返す**（一度に一つずつ進める）。
   * `root` を渡したら、その作業場の分（と、作業場の分からない前からの分）だけ。作業場を変えたあとに、前の作業場の依頼を
   * 新しい作業場で続けない（別のプロジェクトのファイルを、その依頼のつもりで書き換える）。
   */
  async due(now = Date.now(), root?: string): Promise<Unfinished | undefined> {
    return (await this.list()).find((u) => u.nextAt <= now && (root === undefined || u.root === undefined || u.root === root));
  }

  /**
   * 手を付けた。次はもっと後にする。
   *
   * 上限まで来たら諦める。**諦めたことは、諦めたと言う。**
   * 黙って消すと、頼んだことが消えたようにしか見えない。
   */
  bump(id: string, now = Date.now()): Promise<{ gaveUp: boolean; attempts: number }> {
    return inOrder(this.#path, () => this.#bump(id, now));
  }

  async #bump(id: string, now: number): Promise<{ gaveUp: boolean; attempts: number }> {
    // 読めないときは投げる（空と読むと「諦めた」と返し、0 回で諦めたと言っていた）
    const item = (await this.list({ strict: true })).find((u) => u.id === id);
    if (!item) return { gaveUp: true, attempts: 0 };
    const attempts = item.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      await this.#append({ t: 'close', id, how: 'gaveUp' });
      return { gaveUp: true, attempts };
    }
    await this.#append({ t: 'bump', id, attempts, nextAt: now + BACKOFF_MS[attempts]! });
    return { gaveUp: false, attempts };
  }

  /** 片づいた。 */
  done(id: string): Promise<void> {
    return inOrder(this.#path, () => this.#append({ t: 'close', id, how: 'done' }));
  }

  /**
   * やめた。利用者が画面でやめたとき（`byUser`）だけ、やめた時刻を書く。時刻の在る分だけが「戻す」に並ぶ。
   * 本体が自分で閉じた分（段取りの段が塞がって止めた）まで並べると、押していないのに「やめました」と出て、戻すとまた走り出す。
   */
  cancel(id: string, opts: { byUser?: boolean; now?: number } = {}): Promise<void> {
    const line: Line = opts.byUser
      ? { t: 'close', id, how: 'canceled', at: opts.now ?? Date.now() }
      : { t: 'close', id, how: 'canceled' };
    return inOrder(this.#path, () => this.#append(line));
  }

  /**
   * `since` より後にやめて、まだ戻せるもの（やめた新しい順、上限 `limit`）。画面の「戻す」に並べる。
   * 前は画面が最後にやめた一件だけを持っていたので、続けて二つやめると一つ目を戻せず、読み直すと戻す口ごと消えた。
   * やめた記録は畳むまで残るので、何日も前の分まで並べないよう、画面が区切り（立ち上げた時刻）を渡す。
   */
  async canceledSince(since: number, limit = 20): Promise<{ id: string; request: string; at: number }[]> {
    const { open, canceled, canceledAt } = await this.#read();
    // 戻せないもの（上限まで抱えている・同じ依頼をもう一度抱えている）は並べない。押しても戻らない口を出さない
    if (open.length >= MAX_OPEN) return [];
    return [...canceledAt.entries()]
      .filter(([id, at]) => at >= since && canceled.has(id) && !open.some((u) => u.request === canceled.get(id)!.request && u.root === canceled.get(id)!.root))
      .reverse()
      .slice(0, limit)
      .map(([id, at]) => ({ id, request: canceled.get(id)!.request, at }));
  }

  /**
   * やめたものを戻す（押し間違え）。元の依頼の文は、ここにしか残っていない。
   *
   * - `gone`: やめたものの中に無い（片づいた・諦めた・記録を畳んで消えた）
   * - `duplicate`: やめた後に同じ依頼をもう一度記録している。二つにしない
   * - `open`: まだ抱えている（戻すまでもない）
   *
   * - `full`: 抱えている数が上限（`MAX_OPEN`）に届いている。戻すと、次に新しく記録したときに古い方から落とされる
   *   （戻したものは作った時刻が古いので、真っ先に落ちる）
   *
   * やり直した回数はやめたときのまま戻す。次に手を付けるのは、戻してから最初の間（`BACKOFF_MS[0]`）を置いた後か、
   * 元の時刻の遅い方（戻したとたんに走り出して、作業場を書き換え始めない）。段取りの進み具合は戻らない（やめたときに
   * 閉じている）。次に手を付けるときに割り直す。
   *
   * 読めないときは投げる（読めないのを「無い」と取り違えて、戻す口を下げさせない）。
   */
  reopen(id: string, now = Date.now()): Promise<ReopenResult> {
    return inOrder(this.#path, async () => {
      const { open, canceled } = await this.#read({ strict: true });
      if (open.some((u) => u.id === id)) return 'open';
      const item = canceled.get(id);
      if (!item) return 'gone';
      if (open.some((u) => u.request === item.request && u.root === item.root)) return 'duplicate';
      if (open.length >= MAX_OPEN) return 'full';
      await this.#append({ t: 'reopen', id, nextAt: Math.max(item.nextAt, now + BACKOFF_MS[0]!) });
      return 'reopened';
    });
  }
}

/** 記録の中身を解く。読めなかった行（壊れた・形の違う）は `odd` に元の文のまま返す（畳むときに捨てない）。 */
function parseLines(raw: string): {
  open: Unfinished[]; canceled: Map<string, Unfinished>; canceledAt: Map<string, number>; odd: string[];
} {
  const odd: string[] = [];
  const open = new Map<string, Unfinished>();
  const canceled = new Map<string, Unfinished>();
  // やめた時刻。やめた順に並ぶ（やめ直すと後ろへ回る）
  const canceledAt = new Map<string, number>();
  for (const text of raw.split('\n')) {
    if (text.trim().length === 0) continue;
    let line: Line;
    try { line = JSON.parse(text) as Line; } catch { odd.push(text); continue; } // 壊れた行は読み飛ばす
    // 形の違う行（手で直した・別の版が書いた）も読み飛ばす。通すと一覧ごと止まる。
    if (!isLine(line)) { odd.push(text); continue; }
    if (line.t === 'add') { open.set(line.item.id, line.item); canceled.delete(line.item.id); canceledAt.delete(line.item.id); }
    else if (line.t === 'bump') {
      const at = open.get(line.id);
      if (at) { at.attempts = line.attempts; at.nextAt = line.nextAt; }
    } else if (line.t === 'close') {
      const at = open.get(line.id);
      open.delete(line.id);
      if (at && line.how === 'canceled') {
        canceled.set(line.id, at);
        canceledAt.delete(line.id);
        if (typeof line.at === 'number' && Number.isFinite(line.at)) canceledAt.set(line.id, line.at);
      } else if (line.how !== 'canceled') {
        // やめた後に別の道が片づけた・諦めたと書いたら、もう戻さない（片づいたものが戻る）
        canceled.delete(line.id);
        canceledAt.delete(line.id);
      }
    } else if (line.t === 'reopen') {
      const at = canceled.get(line.id);
      if (at) {
        canceled.delete(line.id);
        canceledAt.delete(line.id);
        if (typeof line.nextAt === 'number') at.nextAt = line.nextAt;
        open.set(line.id, at);
      }
    }
  }
  return { open: [...open.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)), canceled, canceledAt, odd };
}

/** 一行の形を確かめる。 */
function isLine(v: unknown): v is Line {
  if (typeof v !== 'object' || v === null) return false;
  const l = v as { t?: unknown; id?: unknown; attempts?: unknown; nextAt?: unknown; item?: Record<string, unknown> | null };
  if (l.t === 'add') {
    const i = l.item;
    // 並べ替えと「いま手を付けてよいか」で使う所まで見る。欠けていると一覧ごと止まる。
    return typeof i === 'object' && i !== null && typeof i.id === 'string' && typeof i.request === 'string'
      && typeof i.createdAt === 'string' && typeof i.attempts === 'number' && typeof i.nextAt === 'number';
  }
  if (l.t === 'bump') return typeof l.id === 'string' && typeof l.attempts === 'number' && typeof l.nextAt === 'number';
  // やめた時刻（`at`）の形は見ない。形の違う時刻で閉じた行ごと捨てると、やめたものが戻ってくる（時刻は読むところで数のときだけ使う）
  if (l.t === 'close') return typeof l.id === 'string';
  if (l.t === 'reopen') return typeof l.id === 'string' && (l.nextAt === undefined || typeof l.nextAt === 'number');
  return false;
}

/** 符丁を、人に見せる言葉へ。**基幹には日本語を置かない。** */
export function whyText(why: UnfinishedWhy): string {
  switch (why) {
    case 'maxTurns': return '往復の上限に届いて、途中で切れました';
    case 'noProgress': return '手が止まったまま動きませんでした';
    case 'unverified': return '書き換えたあとの検査が通っていません';
    case 'failed': return '途中で落ちました';
  }
}

/** 続きを頼む文。**元の依頼をそのまま渡す。**要約すると別の作業になる。 */
export function resumePrompt(item: Unfinished): string {
  return [
    '前回の続きです。まだ終わっていません。',
    '',
    `もとの依頼: ${item.request}`,
    `前回の止まり方: ${whyText(item.why)}（${item.note}）`,
    '',
    'いまの作業場を読んで、どこまで出来ているかを確かめてから続けてください。',
    '既に出来ていることは、やり直さないでください。',
  ].join('\n');
}
