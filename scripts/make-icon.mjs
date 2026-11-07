/**
 * アプリの絵柄（installer/AdaptiveAIStudio.ico）を組む。
 *
 * 絵柄の元は Figma の画像生成で作り、大きさごとの PNG にして installer/icon/<大きさ>.png に置いてある
 * （黒い角丸の四角に、白い中の点と、赤・橙の 3 つの点を光る線で結んだ図）。
 * ここでは、その PNG をそのまま ICO に詰めるだけにする。依存は持たず、同じ入力からは同じバイト列が出る。
 * 画面（アプリのウィンドウ）は src/ui/web/icon.png（256 の写し）を使う。
 *
 * 使い方: node scripts/make-icon.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SIZES = [16, 24, 32, 48, 64, 128, 256];

export function ico(images) {
  const head = Buffer.alloc(6); head.writeUInt16LE(1, 2); head.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const dir = images.map(({ size, png }) => {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(png.length, 8); e.writeUInt32LE(offset, 12);
    offset += png.length;
    return e;
  });
  return Buffer.concat([head, ...dir, ...images.map((i) => i.png)]);
}

export function build(base = root) {
  return ico(SIZES.map((size) => ({ size, png: readFileSync(join(base, 'installer', 'icon', `${size}.png`)) })));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(join(root, 'installer', 'AdaptiveAIStudio.ico'), build());
  console.log('installer/AdaptiveAIStudio.ico を書きました');
}
