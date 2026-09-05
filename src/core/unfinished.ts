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
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';

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
  | { t: 'close'; id: string; how: 'done' | 'gaveUp' | 'canceled' };

/**
 * 抱えてよい上限。
 *
 * 人が見て選べる数を超えたら、それは溜まっているだけで手が付かない。
 */
export const MAX_OPEN = 50;

export class UnfinishedWork {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  async #append(line: Line): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    const raw = await readFile(this.#path, 'utf8').catch(() => '');
    // 途中で落ちた書き込みの続きに繋げない。半端な行が残っていることがある。
    const sep = raw.length === 0 || raw.endsWith('\n') ? '' : '\n';
    await appendFile(this.#path, `${sep}${JSON.stringify(line)}\n`, 'utf8');
  }

  /** いま残っているもの。古い順。 */
  async list(): Promise<Unfinished[]> {
    const raw = await readFile(this.#path, 'utf8').catch(() => '');
    const open = new Map<string, Unfinished>();
    for (const text of raw.split('\n')) {
      if (text.trim().length === 0) continue;
      let line: Line;
      try { line = JSON.parse(text) as Line; } catch { continue; } // 壊れた行は捨てる
      if (line.t === 'add') open.set(line.item.id, line.item);
      else if (line.t === 'bump') {
        const at = open.get(line.id);
        if (at) { at.attempts = line.attempts; at.nextAt = line.nextAt; }
      } else if (line.t === 'close') open.delete(line.id);
    }
    return [...open.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
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

  async add(
    item: Omit<Unfinished, 'id' | 'attempts' | 'nextAt' | 'createdAt'>,
    now = Date.now(),
  ): Promise<Unfinished | undefined> {
    const already = (await this.list()).find((u) => u.request === item.request);
    if (already) return undefined;
    const full: Unfinished = {
      ...item,
      id: `u${now.toString(36)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, '0')}`,
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
    const raw = await readFile(this.#path, 'utf8').catch(() => '');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0).length;
    if (lines <= Math.max(200, max * 4)) return;
    const live = await this.list();
    const body = live.map((item) => `${JSON.stringify({ t: 'add', item })}\n`).join('');
    await mkdir(dirname(this.#path), { recursive: true });
    await writeFile(this.#path, body, 'utf8');
  }

  /** いま手を付けてよいもの。**一つだけ返す**（一度に一つずつ進める）。 */
  async due(now = Date.now()): Promise<Unfinished | undefined> {
    return (await this.list()).find((u) => u.nextAt <= now);
  }

  /**
   * 手を付けた。次はもっと後にする。
   *
   * 上限まで来たら諦める。**諦めたことは、諦めたと言う。**
   * 黙って消すと、頼んだことが消えたようにしか見えない。
   */
  async bump(id: string, now = Date.now()): Promise<{ gaveUp: boolean; attempts: number }> {
    const item = (await this.list()).find((u) => u.id === id);
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
  async done(id: string): Promise<void> {
    await this.#append({ t: 'close', id, how: 'done' });
  }

  /** 利用者がやめた。 */
  async cancel(id: string): Promise<void> {
    await this.#append({ t: 'close', id, how: 'canceled' });
  }
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
