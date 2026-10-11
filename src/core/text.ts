/**
 * 届いた塊を、文字に直す。
 *
 * **塊ごとに `toString()` しない。**日本語は1文字3バイト。届く塊の
 * 切れ目は都合を見てくれないので、文字の途中で切れると、そこで化ける。
 * 長いものを受け取ったときだけ起きるので、短い試しでは気づけない。
 * 実際に MCP の口で起きていた（`docs/DECISIONS.md`）。
 *
 * またぐ分を持ち越す読み手を、一つずつ作って使う。
 * **使い回さない。**持ち越しは相手ごとに別のもの。
 */
import { StringDecoder } from 'node:string_decoder';

/** 一つの流れ用の読み手。Buffer でも文字列でも受ける。 */
export function chunkReader(): (chunk: Buffer | string) => string {
  const decoder = new StringDecoder('utf8');
  return (chunk) => (typeof chunk === 'string' ? chunk : decoder.write(chunk));
}

/**
 * 行が揃うまで持ち越す読み手。
 *
 * 塊の切れ目は行の切れ目でもない。塊ごとに `split('\n')` すると、
 * **一行が二行に割れて**流れに出る。文字の化けと同じで、長いものを
 * 受け取ったときだけ起きる。
 *
 * 残りは `flush()` で取り出す（最後の行が改行で終わらないことがある）。
 */
export function lineReader(): { push: (chunk: Buffer | string) => string[]; flush: () => string[] } {
  const read = chunkReader();
  let rest = '';
  return {
    push(chunk) {
      rest += read(chunk);
      const lines = rest.split('\n');
      rest = lines.pop() ?? '';
      return lines;
    },
    flush() {
      const last = rest;
      rest = '';
      return last ? [last] : [];
    },
  };
}

export type TextEncodingName = 'utf-8' | 'shift_jis' | 'utf-16le' | 'utf-16be';

/**
 * ファイルの中身を文字にする。UTF-8 でなければ CP932 も試す。
 *
 * この場所の利用者は日本語の Windows で使う。Excel が書いた CSV、
 * 昔からのメモ帳、cmd の記録は **CP932** で来る。UTF-8 と決めつけて
 * 読むと `�` の山になり、しかも「読めない形式」と誤って弾いていた。
 * 渡したのに無視されたように見えるのが、いちばん困る。
 *
 * 順番: UTF-8（厳密） → CP932（厳密） → UTF-8（化けを許す）。
 * 当てずっぽうで CP932 にはしない。UTF-8 として通るものは UTF-8。
 */
/**
 * 上限で切った頭の、末尾で途中になった UTF-8 の字を落とす。字の途中で切ると、厳密な UTF-8 の読みが落ちて CP932 と取り違える
 * （`@` の指名と `fetch_url` で同じ形を踏んだ）。末尾が字の途中でなければ、そのまま返す。
 */
export function trimPartialUtf8(buf: Uint8Array): Uint8Array {
  const end = buf.length;
  let i = end - 1;
  // 続きの字（10xxxxxx）を遡って、字の頭を探す（長くて 4 バイト）
  while (i >= 0 && i > end - 4 && (buf[i]! & 0xc0) === 0x80) i -= 1;
  if (i < 0) return buf;
  const lead = buf[i]!;
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return end - i < need ? buf.subarray(0, i) : buf;
}

/** CP932 の 2 バイトの字の先行バイト（0x81–0x9F・0xE0–0xFC）。 */
function isSjisLead(b: number): boolean {
  return (b >= 0x81 && b <= 0x9f) || (b >= 0xe0 && b <= 0xfc);
}

/** 末尾で途中になった CP932 の字を落とす。頭から字の区切りを数えて、最後の字が 1 バイト足りなければ落とす。 */
export function trimPartialSjis(buf: Uint8Array): Uint8Array {
  let i = 0;
  while (i < buf.length) i += isSjisLead(buf[i]!) ? 2 : 1;
  return i > buf.length ? buf.subarray(0, buf.length - 1) : buf;
}

function decodesStrictly(label: string, buf: Uint8Array): boolean {
  try { new TextDecoder(label, { fatal: true }).decode(buf); return true; } catch { return false; }
}

/**
 * 上限で切った頭の、末尾で途中になった字を落とす。UTF-8 として読めるならその途中の字を、
 * 読めず CP932 として読めるならその途中の字を落とす。どちらでもなければ UTF-8 の分だけ落とす。
 */
export function trimPartialText(buf: Uint8Array): Uint8Array {
  const utf8 = trimPartialUtf8(buf);
  if (decodesStrictly('utf-8', utf8)) return utf8;
  const sjis = trimPartialSjis(buf);
  try { if (decodesStrictly('shift_jis', sjis)) return sjis; } catch { /* shift_jis を読めない Node */ }
  return utf8;
}

export function decodeText(
  data: Buffer,
  /**
   * UTF-16 の BOM を見るか。シェルの出力は stdout と stderr を届いた順につないでいるので、UTF-16 で読むと
   * 後ろの utf8 の stderr まで化ける。そこでは見ない（`shell-exec.ts` の `decodeOutput`）。
   */
  opts: { utf16?: boolean } = {},
): { text: string; encoding: TextEncodingName; lossy: boolean } {
  // UTF-16 の BOM を先に見る（メモ帳の「Unicode」、Windows PowerShell 5.1 の `>` の出力）。BOM は落とす。
  // 厳密に読めなければ、化けを許して読み、そう言う（長さが奇数・片割れの字）。
  if (opts.utf16 !== false && data.length >= 2) {
    const label = data[0] === 0xff && data[1] === 0xfe ? 'utf-16le' : data[0] === 0xfe && data[1] === 0xff ? 'utf-16be' : undefined;
    if (label) {
      try {
        return { text: new TextDecoder(label, { fatal: true }).decode(data), encoding: label, lossy: false };
      } catch {
        return { text: new TextDecoder(label).decode(data), encoding: label, lossy: true };
      }
    }
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(data), encoding: 'utf-8', lossy: false };
  } catch { /* UTF-8 ではない */ }
  try {
    return { text: new TextDecoder('shift_jis', { fatal: true }).decode(data), encoding: 'shift_jis', lossy: false };
  } catch { /* CP932 でもない */ }
  return { text: new TextDecoder('utf-8').decode(data), encoding: 'utf-8', lossy: true };
}
