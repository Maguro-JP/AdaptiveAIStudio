/**
 * GGUF を直接読む。
 *
 * これまでモデルの諸元は、名前からの推測か Ollama の申告に頼っていた。
 * 「32B と名前に入っているから 32B だろう」は、当たることも外れることもある。
 * 外れたまま「載る／載らない」を計算しても意味がない。
 *
 * ファイルの先頭には、層数も、ヘッド数も、文脈長も、
 * テンソルごとの実バイト数まで書いてある。読めば済む話だった。
 *
 * ------------------------------------------------------------------
 * 設計上、いちばん大事にしたこと: **分からないものを埋めない**
 *
 * この読み取りは仕様の理解に依っている。理解が一つ違えば値が狂う。
 * 狂った値を自信たっぷりに返すと、その先の計算が全部狂う。
 * だから知らない型に出会ったらその項目だけ捨て、
 * 必要な値が欠けたら「分からない」と返す。
 * 推測で埋めた数字より、空欄の方が安全。
 * ------------------------------------------------------------------
 */
import { open } from 'node:fs/promises';
import { basename } from 'node:path';

/** メタデータの値の型。仕様に沿った並び。 */
const ValueType = {
  UINT8: 0, INT8: 1, UINT16: 2, INT16: 3,
  UINT32: 4, INT32: 5, FLOAT32: 6, BOOL: 7,
  STRING: 8, ARRAY: 9, UINT64: 10, INT64: 11, FLOAT64: 12,
} as const;

export type GgufValue = number | bigint | boolean | string | GgufValue[];

export interface GgufTensor {
  name: string;
  dims: number[];
  /** 量子化形式の番号。名前が分かるものは quantName で引ける。 */
  typeId: number;
  offset: number;
  /** 要素数。dims の積。 */
  elements: number;
}

export interface GgufFile {
  path: string;
  version: number;
  metadata: Map<string, GgufValue>;
  tensors: GgufTensor[];
  /** ファイル全体のバイト数 */
  fileBytes: number;
  /** 読み取れなかったところ。黙って捨てない。 */
  warnings: string[];
}

/**
 * 量子化形式の番号 → 名前。
 * ここに無い番号は「分からない」として扱う。埋めない。
 */
export const GGML_TYPE_NAMES: Record<number, string> = {
  0: 'F32', 1: 'F16', 2: 'Q4_0', 3: 'Q4_1',
  6: 'Q5_0', 7: 'Q5_1', 8: 'Q8_0', 9: 'Q8_1',
  10: 'Q2_K', 11: 'Q3_K', 12: 'Q4_K', 13: 'Q5_K', 14: 'Q6_K', 15: 'Q8_K',
  16: 'IQ2_XXS', 17: 'IQ2_XS', 18: 'IQ3_XXS', 19: 'IQ1_S', 20: 'IQ4_NL',
  21: 'IQ3_S', 22: 'IQ2_S', 23: 'IQ4_XS',
  24: 'I8', 25: 'I16', 26: 'I32', 27: 'I64', 28: 'F64', 29: 'IQ1_M',
  30: 'BF16',
};

export function quantName(typeId: number): string | undefined {
  return GGML_TYPE_NAMES[typeId];
}

/** 先頭だけ読めば済む。全部読むと数GBを抱えることになる。 */
const DEFAULT_HEAD_BYTES = 16 * 1024 * 1024;

class Reader {
  #view: DataView;
  #bytes: Uint8Array;
  #pos = 0;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get pos(): number { return this.#pos; }

