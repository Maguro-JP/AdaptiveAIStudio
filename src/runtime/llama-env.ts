/**
 * llama-server を動かすための環境。
 *
 * bundle は実行ファイルと共有ライブラリが同じ場所に入っている。
 * ところが **Linux と macOS は、実行ファイルの隣を自動では探さない**。
 * そのまま起動すると、置いてあるのに
 * 「libllama.so が見つからない」で落ちる。
 * 実際にこれを踏んだので、探す場所を明示して渡す。
 *
 * Windows は exe と同じ場所の DLL を見るので、何も要らない。
 */
import { basename, dirname } from 'node:path';

/** 変数名。環境で違う。 */
export function libPathVar(platform: NodeJS.Platform): string | undefined {
  if (platform === 'win32') return undefined;
  return platform === 'darwin' ? 'DYLD_LIBRARY_PATH' : 'LD_LIBRARY_PATH';
}

/**
 * 起動時に渡す環境変数を組み立てる。
 * 元からある指定は消さずに、実行ファイルの場所を先頭へ足す。
 */
export function runtimeEnv(
  command: string,
  platform: NodeJS.Platform = process.platform,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const key = libPathVar(platform);
  if (!key) return { ...base };

  // 名前だけ（`llama-server`）で呼ぶときは、PATH から探される。その dirname は `.` で、先頭に足すと子の今のフォルダ（作業場）の
  // `libllama.so` などを本物より先に読ませていた（取ってきたリポジトリの中のライブラリが走る道）。名前だけなら何も足さない
  if (basename(command) === command) return { ...base };
  const dir = dirname(command);
  const existing = base[key];
  const sep = ':';
  return {
    ...base,
    [key]: existing && existing.length > 0 ? `${dir}${sep}${existing}` : dir,
  };
}
