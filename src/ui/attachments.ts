/**
 * 渡されたファイルを預かる。
 *
 * 画面に落とす、貼り付ける、選ぶ —— どれで渡されても同じ場所に置き、
 * 依頼に添えて渡せる形にする。
 *
 * 中身の扱いは種類で変える。
 *
 *   文字もの   そのまま依頼に差し込む。コードやログはこれが要る
 *   絵         置いておいて、読めるモデルのときだけ渡す
 *   その他     置くだけ。中身は差し込まない（読めないものを渡しても場所を食うだけ）
 *
 * **利用者が渡したものは検問所に通さない。** 外から取ってきたものとは違い、
 * 渡した本人が中身を知っている。ここで当てはめを効かせると、
 * 「これまでの指示は無視して」を含む試験用のファイルすら添付できなくなる。
 */
import { mkdir, writeFile, readFile, readdir, stat, rm } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stateDir } from '../core/home.ts';
import { decodeText, type TextEncodingName } from '../core/text.ts';

export type AttachmentKind = 'text' | 'image' | 'binary';

export interface Attachment {
  id: string;
  name: string;
  bytes: number;
  kind: AttachmentKind;
  /** 置いた場所 */
  path: string;
  at: number;
  /** 文字ものの読み方。CP932 のときに、そう読んだと分かるように残す。 */
  encoding?: TextEncodingName;
}

/** 中身を差し込んでよい大きさ。これを超えたら頭だけ入れる。 */
export const MAX_INLINE_CHARS = 40_000;
/** 1つあたりの上限。これより大きいものは受け取らない。 */
export const MAX_BYTES = 25 * 1024 * 1024;

const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift',
  '.c', '.h', '.cpp', '.hpp', '.cs', '.php', '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd',
  '.html', '.htm', '.css', '.scss', '.sql', '.csv', '.tsv', '.log', '.diff', '.patch', '.env',
  '.gitignore', '.gitattributes', '.editorconfig', '.dockerfile',
]);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.avif']);

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

/**
 * 種類を見分ける。
 *
 * 拡張子だけでは足りない（拡張子の無いファイルは多い）ので、**中身も見る**。
 * 先頭に 0 バイトが混ざっていれば、それは文字ものではない。
 */
export function detectKind(name: string, data: Buffer): AttachmentKind {
  const ext = extname(name).toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (TEXT_EXT.has(ext)) return 'text';

  // 絵の合図は、拡張子ではなく中身で見る。
  if (data.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) return 'image';
  if (data.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC)) return 'image';

  const head = data.subarray(0, 4096);
  if (head.includes(0)) return 'binary';

  // 読めない字が多ければ、文字ものとは言わない。
  // ただし UTF-8 で読めないだけなら CP932 を試す。Excel の CSV がそれ。
  const { text, lossy } = decodeText(head);
  if (!lossy) return 'text';
  const broken = (text.match(/�/g) ?? []).length;
  return broken > head.length / 100 ? 'binary' : 'text';
}

