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
import { readdir, readFile, appendFile, writeFile, mkdir, rm, rename, stat, open } from 'node:fs/promises';
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

/** 見出しの行（1 行目）の題。読めない・見出しが無いときは「新しい会話」（一覧と同じ）。 */
async function titleOf(path: string): Promise<string> {
  try {
    const fh = await open(path, 'r');
    try {
      const buf = Buffer.alloc(4096);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      const first = parse(buf.subarray(0, bytesRead).toString('utf8').split('\n')[0] ?? '');
      return first?.t === 'meta' && typeof first.title === 'string' && first.title ? first.title : '新しい会話';
    } finally {
      await fh.close();
    }
  } catch {
    return '新しい会話';
  }
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
  return cutTitle(line);
}

/** 見出しの長さで切る。字の単位で数える（UTF-16 の単位で切ると、絵文字を半分に割る）。 */
function cutTitle(line: string): string {
  const chars = Array.from(line);
  return chars.length > TITLE_MAX ? `${chars.slice(0, TITLE_MAX).join('')}…` : line;
}

/**
 * 同じ会話のファイルへの書き込みを、一列に並べる。
 *
 * 見出しの書き換えは全体を読んで書き戻すので、その間に足した返事を古い中身で上書きして消していた。
 * 足す・書き戻す・作る・消すを、ファイルごとに順番に通す（同じプロセスの中の入れ物は、どれもここを通る）。
 */
const writing = new Map<string, Promise<unknown>>();
function inOrder<T>(path: string, run: () => Promise<T>): Promise<T> {
  const prev = writing.get(path) ?? Promise.resolve();
  // 前が失敗しても列は進める。
  const mine = prev.then(run, run);
  const settled = mine.catch(() => undefined);
  writing.set(path, settled);
  settled.then(() => { if (writing.get(path) === settled) writing.delete(path); }).catch(() => undefined);
  return mine;
}

let tmpSeq = 0;
/**
 * 書き戻す。隣の一時ファイルに書き切って（ディスクまで）から置き換える。プロセスが途中で落ちても前の中身が残る
 * （OS ごと落ちたときは、ファイルシステム次第で確かめていない）。
 *
 * Windows では、ウイルス対策や検索が一時ファイルや元のファイルを掴んでいると、置き換えが一時的に断られる
 * （EPERM・EACCES・EBUSY）。少し待って数回やり直す。残った一時ファイルは `npm run clean` が片づける（`.tmp`）。
 */
