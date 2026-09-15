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

export type TextEncodingName = 'utf-8' | 'shift_jis';

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
export function decodeText(data: Buffer): { text: string; encoding: TextEncodingName; lossy: boolean } {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(data), encoding: 'utf-8', lossy: false };
  } catch { /* UTF-8 ではない */ }
  try {
    return { text: new TextDecoder('shift_jis', { fatal: true }).decode(data), encoding: 'shift_jis', lossy: false };
  } catch { /* CP932 でもない */ }
  return { text: new TextDecoder('utf-8').decode(data), encoding: 'utf-8', lossy: true };
}
