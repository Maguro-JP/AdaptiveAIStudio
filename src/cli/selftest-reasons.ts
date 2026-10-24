/**
 * selftest が、読めなかった理由を言い分ける所。試験から呼べるように、走らせる本体（`selftest.ts`）から分けてある。
 */
import { how } from './how.ts';

/**
 * node-llama-cpp が読み込めなかったとき、「入っていない」か（undefined）、「在るのに壊れている」か（false）。
 * 符号だけで見ると、本体は在って依存が欠けた形（bundle の片づけの欠け）も同じ `ERR_MODULE_NOT_FOUND` になり、「入っていません」と言っていた。
 * 本体そのものを指しているときだけ「入っていない」にする。
 */
export function llamaLoadVerdict(e: unknown): undefined | false {
  const err = e as NodeJS.ErrnoException;
  if (err?.code !== 'ERR_MODULE_NOT_FOUND') return false;
  return /Cannot find package 'node-llama-cpp'/.test(String(err.message)) ? undefined : false;
}

/**
 * モデルの保存先を読めなかったときの言い方。「無い」（ENOENT）だけを「ありません」にし、ほか（権限・フォルダでない）は読めないと言う
 * （在るのに読めない保存先へ、取り直しを勧めていた）。
 */
export function modelsDirProblem(e: unknown, dir: string): string {
  const code = (e as NodeJS.ErrnoException)?.code;
  return code === 'ENOENT'
    ? `${dir} がありません（${how('models', '--get')} で取ってきます）`
    : `${dir} を読めません（${code ?? (e as Error)?.message ?? '理由不明'}）。権限か、フォルダかを確かめてください`;
}
