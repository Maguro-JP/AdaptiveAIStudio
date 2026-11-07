// アプリの絵柄: ico は置いてある PNG を詰めたもので、画面と setup.exe が同じ絵柄を指すこと
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error 型の無い .mjs
import { build, SIZES } from '../scripts/make-icon.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const at = (rel: string) => join(root, rel);

test('置いてある ico は installer/icon の PNG を詰めたものと同じ', () => {
  assert.deepEqual(readFileSync(at('installer/AdaptiveAIStudio.ico')), build(root));
});

test('ico の大きさはどれも PNG で、書かれた大きさと中身の大きさが合う', () => {
  const b = readFileSync(at('installer/AdaptiveAIStudio.ico'));
  assert.equal(b.readUInt16LE(4), SIZES.length);
  SIZES.forEach((size: number, k: number) => {
    const off = b.readUInt32LE(6 + 16 * k + 12);
    assert.equal(b.subarray(off, off + 4).toString('latin1'), '\x89PNG');
    assert.equal(b.readUInt32BE(off + 16), size);
    assert.equal(b.readUInt32BE(off + 20), size);
  });
});

test('画面と setup.exe が同じ絵柄を指している', () => {
  assert.match(readFileSync(at('src/ui/web/index.html'), 'utf8'), /<link rel="icon"[^>]*href="icon\.png"/);
  assert.deepEqual(readFileSync(at('src/ui/web/icon.png')), readFileSync(at('installer/icon/256.png')));
  const nsi = readFileSync(at('installer/AdaptiveAIStudio.nsi'), 'utf8');
  assert.match(nsi, /^Icon "\$\{APP\}\.ico"/m);
  assert.match(nsi, /CreateShortcut "\$DESKTOP\\\$\{APP\}\.lnk" .* "\$INSTDIR\\\$\{APP\}\.ico"/);
});
