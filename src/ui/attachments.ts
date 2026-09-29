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

/**
 * 中身を差し込んでよい大きさ。**窓が分からないときの受け皿**として残す。
 *
 * 固定の値しか無かったので、窓 4096 の相手に 40,052 文字を渡していた
 * （実測。日本語は概ね 1文字 1トークンなので、窓のおよそ 10 倍）。
 * 5 件付けると 200,268 文字、49 倍。添付は依頼の一部なので**刈る側は
 * 落とせない**。指名（`@道`）は窓から決める形に直してあったのに、
 * 添付だけ取り残されていた。
 */
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

  /*
   * UTF-16 の BOM で始まるものは文字もの（NUL を含むが、二進ではない）。ただし BOM だけで決めない
   * （UTF-32LE や音声も FF FE で始まる）。厳密に読めて、読んだ中に NUL が無いときだけ。
   */
  if (data.length >= 2 && ((data[0] === 0xff && data[1] === 0xfe) || (data[0] === 0xfe && data[1] === 0xff))) {
    const head = data.subarray(0, 4096 - (4096 % 2));
    const r = decodeText(head.length % 2 === 0 ? head : head.subarray(0, head.length - 1));
    if (!r.lossy && !r.text.includes('\0')) return 'text';
  }
  const head = data.subarray(0, 4096);
  if (head.includes(0)) return 'binary';

  // 読めない字が多ければ、文字ものとは言わない。
  // ただし UTF-8 で読めないだけなら CP932 を試す。Excel の CSV がそれ。
  const { text, lossy } = decodeText(head);
  if (!lossy) return 'text';
  const broken = (text.match(/�/g) ?? []).length;
  return broken > head.length / 100 ? 'binary' : 'text';
}

/** 名前の長さの上限（UTF-8 のバイト数）。前に付く `id-` を足しても 255 バイトに収まるように。 */
const NAME_MAX_BYTES = 200;
/** 字の数の上限。Windows の道の長さ（260 字）に当たりにくくする（保存先のフォルダだけで 80 字ほどある）。 */
const NAME_MAX_CHARS = 120;
/** 二重の拡張子。切っても残す。 */
const DOUBLE_EXT = /\.(tar\.(gz|bz2|xz|zst)|d\.ts)$/i;

/**
 * 名前を安全にする。渡された名前を、そのまま置き場所に使わない。
 *
 * 長さは UTF-8 のバイトで数える（Linux・macOS の上限は 255 バイト。全角は一字 3 バイトなので、字の数で 120 に
 * 切っても受け取れなかった）。切るのは本体だけで、拡張子は残す（落とすと絵を読めない形式と取り違える）。
 * 字の単位で切る（絵文字を半分に割らない）。
 */
