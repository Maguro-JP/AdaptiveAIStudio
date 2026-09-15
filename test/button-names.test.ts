/**
 * **無い名前の押しボタンを、案内に書かない。**
 *
 * 案内は「設定 → モデル の『フォルダ』で指してください」「モデルの画面で
 * 『置いたものを読み直す』を押してください」のように書いていた。どちらも
 * **画面にその名前は無い。**言われたとおりに開いた人は、無いものを探す。
 * 直したい所へ辿り着けないまま、そこで止まる。
 *
 * 名前は片方だけ直せば食い違う（案内は .ts、押しボタンは画面）。書き方で止める。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.(ts|js)$/.test(p)) out.push(p);
  }
  return out;
}

/** 画面に出る言葉。押しボタンの名前は、ここか、画面を組む側にある。 */
const shown = [
  readFileSync(join(root, 'src/ui/web/index.html'), 'utf8'),
  readFileSync(join(root, 'src/ui/web/app.js'), 'utf8'),
  readFileSync(join(root, 'src/ui/web/panels.js'), 'utf8'),
].join('\n');

test('「…」を押してください、の「…」が画面にある', () => {
  const missing: string[] = [];
  for (const file of sources(join(root, 'src'))) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/「([^」]{1,24})」を押/g)) {
      const name = m[1]!;
      if (shown.includes(name)) continue;
      missing.push(`${file.slice(root.length + 1)}: 「${name}」`);
    }
  }
  assert.deepEqual(missing, [], `画面に無い名前を案内しています:\n  ${missing.join('\n  ')}`);
});
