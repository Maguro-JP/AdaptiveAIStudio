/**
 * このファイルが直に起こされたか（読み込まれただけではないか）。
 *
 * `import.meta.url === pathToFileURL(process.argv[1]).href` で見ていた。Node は起こしたファイルを実体の道（realpath）で
 * 読むので、import.meta.url は実体の道になる。argv[1] は打たれた道のまま。道の途中にリンク・junction・subst のドライブ・
 * Windows の短い名前があると一致せず、**何もせずに終了コード 0 で終わる**。試験を回すスクリプトなら、試験を一つも
 * 走らせずに「通った」になる。両方を実体の道にそろえて比べる。
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** @param {string} metaUrl 呼ぶ側の `import.meta.url` */
export function isMain(metaUrl) {
  const given = process.argv[1];
  if (!given) return false;
  try {
    return realpathSync(given) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}
