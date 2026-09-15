/**
 * Tab 補完。
 *
 * エディタで手が止まったら、「ここまで」と「ここから先」をモデルに渡して、
 * 続きを数行もらう。灰色で見せて Tab で入れる。Cursor の Tab 補完に当たる。
 *
 * ここは純粋な部分だけ。頼み方（文）と、返ってきたものの掃除。
 * 小さいモデルは ``` で囲ったり、直前の行を写し直したりするので、そこを落とす。
 */
import type { ProviderMessage } from '../providers/contract.ts';

/** 渡す前後の長さ。長いほど当たるが、CPU では読むだけで待たされる。 */
export const PREFIX_CHARS = 2000;
export const SUFFIX_CHARS = 400;
/** 返す行数の上限。補完は「次の一手」であって、続きを書き切ることではない。 */
export const MAX_LINES = 6;

export function buildCompletionInput(path: string, prefix: string, suffix: string): { system: string; messages: ProviderMessage[] } {
  const before = prefix.slice(-PREFIX_CHARS);
  const after = suffix.slice(0, SUFFIX_CHARS);
  const system = [
    'You are a code completion engine inside an editor.',
    'Output ONLY the code that should be inserted at the cursor (marked <CURSOR>).',
    'Do not repeat the code before the cursor. Do not explain. No markdown fences.',
    `Stop after at most ${MAX_LINES} lines.`,
  ].join(' ');
  const messages: ProviderMessage[] = [{
    role: 'user',
    content: `File: ${path}\n\n${before}<CURSOR>${after}`,
  }];
  return { system, messages };
}

/**
 * 返ってきたものを、入れられる形にする。
 *
 * - ``` の囲いは外す
 * - 直前の行（カーソルのある行の、そこまで）を写し直していたら、その分を落とす
 * - 空行が来たら、そこで切る（次の塊まで書き始めている）
 * - 行数の上限で切る
 */
export function cleanCompletion(prefix: string, raw: string): string {
  let text = String(raw ?? '');
  // 囲い
  text = text.replace(/^\s*```[a-zA-Z0-9_-]*\s*\n?/, '').replace(/\n?\s*```\s*$/, '');
  text = text.replace(/<CURSOR>/g, '');
  // 直前の行の写し直し
  const lastLine = prefix.slice(prefix.lastIndexOf('\n') + 1);
  if (lastLine.trim() && text.startsWith(lastLine)) text = text.slice(lastLine.length);
  else if (lastLine.trim() && text.trimStart().startsWith(lastLine.trimStart()) && lastLine.trimStart().length > 3) {
    text = text.trimStart().slice(lastLine.trimStart().length);
  }
  // 行末の余りは残す。先頭の改行は、カーソルが行末に在るときだけ意味がある。
  if (!prefix.endsWith('\n') && lastLine.trim() === '') text = text.replace(/^\n+/, '');
  const lines = text.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    if (out.length > 0 && line.trim() === '') break;
    out.push(line);
    if (out.length >= MAX_LINES) break;
  }
  return out.join('\n').replace(/\s+$/, (m) => (m.includes('\n') ? '' : m));
}