  /** 足りないまま読み進めない。切れているなら、そう言って止まる。 */
  #need(n: number): void {
    if (this.#pos + n > this.#bytes.byteLength) {
      throw new TruncatedError(`ファイルの先頭が足りません（${this.#pos + n} バイト目まで必要）`);
    }
  }

  u8(): number { this.#need(1); return this.#view.getUint8(this.#pos++); }
  i8(): number { this.#need(1); return this.#view.getInt8(this.#pos++); }
  u16(): number { this.#need(2); const v = this.#view.getUint16(this.#pos, true); this.#pos += 2; return v; }
  i16(): number { this.#need(2); const v = this.#view.getInt16(this.#pos, true); this.#pos += 2; return v; }
  u32(): number { this.#need(4); const v = this.#view.getUint32(this.#pos, true); this.#pos += 4; return v; }
  i32(): number { this.#need(4); const v = this.#view.getInt32(this.#pos, true); this.#pos += 4; return v; }
  f32(): number { this.#need(4); const v = this.#view.getFloat32(this.#pos, true); this.#pos += 4; return v; }
  f64(): number { this.#need(8); const v = this.#view.getFloat64(this.#pos, true); this.#pos += 8; return v; }
  u64(): bigint { this.#need(8); const v = this.#view.getBigUint64(this.#pos, true); this.#pos += 8; return v; }
  i64(): bigint { this.#need(8); const v = this.#view.getBigInt64(this.#pos, true); this.#pos += 8; return v; }

  /** 個数は 64bit で書かれているが、実際には配列長に使う。安全な範囲だけ通す。 */
  count(what: string): number {
    const raw = this.u64();
    if (raw > 100_000_000n) {
      throw new BadFormatError(`${what} の数が異常です: ${raw}`);
    }
    return Number(raw);
  }

  str(): string {
    const len = this.count('文字列の長さ');
    this.#need(len);
    const bytes = this.#bytes.subarray(this.#pos, this.#pos + len);
    this.#pos += len;
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }

  skip(n: number): void { this.#need(n); this.#pos += n; }
}

export class TruncatedError extends Error {}
export class BadFormatError extends Error {}

function readValue(r: Reader, type: number, depth = 0): GgufValue {
  switch (type) {
    case ValueType.UINT8: return r.u8();
    case ValueType.INT8: return r.i8();
    case ValueType.UINT16: return r.u16();
    case ValueType.INT16: return r.i16();
    case ValueType.UINT32: return r.u32();
    case ValueType.INT32: return r.i32();
    case ValueType.FLOAT32: return r.f32();
    case ValueType.BOOL: return r.u8() !== 0;
    case ValueType.STRING: return r.str();
    case ValueType.UINT64: return r.u64();
    case ValueType.INT64: return r.i64();
    case ValueType.FLOAT64: return r.f64();
    case ValueType.ARRAY: {
      // 入れ子の配列は仕様上あり得るが、深すぎるものは読まない。
      if (depth > 4) throw new BadFormatError('配列の入れ子が深すぎます');
      const elemType = r.u32();
      const n = r.count('配列の要素数');
      const out: GgufValue[] = [];
      for (let i = 0; i < n; i += 1) out.push(readValue(r, elemType, depth + 1));
      return out;
    }
    default:
      // 知らない型。ここから先はどこまで読めばいいか分からないので、進めない。
      throw new BadFormatError(`知らない値の型です: ${type}`);
  }
}

export interface ReadOptions {
  /** 先頭から何バイト読むか。テンソルが多いモデルでは増やす。 */
  headBytes?: number;
}

/**
 * ファイルの先頭を読んで、書いてあることだけを返す。
 * 解釈はここではしない。解釈は toModelSpec の仕事。
 */
export async function readGguf(path: string, opts: ReadOptions = {}): Promise<GgufFile> {
  const handle = await open(path, 'r');
  let bytes: Uint8Array;
  let fileBytes: number;
  try {
    const stat = await handle.stat();
    fileBytes = stat.size;
    const want = Math.min(opts.headBytes ?? DEFAULT_HEAD_BYTES, fileBytes);
    const buf = new Uint8Array(want);
    await handle.read(buf, 0, want, 0);
    bytes = buf;
  } finally {
    await handle.close();
  }

  const r = new Reader(bytes);
  const warnings: string[] = [];

  const magic = r.u32();
  // 'G','G','U','F' を little-endian で読んだ値
  if (magic !== 0x46554747) {
    throw new BadFormatError(`GGUF ではありません（先頭が ${magic.toString(16)}）`);
  }

  const version = r.u32();
  if (version < 2 || version > 3) {
    // 読める形なら読む。版が違うだけで諦めない。
    warnings.push(`知らない版です: ${version}。読めるところまで読みます。`);
  }

  const tensorCount = r.count('テンソル数');
  const kvCount = r.count('メタデータ数');

  const metadata = new Map<string, GgufValue>();
  for (let i = 0; i < kvCount; i += 1) {
    let key: string;
    try {
      key = r.str();
    } catch (e) {
      warnings.push(`メタデータ ${i + 1} 件目の名前を読めませんでした: ${(e as Error).message}`);
      break;
    }
    try {
      // 値の型の 4 バイトも、名前・値と同じく読める所までで打ち切る（読む先頭の境目がここに落ちると、外へ投げて GGUF ごと読めない扱いになっていた）
      const type = r.u32();
      metadata.set(key, readValue(r, type));
    } catch (e) {
      // 一つ読めないと、その先の位置が分からなくなる。ここで打ち切る。
      warnings.push(`${key} を読めなかったので、メタデータはここまでです: ${(e as Error).message}`);
      break;
    }
  }

  const tensors: GgufTensor[] = [];
  if (metadata.size === kvCount) {
    for (let i = 0; i < tensorCount; i += 1) {
      try {
        const name = r.str();
        const nDims = r.u32();
        if (nDims > 8) throw new BadFormatError(`次元数が異常です: ${nDims}`);
        const dims: number[] = [];
        for (let d = 0; d < nDims; d += 1) dims.push(r.count('次元'));
        const typeId = r.u32();
        const offset = Number(r.u64());
        tensors.push({
          name, dims, typeId, offset,
          elements: dims.reduce((a, b) => a * b, 1),
        });
      } catch (e) {
        // 先頭しか読んでいないので、途中で切れるのは想定内。
        if (e instanceof TruncatedError) {
          warnings.push(`テンソル一覧は ${tensors.length}/${tensorCount} 件まで読めました（先頭のみ読んでいるため）。`);
        } else {
          warnings.push(`テンソル一覧を読めませんでした: ${(e as Error).message}`);
        }
        break;
      }
    }
  }

  return { path, version, metadata, tensors, fileBytes, warnings };
}
