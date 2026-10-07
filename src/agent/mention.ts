/**
 * 依頼にファイルを指名する（`@道`）。
 *
 * 板でファイルを押すと、これまでは**道の文字だけ**が入力欄に入っていた。
 * モデルはその名前を見て、改めて `read_file` で開き直す。開いてくれれば
 * よいが、開かずに推測で書き始めることがあり、そのときは**見ていない物を
 * 直した**ことになる。
 *
 * ここでは、押した時点で `@道` として印を付け、送るときに**中身を依頼へ
 * 差し込む**。指名したものは、必ず読まれた状態で渡る。
 */
import { open, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { decodeForReading } from './tools/decode.ts';
import { trimPartialUtf8 } from '../core/text.ts';
import { isAbsent } from '../harness/put-back.ts';
import { outsideRel, realSafeResolve } from './tools/paths.ts';

/**
 * 上限は、**窓から決める。**
 *
 * 固定の文字数にしていたので、全部で 64,000 文字まで差し込んでいた。
 * 窓が 8k のモデルでは、**それだけで溢れる**（指名した中身は、いま書いた
 * 依頼の一部なので、刈る側は落とせない。落とせないまま窓を超える）。
 *
 * 窓が分からないときの受け皿として、これまでの値を残す。
 */
export const MENTION_MAX_BYTES = 24_000;
export const MENTION_TOTAL_BYTES = 64_000;

/**
 * 窓のうち、**依頼に差し込む中身**に使ってよい割合。残りは依頼と履歴と返事の分。
 *
 * 指名（`@道`）と添付で分け合う。別々に 0.35 を取ると合計 0.7 になり、
 * 決まりの取り分（0.25）と足して窓を越える。**取り分は一つにして、
 * 先に使った分を引く**（`src/ui/server.ts` の送り口）。
 */
export const SHARE_OF_WINDOW = 0.35;

/**
 * 窓（トークン）から、指名に使ってよい文字数を決める。
 *
 * トークンではなく文字で返すのは、切り出しが文字単位のため。
 * **多めに数える**（日本語は1文字1トークン）ので、切る側は安全に倒れる。
 */
export function mentionBudget(contextTokens: number): { each: number; total: number } {
  const total = Math.max(400, Math.floor(contextTokens * SHARE_OF_WINDOW));
  // 一つで全部を使い切らせない。二つ以上指名したときに、後ろが空になる。
  return { each: Math.max(200, Math.floor(total * 0.6)), total };
}

/**
 * `@道` の形。文の頭か、空白・句読点・括弧の後ろの `@` だけを見る（`m@guro.email` のようなメールの `@` は指名ではない）。
 * 空白で終わるのが基本だが、日本語は空白を置かずに続けるので、句読点でも切る。
 */
const MENTION = /(?<=^|[\s、。「」（）()])@([^\s、。「」（）()]+)/g;

/** 道の後ろに付いた英語の句読点（`@src/a.ts,` の `,`）は、道に含めない。 */
function tokenOf(raw: string): string {
  return raw.replace(/[.,:;!?]+$/, '');
}

/**
 * `@` で指名された道を拾う。
 *
 * 空白で終わるのが基本だが、日本語は空白を置かずに続けるので
 * 助詞（を、に、は…）や句読点でも切る。
 */
export function mentionsIn(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(MENTION)) {
    const at = tokenOf(m[1] ?? '');
    if (!at || found.includes(at)) continue;
    found.push(at);
  }
  return found;
}

/**
 * 指名された道から `@` を外して、素の文へ戻す。`only` を渡したら、その道の `@` だけを外す
 * （読めた指名だけ。`@types/node` のように指名でなかったものは、打ったとおりに残す）。
 */
export function stripMentions(text: string, only?: ReadonlySet<string>): string {
  return text.replace(MENTION, (whole, raw: string) => {
    const at = tokenOf(raw);
    return only && !only.has(at) ? whole : whole.slice(1);
  });
}

export interface MentionRead {
  readonly path: string;
  /** 打たれた道（`@` の後ろ、そのまま）。 */
  readonly at?: string;
  /** 在りませんでした。**指名ではなかったもの**として扱う（`@types/node`・`@pytest.fixture` など）。 */
  readonly missing?: boolean;
  readonly ok: boolean;
  /** 中身。読めなかったときは、なぜ読めないか。 */
  readonly body: string;
  readonly truncated?: boolean;
}

export interface MentionOpts {
  readonly readFileImpl?: (p: string) => Promise<string>;
  readonly statImpl?: (p: string) => Promise<{ isDirectory(): boolean; isFile?(): boolean; size: number }>;
  readonly maxBytes?: number;
  readonly totalBytes?: number;
  /** いまの窓（トークン）。渡されたら、上限はここから決める。 */
  readonly contextTokens?: number;
}

/**
 * 指名されたものを読む。
 *
 * **作業場の外へは出さない。**`@../../.ssh/id_rsa` のような指名で、
 * 触らせるつもりのない場所を読ませない。
 */
