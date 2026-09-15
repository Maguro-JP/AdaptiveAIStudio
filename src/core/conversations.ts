/**
 * 会話を残す。
 *
 * ここまで、やりとりは**メモリの中だけ**だった。窓を閉じれば消え、
 * 立ち上げ直せば無かったことになる。横の板に「会話」の枠だけあって
 * 中身が無かったのは、残す仕組みが無かったから。
 *
 * 一つの会話 = 一つのファイル（`<id>.jsonl`）。
 * 一行目が見出し、そのあとが、やりとりを1行ずつ。
 *
 * **足すだけで書く。**丸ごと書き直すと、書いている最中に落ちたときに
 * 全部を失う。行ごとなら、壊れた行を捨てるだけで残りは読める。
 */
import { readdir, readFile, appendFile, writeFile, mkdir, rm, stat, open } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProviderMessage } from '../providers/contract.ts';

/** 一覧に出す見出し。中身（やりとり）は含めない。 */
export interface ConversationHead {
  id: string;
  /** 最初の依頼から作る。空なら「新しい会話」 */
  title: string;
  createdAt: string;
  updatedAt: string;
  /** やりとりの数。空の会話を見分けるのに使う */
  messages: number;
  /**
   * 数え切れていない（頭しか読んでいない）。
   *
   * **正しく数える必要があるのは、小さいうちだけ。**空かどうかの判定に
   * 使うので、少ない側は正確でなければならない。多い側は「たくさん」で足りる。
   */
  more?: boolean;
}

/**
 * 見出しを作るときに読む量。
 *
 * ここまで、一覧のために**ファイルを丸ごと読んでいた**。半年ひとつの会話を
 * 続けると 16.6MB になり、1 件で 177ms。一覧は最大 100 件読むので、
 * 長く使うほど開けなくなる（読むだけで 90ms を占めていた。数え方を
 * 速くしても効かない。**読む量を減らすしかない**）。
 */
const HEAD_SCAN = 128 * 1024;

interface MetaLine { t: 'meta'; id: string; title: string; createdAt: string }
interface MsgLine { t: 'msg'; at: string; m: ProviderMessage }

/**
 * 名前に使ってよい形。
 *
 * 画面から来た id をそのまま道に繋ぐので、ここで止める。
 * 点や区切りが混ざると、置き場の外のファイルを消せる口になる。
 */
export const ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;

/** 見出しの長さ。一覧に収まる範囲で切る。 */
const TITLE_MAX = 40;

