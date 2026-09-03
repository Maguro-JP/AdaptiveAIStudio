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
import { readdir, readFile, appendFile, writeFile, mkdir, rm, stat } from 'node:fs/promises';
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
}

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

/** 新しい id。人が見ても順番が分かる形にしておく。 */
export function newId(now = new Date(), rand = Math.random): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`
    + `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  const tail = Math.floor(rand() * 36 ** 4).toString(36).padStart(4, '0');
  return `c${stamp}-${tail}`;
}

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
  async list(): Promise<ConversationHead[]> {
    let names: string[];
    try {
      names = await readdir(this.#dir);
    } catch {
      return []; // まだ一度も話していない。異常ではない。
    }
    const heads: ConversationHead[] = [];
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const id = name.slice(0, -'.jsonl'.length);
      if (!ID_SHAPE.test(id)) continue;
      const head = await this.head(id).catch(() => undefined);
      if (head) heads.push(head);
    }
    heads.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return heads;
  }

  /** 見出しだけを読む。一覧では中身まで組み立てない。 */
  async head(id: string): Promise<ConversationHead> {
    const path = this.#path(id);
    const [raw, info] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
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
    return { id, title, createdAt, updatedAt: info.mtime.toISOString(), messages };
  }

  /** やりとりを読む。**壊れた行は捨てて、読める分を返す。** */
  async load(id: string): Promise<ProviderMessage[]> {
    let raw: string;
    try {
      raw = await readFile(this.#path(id), 'utf8');
    } catch {
      return [];
    }
    const out: ProviderMessage[] = [];
    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue;
      const rec = parse(line);
      if (rec?.t === 'msg') out.push(rec.m);
    }
    return out;
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

  /** 消す。無いものを消しても落ちない。 */
  async remove(id: string): Promise<void> {
    await rm(this.#path(id), { force: true });
  }
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
