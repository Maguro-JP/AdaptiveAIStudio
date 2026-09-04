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
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/** 1つあたりの上限。これを超える分は頭だけ渡し、続きは道具で読ませる。 */
export const MENTION_MAX_BYTES = 24_000;
/** 全部で渡す上限。窓を指名だけで埋めない。 */
export const MENTION_TOTAL_BYTES = 64_000;

/**
 * `@` で指名された道を拾う。
 *
 * 空白で終わるのが基本だが、日本語は空白を置かずに続けるので
 * 助詞（を、に、は…）や句読点でも切る。
 */
export function mentionsIn(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/@([^\s、。「」（）()]+)/g)) {
    const at = m[1];
    if (!at || found.includes(at)) continue;
    found.push(at);
  }
  return found;
}

/** 指名された道から `@` を外して、素の文へ戻す。 */
export function stripMentions(text: string): string {
  return text.replace(/@([^\s、。「」（）()]+)/g, '$1');
}

export interface MentionRead {
  readonly path: string;
  readonly ok: boolean;
  /** 中身。読めなかったときは、なぜ読めないか。 */
  readonly body: string;
  readonly truncated?: boolean;
}

export interface MentionOpts {
  readonly readFileImpl?: (p: string) => Promise<string>;
  readonly statImpl?: (p: string) => Promise<{ isDirectory(): boolean; size: number }>;
  readonly maxBytes?: number;
  readonly totalBytes?: number;
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
  const rf = opts.readFileImpl ?? ((p: string) => readFile(p, 'utf8'));
  const st = opts.statImpl ?? ((p: string) => stat(p));
  const each = opts.maxBytes ?? MENTION_MAX_BYTES;
  const total = opts.totalBytes ?? MENTION_TOTAL_BYTES;

  const out: MentionRead[] = [];
  let used = 0;
  for (const at of mentionsIn(text)) {
    const full = isAbsolute(at) ? resolve(at) : resolve(join(root, at));
    const rel = relative(resolve(root), full);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      out.push({ path: at, ok: false, body: '作業場の外なので読みません' });
      continue;
    }
    try {
      const info = await st(full);
      if (info.isDirectory()) {
        out.push({ path: at, ok: false, body: 'フォルダです。中のファイルを指名してください' });
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
      out.push({ path: rel.split(sep).join('/'), ok: true, body: shown, truncated: cut });
    } catch (e) {
      out.push({ path: at, ok: false, body: (e as Error).message });
    }
  }
  return out;
}

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
  const reads = await readMentions(text, root, opts);
  if (reads.length === 0) return { text, reads };
  return { text: `${mentionBlock(reads)}\n\n${stripMentions(text)}`, reads };
}
