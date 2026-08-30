/**
 * zip を開く。外部の道具に頼らない。
 *
 * 実行時の依存はゼロという前提があるので、ライブラリは足さない。
 * `unzip` や `tar` を呼ぶ手もあるが、環境によって有無も方言も違う
 * （GNU tar は zip を開けない、Windows の Expand-Archive は遅い）。
 * **開けるかどうかが環境依存になる**のは、この道具にとって致命的なので、
 * 自前で読む。Node の zlib だけで足りる。
 *
 * 実装しているのは zip の基本形だけ。
 *   ・格納方式は 0（無圧縮）と 8（deflate）
 *   ・zip64、暗号化、分割は扱わない
 * llama.cpp の配布物はこれで開ける。開けないものは、開けないと言う。
 */
import { inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  /** zip の中での場所。区切りは常に / */
  path: string;
  data: Buffer;
  /** 実行できるファイルか（Unix の許可属性から見る） */
  executable: boolean;
}

/** 中央ディレクトリの目印 */
const END_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;

export function unzip(buf: Buffer): ZipEntry[] {
  const end = findEnd(buf);
  if (end < 0) throw new Error('zip として読めません（末尾の目印が見つかりません）');

  const count = buf.readUInt16LE(end + 10);
  const centralOffset = buf.readUInt32LE(end + 16);
  if (centralOffset === 0xffffffff) throw new Error('zip64 には対応していません');

  const entries: ZipEntry[] = [];
  let p = centralOffset;

  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(p) !== CENTRAL_SIG) throw new Error('zip の目録が壊れています');

    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const externalAttrs = buf.readUInt32LE(p + 38);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');

    p += 46 + nameLen + extraLen + commentLen;

    // ディレクトリそのものは作らない。中身を書くときに親ごと作る。
    if (name.endsWith('/')) continue;

    // 本体の頭。ここの名前と追加領域の長さは、目録側と違うことがある。
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compressedSize);

    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw);
    else throw new Error(`未対応の格納方式です: ${method}（${name}）`);

    // 上位16ビットが Unix の許可属性。実行ビットが立っていれば実行できる。
    const unixMode = externalAttrs >>> 16;
    entries.push({ path: name, data, executable: (unixMode & 0o111) !== 0 });
  }

  return entries;
}

/**
 * 末尾の目印を探す。
 * 注記が付いていると末尾ちょうどには無いので、後ろから舐める。
 */
function findEnd(buf: Buffer): number {
  const min = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === END_SIG) return i;
  }
  return -1;
}