/** 最初の依頼から見出しを作る。改行は落とし、長ければ切る。 */
export function titleFrom(text: string): string {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  if (line.length === 0) return '新しい会話';
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX)}…` : line;
}

/** 名前の末尾に使える幅。base36 の4桁。 */
const TAIL_MAX = 36 ** 4 - 1;

/**
 * 直前に配った名前を、秒ごとに覚えておく。
 *
 * **同じ秒の中でだけ効かせる。**秒が変われば時刻の側で順が決まるので、
 * 前の秒のことは忘れてよい。
 */
let lastHead = '';
let lastTail = '';

/**
 * 新しい id。人が見ても順番が分かる形にしておく。
 *
 * **同じ秒に二つ以上作られる。**時刻は秒までしか入っていないので、
 * そこから先は末尾の乱数で決まる。つまり、続けて作った二つの並びが
 * 逆になることがある。一覧は名前で並べているので、そのまま
 * 「新しい順」が崩れた（120 件を続けて作ると、実際に順が入れ替わった）。
 *
 * だから、**前に配った名前より必ず後になる**ようにしてから返す。
 * 乱数はそのまま使い、後ろへ回らないときだけ一つ進める。
 */
export function newId(now = new Date(), rand = Math.random): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`
    + `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  const head = `c${stamp}-`;
  let tail = Math.floor(rand() * (TAIL_MAX + 1)).toString(36).padStart(4, '0');
  if (head === lastHead && tail <= lastTail) tail = after(lastTail);
  lastHead = head;
  lastTail = tail;
  return `${head}${tail}`;
}

/**
 * その末尾の、次に来るもの。**必ず後になり、必ず別のものになる。**
 *
 * 4桁を使い切ったときに**同じ名前で頭打ちにしない。**一度そうしていて、
 * 使い切った後に配る名前が全部同じになり、**会話が上書きで消えた**
 * （試験では 106 件作って 1 件しか残らなかった）。順番が崩れるより悪い。
 *
 * 使い切ったら、後ろに桁を足す。`-` は数字より前に並ぶので、
 * `zzzz` < `zzzz-0001` < `zzzz-0002` の順は保たれる。
 */
function after(tail: string): string {
  const [base = '', over] = tail.split('-');
  const next = over === undefined ? 1 : parseInt(over, 36) + 1;
  if (base.length === 4 && parseInt(base, 36) < TAIL_MAX && over === undefined) {
    return (parseInt(base, 36) + 1).toString(36).padStart(4, '0');
  }
  return `${base}-${next.toString(36).padStart(4, '0')}`;
}

/**
 * 一覧に出す上限。
 *
 * これより古いものは、消えてはいない（ファイルは残る）。出さないだけ。
 */
export const LIST_LIMIT = 100;

export class Conversations {
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
  }

  #path(id: string): string {
    if (!ID_SHAPE.test(id)) throw new Error(`会話の名前として使えません: ${id}`);
    return join(this.#dir, `${id}.jsonl`);
  }

  /** 新しい会話を始める。中身はまだ無い。 */
  async create(id = newId()): Promise<ConversationHead> {
    await mkdir(this.#dir, { recursive: true });
    const createdAt = new Date().toISOString();
    const meta: MetaLine = { t: 'meta', id, title: '新しい会話', createdAt };
    await writeFile(this.#path(id), `${JSON.stringify(meta)}\n`, 'utf8');
    return { id, title: meta.title, createdAt, updatedAt: createdAt, messages: 0 };
  }

  /** 新しいものが上。**空の会話も出す**（作った直後に消えると戸惑う）。 */
  /**
   * 新しい順に。
   *
   * **全部は読まない。**一覧は開くたびに作るので、会話が増えるほど重くなる
   * （540 件で 155ms、全部のファイルを開く）。誰も 540 件を辿らないので、
   * 読むのも返すのも新しい方から `limit` 件で止める。
   *
   * 並べ替えの鍵は名前に入っている（`newId()` が時刻から作る）ので、
   * 中身を読む前に順は決められる。**読む数そのものを減らす。**
   */
  async list(limit = LIST_LIMIT): Promise<ConversationHead[]> {
    let names: string[];
    try {
      names = await readdir(this.#dir);
    } catch {
      return []; // まだ一度も話していない。異常ではない。
    }
    const ids = names
      .filter((n) => n.endsWith('.jsonl'))
      .map((n) => n.slice(0, -'.jsonl'.length))
      .filter((id) => ID_SHAPE.test(id))
      .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));

    const heads: ConversationHead[] = [];
    for (const id of ids) {
      if (heads.length >= limit) break;
      const head = await this.head(id).catch(() => undefined);
      if (head) heads.push(head);
    }
    heads.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return heads;
  }

  /** 全部で何件あるか。一覧に出ていない分を言うために使う。 */
  async count(): Promise<number> {
    try {
      const names = await readdir(this.#dir);
      return names.filter((n) => n.endsWith('.jsonl') && ID_SHAPE.test(n.slice(0, -6))).length;
    } catch { return 0; }
  }

  /** 見出しだけを読む。一覧では中身まで組み立てない。 */
  async head(id: string): Promise<ConversationHead> {
    const path = this.#path(id);
    const info = await stat(path);

    // **頭だけ読む。**見出しは1行目に在り、数えるのが要るのは小さいうちだけ。
    const fh = await open(path, 'r');
    let raw: string;
    let more = false;
    try {
      const buf = Buffer.alloc(Math.min(HEAD_SCAN, info.size));
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      more = info.size > bytesRead;
      let text = buf.subarray(0, bytesRead).toString('utf8');
      // 途中で切れた行は捨てる（字の途中で切れていることもある）。
      if (more) {
        const at = text.lastIndexOf('\n');
        text = at >= 0 ? text.slice(0, at) : '';
      }
      raw = text;
    } finally {
      await fh.close();
    }

    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    let title = '新しい会話';
    let createdAt = info.birthtime.toISOString();
    let messages = 0;
    for (const line of lines) {
      const rec = parse(line);
      if (!rec) continue;
      if (rec.t === 'meta') { title = rec.title; createdAt = rec.createdAt; continue; }
      // 数えるのは、人が書いたものと、中身のある返事だけ。
      // 道具を呼ぶためだけの空の返事は、人から見れば一往復ではない。
      if (rec.m.role === 'user') messages += 1;
      else if (rec.m.role === 'assistant' && rec.m.content.trim().length > 0) messages += 1;
    }
    return {
      id, title, createdAt, updatedAt: info.mtime.toISOString(), messages,
      ...(more ? { more: true } : {}),
    };
  }

  /**
   * やりとりを読む。**壊れた行は捨てて、読める分を返す。**
   *
   * `tailBytes` を渡すと、**後ろからその分だけ**読む。
   * 半年ひとつの会話を続けると 16MB になり、丸ごと読むと 137ms かかるうえ、
   * 10,800 通を抱えたまま動くことになる。窓に入るのはそのうち数十通で、
   * **残りは読んでも捨てるだけ。**
   */
  async load(id: string, opts: { tailBytes?: number } = {}): Promise<ProviderMessage[]> {
    const path = this.#path(id);
    let raw: string;
    try {
      if (opts.tailBytes === undefined) {
        raw = await readFile(path, 'utf8');
      } else {
        const info = await stat(path);
        const from = Math.max(0, info.size - opts.tailBytes);
        const fh = await open(path, 'r');
        try {
          const buf = Buffer.alloc(info.size - from);
          const { bytesRead } = await fh.read(buf, 0, buf.length, from);
          const text = buf.subarray(0, bytesRead).toString('utf8');
          // 頭は行の途中（字の途中のことも）から始まる。最初の改行まで捨てる。
          raw = from > 0 ? text.slice(text.indexOf('\n') + 1) : text;
        } finally {
          await fh.close();
        }
      }
    } catch {
      return [];
    }
    const out: ProviderMessage[] = [];
    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue;
      const rec = parse(line);
      if (rec?.t === 'msg') out.push(rec.m);
    }
    return trimDangling(out);
  }

  /** 足す。書いている最中に落ちても、そこまでは残る。 */
  async append(id: string, messages: readonly ProviderMessage[]): Promise<void> {
    const path = this.#path(id);
    if (messages.length === 0) return;
    await mkdir(this.#dir, { recursive: true });
    const at = new Date().toISOString();
    const body = messages.map((m) => `${JSON.stringify({ t: 'msg', at, m } satisfies MsgLine)}\n`).join('');
    // **前の行の途中に繋げない。**書いている最中に落ちると、改行の無い
    // 半端な行が残る。そこへ足すと、次の行まで巻き添えで読めなくなる。
    await appendFile(path, (await endsWithNewline(path)) ? body : `\n${body}`, 'utf8');
  }

  /**
   * 見出しを付ける。**まだ付いていないときだけ。**
   * あとから来た依頼で書き換えると、一覧の見出しが会話の途中を指す。
   */
  async titleIfUnset(id: string, text: string): Promise<void> {
    const head = await this.head(id).catch(() => undefined);
    if (!head || head.title !== '新しい会話') return;
    const raw = await readFile(this.#path(id), 'utf8');
    const lines = raw.split('\n');
    const first = parse(lines[0] ?? '');
    if (first?.t !== 'meta') return;
    lines[0] = JSON.stringify({ ...first, title: titleFrom(text) } satisfies MetaLine);
    await writeFile(this.#path(id), lines.join('\n'), 'utf8');
  }

  /**
   * 見出しを付け替える。**利用者が決めた名前は、あとから上書きしない。**
   *
   * 見出しは最初の依頼から自動で付くだけで、直す口が無かった。中身と合わない
   * 名前が並んでも、消して作り直す以外に手が無い。
   *
   * 空にされたら、自動で付く側へ戻す（`新しい会話` に戻すと、次の依頼で
   * また自動の見出しが付く）。
   */
  async rename(id: string, title: string): Promise<string> {
    const raw = await readFile(this.#path(id), 'utf8');
    const lines = raw.split('\n');
    const first = parse(lines[0] ?? '');
    if (first?.t !== 'meta') throw new Error('会話の見出しが読めません');
    const trimmed = title.replace(/\s+/g, ' ').trim();
    const next = trimmed.length === 0
      ? '新しい会話'
      : (trimmed.length > TITLE_MAX ? `${trimmed.slice(0, TITLE_MAX)}…` : trimmed);
    lines[0] = JSON.stringify({ ...first, title: next } satisfies MetaLine);
    await writeFile(this.#path(id), lines.join('\n'), 'utf8');
    return next;
  }

  /** 消す。無いものを消しても落ちない。 */
  async remove(id: string): Promise<void> {
    await rm(this.#path(id), { force: true });
  }
}

/**
 * 頭に残った、宙に浮いた道具の結果を落とす。
 *
 * 後ろから読むと、**呼び出しが無いのに結果だけが在る**ことがある。
 * OpenAI 互換の口はその形を受け取らずに落ちる。読めた分から作るときは、
 * 最初のまともな始まり（人の発言）まで捨てる。
 */
function trimDangling(messages: ProviderMessage[]): ProviderMessage[] {
  const at = messages.findIndex((m) => m.role === 'user' || m.role === 'assistant');
  if (at <= 0) return messages;
  // 先頭が道具の結果だけのときは、その塊ごと捨てる。
  return messages[0]?.role === 'tool' ? messages.slice(at) : messages;
}

/** 最後が改行で終わっているか。無い＝途中で落ちた書き込みが残っている。 */
async function endsWithNewline(path: string): Promise<boolean> {
  try {
    const raw = await readFile(path, 'utf8');
    return raw.length === 0 || raw.endsWith('\n');
  } catch {
    return true; // まだ無い。足せばそのまま1行目になる。
  }
}

/** 1行を読む。読めない行は捨てる（途中で落ちた書き込みが残ることがある）。 */
function parse(line: string): MetaLine | MsgLine | undefined {
  try {
    const v = JSON.parse(line) as MetaLine | MsgLine;
    if (v && (v.t === 'meta' || v.t === 'msg')) return v;
  } catch { /* 壊れた行。捨てる */ }
  return undefined;
}
