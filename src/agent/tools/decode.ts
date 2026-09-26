/**
 * ファイルを、モデルへ渡す文字として読む（read_file・search_text・`@` の指名で共通）。
 *
 * utf8 で読めないものを丸ごと断ると、Shift_JIS の .bat や、Latin-1 の字が一つ混ざった古いソースが
 * 一行も見えなくなる。そのファイルを直す道は write_file の全文の置き換えしか無いので、中身を知らない
 * まま全文を書かせることになる。読めるものは読んで、どう読んだかを添える。
 *
 * - utf8 として読める: そのまま（BOM も残す。「戻す」と同じ `contentOf`）
 * - UTF-16 の BOM で始まる: その文字コードで読む（Windows PowerShell 5.1 の `>` の既定）
 * - NUL を含む: 二進。中身は渡さない
 * - 読めないバイトが少しだけ: utf8 として読み、読めない字は置き換える（途中で切れたログ、Latin-1 の字が一つ）
 * - Shift_JIS として厳密に読める: Shift_JIS で読む
 * - どれでもない: utf8 として読み、読めない字は置き換える
 */
import { contentOf } from '../../harness/put-back.ts';

export type Decoded =
  | { kind: 'text'; text: string; encoding: 'utf-8' }
  | { kind: 'text'; text: string; encoding: 'utf-16le' | 'utf-16be' | 'shift_jis' | 'utf-8-lossy'; note: string }
  | { kind: 'binary'; bytes: number };

/** これより多く読めないバイトがあれば、utf8 の傷ではなく別の文字コードとみなして Shift_JIS を試す。 */
const FEW_BAD = 2;

const REPLACEMENT = '�';

function count(text: string, ch: string): number {
  let n = 0;
  for (const c of text) if (c === ch) n += 1;
  return n;
}

const HOW_TO_EDIT = 'utf8 ではないので edit_file では直せません。直すなら write_file で utf8 の全文に書き直してください';

export function decodeForReading(bytes: Buffer): Decoded {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { kind: 'text', text: new TextDecoder('utf-16le').decode(bytes), encoding: 'utf-16le', note: `（UTF-16LE として読みました。${HOW_TO_EDIT}）` };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { kind: 'text', text: new TextDecoder('utf-16be').decode(bytes), encoding: 'utf-16be', note: `（UTF-16BE として読みました。${HOW_TO_EDIT}）` };
  }
  const exact = contentOf(bytes);
  if (typeof exact === 'string') return { kind: 'text', text: exact, encoding: 'utf-8' };
  if (bytes.includes(0)) return { kind: 'binary', bytes: bytes.length };

  const lossy = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
  const bad = count(lossy, REPLACEMENT);
  const lossyNote = (n: number): Decoded => ({
    kind: 'text', text: lossy, encoding: 'utf-8-lossy',
    note: `（utf8 として読めないバイトが ${n} か所あり、そこは置き換えの字にしています。${HOW_TO_EDIT}）`,
  });
  if (bad <= FEW_BAD) return lossyNote(bad);
  try {
    // 同梱の Node が Shift_JIS を持たない（small-icu）ときは、ここで RangeError になる。
    const sjis = new TextDecoder('shift_jis', { fatal: true }).decode(bytes);
    return { kind: 'text', text: sjis, encoding: 'shift_jis', note: `（Shift_JIS として読みました。${HOW_TO_EDIT}）` };
  } catch {
    return lossyNote(bad);
  }
}

/**
 * この Node で Shift_JIS を読めるか。同梱の Node が small-icu で組まれていると読めない
 * （そのときは utf8 として読む）。配った先で確かめる手が無いので、doctor に言わせる。
 */
export function shiftJisSupported(
  make: (label: string) => { decode(bytes: Uint8Array): string } = (label) => new TextDecoder(label),
): boolean {
  try {
    return make('shift_jis').decode(Buffer.from([0x82, 0xa0])) === 'あ';
  } catch {
    return false;
  }
}