export function safeName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file';
  // 制御文字と、Windows で使えない字を落とす。末尾の点と空白は Windows が保存時に落とすので、先に外す。
  const cleaned = base.replace(/[\x00-\x1f<>:"|?*]/g, '_').replace(/^\.+/, '').replace(/[. ]+$/, '');
  if (cleaned.length === 0) return 'file';
  const double = DOUBLE_EXT.exec(cleaned);
  const dot = double ? double.index : cleaned.lastIndexOf('.');
  const ext = dot > 0 && cleaned.length - dot <= 16 ? cleaned.slice(dot) : '';
  const chars = Array.from(ext ? cleaned.slice(0, dot) : cleaned);
  const extChars = Array.from(ext).length;
  while (chars.length > 1
    && (Buffer.byteLength(chars.join('') + ext) > NAME_MAX_BYTES || chars.length + extChars > NAME_MAX_CHARS)) chars.pop();
  // 切った位置が点や空白なら、それも外す（Windows が保存時に落とす）。
  const body = chars.join('').replace(/[. ]+$/, '');
  return body.length > 0 ? body + ext : `file${ext}`;
}

export class Attachments {
  readonly #dir: string;
  readonly #items = new Map<string, Attachment>();
  readonly #id: () => string;
  readonly #remove: (path: string) => Promise<void>;
  readonly #read: (path: string) => Promise<Buffer>;

  constructor(
    dir = join(stateDir(), 'attachments'),
    /** `remove`・`read` は試験で入れ替える（消せない・読めない形を、ファイルシステムの種類に頼らずに作るため）。 */
    opts: { id?: () => string; remove?: (path: string) => Promise<void>; read?: (path: string) => Promise<Buffer> } = {},
  ) {
    this.#dir = dir;
    this.#remove = opts.remove ?? ((path) => rm(path));
    this.#read = opts.read ?? ((path) => readFile(path));
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

  /**
   * 外す。`dropped` は預かっていたか。預かりからは外れても、コピーを消せなかったときは `kept` にその理由が入る
   * （掴まれている等。一日経ったものは立ち上げたときの片づけで消える）。預けたものを消したつもりで残さない。
   */
  async drop(id: string): Promise<{ dropped: boolean; kept?: string }> {
    const item = this.#items.get(id);
    if (!item) return { dropped: false };
    this.#items.delete(id);
    // もう無いなら、それでよい（force）
    // 画面に出すのは符丁（EBUSY 等）だけ。rm の文はフルパス入りの長い英文になる
    const failed = await rm(item.path, { force: true }).then(() => undefined, (e: unknown) => (e as NodeJS.ErrnoException).code ?? (e as Error).message);
    return failed === undefined ? { dropped: true } : { dropped: true, kept: failed };
  }

  /**
   * 依頼に添える形にする。
   *
   * 文字ものは中身をそのまま。絵とその他は、在ることと場所だけ。
   * **読めないものの中身を渡さない。** 場所を食うだけで、何の助けにもならない。
   */
  async describe(
    ids: string[],
    opts: { canSeeImages?: boolean; chars?: { each: number; total: number } } = {},
  ): Promise<string> {
    const each = opts.chars?.each ?? MAX_INLINE_CHARS;
    const total = opts.chars?.total ?? Number.MAX_SAFE_INTEGER;
    let used = 0;
    const parts: string[] = [];
    // **入らなかったものを黙らせない。**添えたのに無視されたように見える。
    let leftOut = 0;
    for (const id of ids) {
      const item = this.#items.get(id);
      if (!item) continue;
      if (used >= total) { leftOut += 1; continue; }

      if (item.kind === 'text') {
        const got = await this.#read(item.path).then((b) => ({ b }), (e: NodeJS.ErrnoException) => ({ code: e.code ?? 'error' }));
        // 読めなければ、空の中身で渡さない（渡したのに無視されたように見える）。「消えて」は無いときだけ言う。
        if (!('b' in got)) {
          parts.push(`--- 添付: ${item.name}（${got.code === 'ENOENT' ? '保存先から消えていて読めません' : `読めません（${got.code}）`}）---`);
          used = parts.join('\n\n').length;
          continue;
        }
        const bytes = got.b;
        const { text: raw, encoding } = decodeText(bytes);
        // CP932 として読んだなら、そう言う。黙って直すと、書き戻すときに困る。
        const how = encoding === 'shift_jis' ? '（CP932 として読みました）'
          : encoding === 'utf-16le' || encoding === 'utf-16be' ? '（UTF-16 として読みました）' : '';
        // 囲みの分も窓を食う。**中身だけ数えて収まったつもりにならない。**
        const frame = `--- 添付: ${item.name}${how} ---\n\n--- ここまで ---\n\n`.length;
        // **一つで全部を使い切らせない。**複数付けたときに、後ろが空になる。
        const room = Math.max(0, Math.min(each, total - used - frame));
        const body = raw.length > room
          ? `${raw.slice(0, room)}\n…（以降 ${raw.length - room} 文字は省略。窓に収まらないので切りました）`
          : raw;
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
      used = parts.join('\n\n').length;
    }
    if (leftOut > 0) {
      parts.push(`--- 添付 ${leftOut} 件は、窓に収まらないので入れていません ---`);
    }
    return parts.join('\n\n');
  }

  /** 溜まったものを片づける。渡したものは、その依頼が終われば要らない。 */
  async sweep(olderThanMs = 24 * 60 * 60 * 1000, now = Date.now()): Promise<number> {
    let freed = 0;
    for (const name of await readdir(this.#dir).catch(() => [])) {
      const path = join(this.#dir, name);
      const s = await stat(path).catch(() => undefined);
      // 預かりはファイルだけ。フォルダ等は触らない（消せないのに数えていた）。
      if (!s || !s.isFile() || now - s.mtimeMs < olderThanMs) continue;
      // 消せた分だけ数える（「消した量を必ず言う」の量を嘘にしない）。使用中なら次回。
      const removed = await this.#remove(path).then(() => true, () => false);
      if (!removed) continue;
      freed += s.size;
      for (const [id, item] of this.#items) if (item.path === path) this.#items.delete(id);
    }
    return freed;
  }
}