export async function readMentions(
  text: string,
  root: string,
  opts: MentionOpts = {},
): Promise<MentionRead[]> {
  const rf = opts.readFileImpl ?? readForMention;
  const st = opts.statImpl ?? ((p: string) => stat(p));
  const fromWindow = opts.contextTokens ? mentionBudget(opts.contextTokens) : undefined;
  const each = opts.maxBytes ?? fromWindow?.each ?? MENTION_MAX_BYTES;
  const total = opts.totalBytes ?? fromWindow?.total ?? MENTION_TOTAL_BYTES;

  const out: MentionRead[] = [];
  let used = 0;
  for (const at of mentionsIn(text)) {
    const full = isAbsolute(at) ? resolve(at) : resolve(join(root, at));
    const rel = relative(resolve(root), full);
    if (outsideRel(rel)) {
      out.push({ path: at, ok: false, body: '作業場の外なので読みません' });
      continue;
    }
    // リンクを辿った先まで見る（read_file と同じ）。文字の上で中でも、`home -> /home/user` のリンク越しに鍵を差し込めていた
    if (!opts.statImpl && await realSafeResolve(root, rel) === undefined) {
      out.push({ path: at, ok: false, body: 'リンクの先が作業場の外なので読みません' });
      continue;
    }
    try {
      const info = await st(full);
      if (info.isDirectory()) {
        out.push({ path: at, ok: false, body: 'フォルダです。中のファイルを指名してください' });
        continue;
      }
      // 普通のファイルだけ（FIFO は書き手を待って戻らず、依頼の組み立てごと止まっていた）
      if (info.isFile && !info.isFile()) {
        out.push({ path: at, ok: false, body: '普通のファイルではないので読みません（FIFO・装置など）' });
        continue;
      }
      if (used >= total) {
        out.push({ path: at, ok: false, body: 'ここまでで一杯です。必要なら read_file で開いてください' });
        continue;
      }
      const room = Math.min(each, total - used);
      const body = await rf(full);
      const cut = body.length > room;
      const shown = cut ? body.slice(0, room) : body;
      used += shown.length;
      out.push({ path: rel.split(sep).join('/'), at, ok: true, body: shown, truncated: cut });
    } catch (e) {
      out.push({ path: at, at, ok: false, body: (e as Error).message, ...(isAbsent(e) ? { missing: true } : {}) });
    }
  }
  return out;
}

/**
 * 指名されたファイルを、read_file と同じ読み方で読む（`decode.ts`）。
 * 食い違うと、指名では化けた中身が入り、「続きは read_file で」と案内した先では別の読み方になる。
 */
async function readForMention(p: string): Promise<string> {
  // 頭だけ読む（数百 MB のファイルを指名されても、使うのは頭の数万文字だけ。全部を読み込まない）
  const fh = await open(p, 'r');
  let bytes: Buffer;
  try {
    const buf = Buffer.alloc(MENTION_READ_CAP);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    // 上限で切ったときは、末尾の途中の字を落とす（字の途中で切ると、読めない字として別の読み方（CP932）に取り違える）
    const head = buf.subarray(0, bytesRead);
    bytes = Buffer.from(bytesRead === buf.length ? trimPartialUtf8(head) : head);
  } finally {
    await fh.close();
  }
  const decoded = decodeForReading(bytes);
  if (decoded.kind === 'binary') throw new Error(`二進のファイルです（${decoded.bytes} バイト）`);
  return decoded.encoding === 'utf-8' ? decoded.text : `${decoded.note}\n${decoded.text}`;
}

/** 指名で読む頭の大きさ（read_file の一度に読む上限と同じ）。これより後ろは使わない */
const MENTION_READ_CAP = 400_000;

/** 読んだものを、依頼の前に置く形に組む。 */
export function mentionBlock(reads: readonly MentionRead[]): string {
  if (reads.length === 0) return '';
  const parts: string[] = ['[指名されたファイル]'];
  for (const r of reads) {
    if (!r.ok) { parts.push(`--- ${r.path} （読めません: ${r.body}）`); continue; }
    parts.push(`--- ${r.path}${r.truncated ? ' （長いので頭だけ。続きは read_file で）' : ''}\n${r.body}`);
  }
  return parts.join('\n');
}

/**
 * 依頼を、指名の中身ごと組み直す。
 *
 * 中身は**前**に置く。後ろに置くと、長い中身に押されて肝心の指示が
 * 末尾へ行き、取りこぼす（添付と同じ理由）。
 */
export async function expandMentions(
  text: string,
  root: string,
  opts: MentionOpts = {},
): Promise<{ text: string; reads: MentionRead[] }> {
  /*
   * **在らないものは指名ではない。**`@` の付いた言葉を全部指名として読み、`@` を外していたので、`npm i -D @types/node` は
   * `types/node` として（別の包みの名前になって）モデルへ渡り、コードの `@pytest.fixture` も `@` を失っていた。
   * 在らないものは中身の塊にも載せず、`@` も打ったとおりに残す。在るのに読めない（外・フォルダ・一杯）ものは今までどおり言う
   */
  const reads = (await readMentions(text, root, opts)).filter((r) => !r.missing);
  if (reads.length === 0) return { text, reads };
  const read = new Set(reads.filter((r) => r.ok).map((r) => r.at ?? r.path));
  return { text: `${mentionBlock(reads)}\n\n${stripMentions(text, read)}`, reads };
}