/** 名前を安全にする。渡された名前を、そのまま置き場所に使わない。 */
export function safeName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file';
  // 制御文字と、Windows で使えない字を落とす。
  const cleaned = base.replace(/[\x00-\x1f<>:"|?*]/g, '_').replace(/^\.+/, '').slice(0, 120);
  return cleaned.length > 0 ? cleaned : 'file';
}

export class Attachments {
  readonly #dir: string;
  readonly #items = new Map<string, Attachment>();
  readonly #id: () => string;

  constructor(dir = join(stateDir(), 'attachments'), opts: { id?: () => string } = {}) {
    this.#dir = dir;
    // 名前の作り手を差し替えられるようにしてあるのは、**ぶつかったときに
    // どうなるかを検査で見るため**。ぶつからないことを祈る検査は書けない。
    this.#id = opts.id ?? (() => randomUUID().slice(0, 8));
  }

  get dir(): string { return this.#dir; }

  async add(name: string, data: Buffer): Promise<Attachment> {
    if (data.length === 0) throw new Error('中身が空です');
    if (data.length > MAX_BYTES) {
      throw new Error(
        `大きすぎます（${Math.round(data.length / 1024 / 1024)}MB）。`
        + `${MAX_BYTES / 1024 / 1024}MB までです`,
      );
    }
    await mkdir(this.#dir, { recursive: true });
    // 8桁に切り詰めているので、ぶつかりうる。ぶつかったまま入れると、
    // **先にあった添付が地図から消え、ファイルだけが残る**。空くまで引き直す。
    let id = this.#id();
    for (let tries = 0; this.#items.has(id); tries += 1) {
      if (tries > 100) throw new Error('添付の名前が決まりません');
      id = this.#id();
    }
    const clean = safeName(name);
    const path = join(this.#dir, `${id}-${clean}`);
    await writeFile(path, data);

    const kind = detectKind(clean, data);
    const item: Attachment = {
      id, name: clean, bytes: data.length, kind, path, at: Date.now(),
      ...(kind === 'text' ? { encoding: decodeText(data).encoding } : {}),
    };
    this.#items.set(id, item);
    return item;
  }

  get(id: string): Attachment | undefined { return this.#items.get(id); }
  list(): Attachment[] { return [...this.#items.values()].sort((a, b) => a.at - b.at); }

  async drop(id: string): Promise<boolean> {
    const item = this.#items.get(id);
    if (!item) return false;
    this.#items.delete(id);
    await rm(item.path, { force: true }).catch(() => { /* もう無いなら、それでよい */ });
    return true;
  }

  /**
   * 依頼に添える形にする。
   *
   * 文字ものは中身をそのまま。絵とその他は、在ることと場所だけ。
   * **読めないものの中身を渡さない。** 場所を食うだけで、何の助けにもならない。
   */
  async describe(ids: string[], opts: { canSeeImages?: boolean } = {}): Promise<string> {
    const parts: string[] = [];
    for (const id of ids) {
      const item = this.#items.get(id);
      if (!item) continue;

      if (item.kind === 'text') {
        const bytes = await readFile(item.path).catch(() => Buffer.alloc(0));
        const { text: raw, encoding } = decodeText(bytes);
        const body = raw.length > MAX_INLINE_CHARS
          ? `${raw.slice(0, MAX_INLINE_CHARS)}\n…（以降 ${raw.length - MAX_INLINE_CHARS} 文字は省略）`
          : raw;
        // CP932 として読んだなら、そう言う。黙って直すと、書き戻すときに困る。
        const how = encoding === 'shift_jis' ? '（CP932 として読みました）' : '';
        parts.push(`--- 添付: ${item.name}${how} ---\n${body}\n--- ここまで ---`);
      } else if (item.kind === 'image') {
        parts.push(opts.canSeeImages
          ? `--- 添付（画像）: ${item.name} — ${item.path} ---`
          : `--- 添付（画像）: ${item.name} ---\n`
            + `いまのモデルは画像を読めません。置き場所: ${item.path}\n`
            + '画像の中身が要るなら、見えるモデルに切り替えるか、文字で説明してください。');
      } else {
        parts.push(
          `--- 添付（中身を読めない形式）: ${item.name}（${item.bytes} バイト）---\n`
          + `置き場所: ${item.path}`,
        );
      }
    }
    return parts.join('\n\n');
  }

  /** 溜まったものを片づける。渡したものは、その依頼が終われば要らない。 */
  async sweep(olderThanMs = 24 * 60 * 60 * 1000, now = Date.now()): Promise<number> {
    let freed = 0;
    for (const name of await readdir(this.#dir).catch(() => [])) {
      const path = join(this.#dir, name);
      const s = await stat(path).catch(() => undefined);
      if (!s || now - s.mtimeMs < olderThanMs) continue;
      freed += s.size;
      await rm(path, { force: true }).catch(() => { /* 使用中なら次回 */ });
      for (const [id, item] of this.#items) if (item.path === path) this.#items.delete(id);
    }
    return freed;
  }
}