async function replaceWhole(path: string, text: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${++tmpSeq}.tmp`;
  try {
    const fh = await open(tmp, 'w');
    try {
      await fh.writeFile(text, 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    for (let tries = 0; ; tries += 1) {
      try {
        await rename(tmp, path);
        return;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (tries >= 10 || !(code === 'EPERM' || code === 'EACCES' || code === 'EBUSY')) throw e;
        await new Promise((r) => setTimeout(r, 100 + tries * 50));
      }
    }
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
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
  async create(given?: string): Promise<ConversationHead> {
    await mkdir(this.#dir, { recursive: true });
    const createdAt = new Date().toISOString();
    /*
     * **既にある会話を空にしない。**作るときは「無ければ作る」（wx）で書く。名前を任せられたときは、
     * ぶつかったら引き直す（別のプロセスが同じ秒に同じ末尾を引くことがある）。名前を渡されたときは断る。
     */
    for (let tries = 0; ; tries += 1) {
      const id = given ?? newId();
      const meta: MetaLine = { t: 'meta', id, title: '新しい会話', createdAt };
      const path = this.#path(id);
      try {
        await inOrder(path, () => writeFile(path, `${JSON.stringify(meta)}\n`, { encoding: 'utf8', flag: 'wx' }));
        return { id, title: meta.title, createdAt, updatedAt: createdAt, messages: 0 };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        if (given !== undefined) throw new Error(`その名前の会話は既にあります: ${id}`);
        if (tries >= 20) throw e;
      }
    }
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
          // 一つ手前の字も読む。それが改行なら、読み始めは行の頭ちょうどなので捨てない。
          const start = Math.max(0, from - 1);
          const buf = Buffer.alloc(info.size - start);
          const { bytesRead } = await fh.read(buf, 0, buf.length, start);
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
    await inOrder(path, async () => {
      /*
       * 消した後に書き足しが来た（走っていた依頼の答えが、消した後に届いた）。元の場所に書くと、見出しの無い切れ端の会話が
       * 一覧に出て、本物は同じ名前が在るので戻せなくなる。消した方へ足す（戻せば、その1ターンも一緒に戻る）。
       */
      const to = (await exists(path)) ? path : ((await this.#trashedLatest(id)) ?? path);
      await appendFile(to, (await endsWithNewline(to)) ? body : `\n${body}`, 'utf8');
    });
  }

  /**
   * 見出しを付ける。**まだ付いていないときだけ。**
   * あとから来た依頼で書き換えると、一覧の見出しが会話の途中を指す。
   */
  async titleIfUnset(id: string, text: string): Promise<void> {
    const head = await this.head(id).catch(() => undefined);
    if (!head || head.title !== '新しい会話') return;
    const path = this.#path(id);
    await inOrder(path, async () => {
      const raw = await readFile(path, 'utf8');
      const lines = raw.split('\n');
      const first = parse(lines[0] ?? '');
      // 並んで待つ間に別の所が付けていたら、上書きしない。
      if (first?.t !== 'meta' || first.title !== '新しい会話') return;
      lines[0] = JSON.stringify({ ...first, title: titleFrom(text) } satisfies MetaLine);
      await replaceWhole(path, lines.join('\n'));
    });
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
    const path = this.#path(id);
    return inOrder(path, async () => {
      const raw = await readFile(path, 'utf8');
      const lines = raw.split('\n');
      const first = parse(lines[0] ?? '');
      if (first?.t !== 'meta') throw new Error('会話の見出しが読めません');
      const trimmed = title.replace(/\s+/g, ' ').trim();
      const next = trimmed.length === 0 ? '新しい会話' : cutTitle(trimmed);
      lines[0] = JSON.stringify({ ...first, title: next } satisfies MetaLine);
      await replaceWhole(path, lines.join('\n'));
      return next;
    });
  }

  /**
   * 消す。無いものを消しても落ちない。**すぐには消さず、`trash/` へ移す。**画面の「戻す」で戻せるように
   * （押し間違えた会話は、ほかに写しが無い）。移したものは、次に立ち上げたときに本当に消す（`purgeTrash`）。
   * 消したつもりの会話を、ディスクに長く残さない（秘密を書いてしまった会話を消す人がいる）。
   *
   * 移した先の名前には消した時刻を入れる（`<id>.<時刻>.jsonl`）。同じ会話を二度消しても、前に移したものを上書きしない。
   */
  async remove(id: string): Promise<void> {
    const path = this.#path(id);
    await inOrder(path, () => inOrder(this.#trash, async () => {
      await mkdir(this.#trash, { recursive: true });
      // 消した順が時刻で一つに決まるように、移した先に在るどれよりも後にする（同じミリ秒に続けて消すと、戻す一覧の並びが揺れた）
      const latest = Math.max(0, ...(await this.#trashed()).map((t) => t.at));
      let at = Math.max(Date.now(), latest + 1);
      while (await exists(join(this.#trash, `${id}.${at}.jsonl`))) at += 1;
      try {
        await renameRetrying(path, join(this.#trash, `${id}.${at}.jsonl`));
      } catch (e) {
        // 無いものを消すのは、落ちずに済ませる。無いのが元のファイルだと確かめてから（移す先が消えていても ENOENT になる）
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || await exists(path)) throw e;
      }
    }));
  }

  /**
   * 消した会話を戻す。戻した名前を返す。
   * - `gone`: 移した先に無い（立ち上げ直して本当に消えた、または消していない）
   * - `already`: もう戻っている（別のタブで戻した）
   *
   * 同じ名前の会話が既に在るとき（消した後に同じ名前で作り直された）は、上書きせず、別の名前で戻す。
   * 二度以上消していたら、最初に消したもの（元の本体）を戻す。
   */
  async restore(id: string): Promise<{ id: string } | 'gone' | 'already'> {
    const path = this.#path(id);
    return inOrder(path, () => inOrder(this.#trash, async () => {
      const mine = (await this.#trashed()).filter((t) => t.id === id).sort((x, y) => x.at - y.at);
      const from = mine[0];
      if (!from) return (await exists(path)) ? 'already' : 'gone';
      if (!(await exists(path))) {
        await renameRetrying(from.path, path);
        return { id };
      }
      // 別の名前で戻す。見出しの行の名前も書き換える（いま読む所は無いが、ファイルの名前と中の名前の食い違いを残さない）
      const lines = (await readFile(from.path, 'utf8')).split('\n');
      const other = newId();
      const first = parse(lines[0] ?? '');
      if (first?.t === 'meta') lines[0] = JSON.stringify({ ...first, id: other } satisfies MetaLine);
      await writeFile(this.#path(other), lines.join('\n'), { encoding: 'utf8', flag: 'wx' });
      await rm(from.path, { force: true });
      return { id: other };
    }));
  }

  /**
   * 戻せる会話（消した新しい順、会話ごとに一件）。画面が最後の一件だけを持っていたので、続けて二つ消すと一つ目を戻せず、
   * 画面を開き直すと戻す口ごと消えた。題は戻すときに戻る方（最初に消したもの）の見出しから取る。
   */
  async trashList(limit = 20): Promise<{ id: string; title: string; at: number }[]> {
    const byId = new Map<string, { first: { at: number; path: string }; latest: number }>();
    for (const t of await this.#trashed()) {
      const got = byId.get(t.id);
      if (!got) { byId.set(t.id, { first: t, latest: t.at }); continue; }
      if (t.at < got.first.at) got.first = t;
      got.latest = Math.max(got.latest, t.at);
    }
    const newest = [...byId.entries()].sort((x, y) => y[1].latest - x[1].latest).slice(0, limit);
    const out: { id: string; title: string; at: number }[] = [];
    for (const [id, { first, latest }] of newest) out.push({ id, title: await titleOf(first.path), at: latest });
    return out;
  }

  /** 移した先に在るもの。名前の形の違うものは見ない。 */
  async #trashed(): Promise<{ id: string; at: number; path: string }[]> {
    const names = await readdir(this.#trash).catch(() => [] as string[]);
    return names.flatMap((name) => {
      const m = /^(.+)\.(\d+)\.jsonl$/.exec(name);
      return m && ID_SHAPE.test(m[1]!) ? [{ id: m[1]!, at: Number(m[2]), path: join(this.#trash, name) }] : [];
    });
  }

  /** 消した会話を本当に消す。立ち上げたときに呼ぶ。消した数を返す。 */
  async purgeTrash(): Promise<number> {
    return inOrder(this.#trash, async () => {
      const names = await readdir(this.#trash).catch(() => [] as string[]);
      let gone = 0;
      for (const name of names) {
        // 掴まれていたら少し待ってやり直す（Windows のウイルス対策）。消せなかったものは次に立ち上げたときにまた消す
        const ok = await rm(join(this.#trash, name), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).then(() => true, () => false);
        if (ok) gone += 1;
      }
      return gone;
    });
  }

  /** 消した後に来た書き足しの行き先（最後に消したもの）。無ければ undefined。 */
  async #trashedLatest(id: string): Promise<string | undefined> {
    const mine = (await this.#trashed()).filter((t) => t.id === id).sort((x, y) => y.at - x.at);
    return mine[0]?.path;
  }

  get #trash(): string {
    return join(this.#dir, 'trash');
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
  // ツールの結果しか無いなら、渡せるものは無い（呼び出しの無い結果を渡すと、OpenAI 互換の口が落ちる）。
  if (at === -1) return messages.some((m) => m.role === 'tool') ? [] : messages;
  if (at === 0) return messages;
  // 先頭が道具の結果だけのときは、その塊ごと捨てる。
  return messages[0]?.role === 'tool' ? messages.slice(at) : messages;
}

/** 最後が改行で終わっているか。無い＝途中で落ちた書き込みが残っている。 */
async function endsWithNewline(path: string): Promise<boolean> {
  // 最後の一字だけを読む（全体を読むと、16MB の会話で一行足すたびに 100ms かかった）。
  let fh;
  try {
    fh = await open(path, 'r');
  } catch {
    return true; // まだ無い。足せばそのまま1行目になる。
  }
  try {
    const { size } = await fh.stat();
    if (size === 0) return true;
    const one = Buffer.alloc(1);
    await fh.read(one, 0, 1, size - 1);
    return one[0] === 0x0a;
  } finally {
    await fh.close();
  }
}

/** 1行を読む。読めない行は捨てる（途中で落ちた書き込みが残ることがある）。 */
function parse(line: string): MetaLine | MsgLine | undefined {
  try {
    const v = JSON.parse(line) as MetaLine | MsgLine;
    if (v?.t === 'meta' && typeof v.title === 'string') return v;
    // 形の合わない返事の行（m が無い・content が文字でない・role が違う）は捨てる。
    // 通すと、一覧を作る所が落ちて会話ごと一覧から消え、読む所は undefined を履歴に混ぜた。
    if (v?.t === 'msg' && isMessage(v.m)) return v;
  } catch { /* 壊れた行。捨てる */ }
  return undefined;
}

const ROLES = new Set(['system', 'user', 'assistant', 'tool']);
function isMessage(m: unknown): m is ProviderMessage {
  if (typeof m !== 'object' || m === null) return false;
  const r = m as { role?: unknown; content?: unknown };
  return typeof r.role === 'string' && ROLES.has(r.role) && typeof r.content === 'string';
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

/** 置き換え（`replaceWhole`）と同じく、掴まれていたら少し待って数回やり直す（Windows のウイルス対策・検索）。 */
async function renameRetrying(from: string, to: string): Promise<void> {
  for (let tries = 0; ; tries += 1) {
    try {
      await rename(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (tries >= 10 || !(code === 'EPERM' || code === 'EACCES' || code === 'EBUSY')) throw e;
      await new Promise((r) => setTimeout(r, 100 + tries * 50));
    }
  }
}
