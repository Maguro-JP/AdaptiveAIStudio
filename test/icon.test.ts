// アプリの絵柄: 置いてあるファイルが作る台本の出力と同じで、画面と setup.exe が同じ絵柄を指すこと
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error 型の無い .mjs
import { ico, svg, png } from '../scripts/make-icon.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const at = (rel: string) => join(root, rel);

test('置いてある ico と svg は make-icon.mjs の出力と同じ', () => {
  assert.deepEqual(readFileSync(at('installer/AdaptiveAIStudio.ico')), ico([16, 32, 48, 256]));
  assert.equal(readFileSync(at('src/ui/web/icon.svg'), 'utf8'), svg());
});

test('ico は 4 つの大きさを持ち、どれも PNG で始まる', () => {
  const b = readFileSync(at('installer/AdaptiveAIStudio.ico'));
  assert.equal(b.readUInt16LE(2), 1);
  assert.equal(b.readUInt16LE(4), 4);
  for (let k = 0; k < 4; k++) {
    const off = b.readUInt32LE(6 + 16 * k + 12);
    assert.equal(b.subarray(off, off + 4).toString('latin1'), '\x89PNG');
  }
  assert.ok((png(16) as Buffer).length > 50);
});

test('画面と setup.exe が絵柄を指している', () => {
  assert.match(readFileSync(at('src/ui/web/index.html'), 'utf8'), /<link rel="icon"[^>]*href="icon\.svg"/);
  const nsi = readFileSync(at('installer/AdaptiveAIStudio.nsi'), 'utf8');
  assert.match(nsi, /^Icon "\$\{APP\}\.ico"/m);
  assert.match(nsi, /CreateShortcut "\$DESKTOP\\\$\{APP\}\.lnk" .* "\$INSTDIR\\\$\{APP\}\.ico"/);
});
