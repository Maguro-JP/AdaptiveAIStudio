/**
 * 答えを、読める形で出す。
 *
 * 答えはそのまま textContent に流していた。モデルが書く ``` の囲いも
 * 記号のまま並び、**書いたコードがコードとして読めなかった。**
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseBlocks, parseInline } from '../src/ui/web/markdown.js';

describe('答えを塊に切る', () => {
  test('囲いは、コードの塊になる', () => {
    const b = parseBlocks('説明\n```js\nconsole.log(1)\n```\n補足');
    assert.deepEqual(b, [
      { type: 'para', text: '説明' },
      { type: 'code', lang: 'js', text: 'console.log(1)', closed: true },
      { type: 'para', text: '補足' },
    ]);
  });

  test('**閉じていない囲いも、そこまでをコードにする**（流れている途中）', () => {
    const b = parseBlocks('```\nconst a = 1');
    assert.deepEqual(b, [{ type: 'code', lang: '', text: 'const a = 1', closed: false }]);
  });

  test('囲いの中は、見出しや箇条書きに見えても触らない', () => {
    const b = parseBlocks('```\n# not heading\n- not item\n```');
    assert.equal(b.length, 1);
    assert.equal(b[0]!.type, 'code');
    assert.equal((b[0] as { text: string }).text, '# not heading\n- not item');
  });

  test('見出しと箇条書き', () => {
    const b = parseBlocks('## 手順\n1. 読む\n2. 直す\n- 補足');
    assert.deepEqual(b, [
      { type: 'heading', level: 2, text: '手順' },
      { type: 'list', ordered: true, items: ['読む', '直す'] },
      { type: 'list', ordered: false, items: ['補足'] },
    ]);
  });

  test('空でも落ちない', () => {
    assert.deepEqual(parseBlocks(''), []);
    assert.deepEqual(parseBlocks(undefined as unknown as string), []);
  });

  test('行の中の code と bold', () => {
    assert.deepEqual(parseInline('a `b` **c** d'), [
      { type: 'text', text: 'a ' }, { type: 'code', text: 'b' }, { type: 'text', text: ' ' },
      { type: 'bold', text: 'c' }, { type: 'text', text: ' d' },
    ]);
  });

  test('HTML に見える文字は、文字のまま（塊の中身は文字列で持つ）', () => {
    // 木を組むときは textContent で入れる。ここで <b> が消えていないことを見る。
    const b = parseBlocks('<b>x</b>');
    assert.deepEqual(b, [{ type: 'para', text: '<b>x</b>' }]);
  });
});

describe('画面が、答えを組み直して出す', () => {
  test('panels.js は、答えに textContent を直に足していない', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/ui/web/panels.js'), 'utf8');
    assert.ok(src.includes('renderMarkdown('), '答えを組み直していない');
    assert.ok(!/stream\.textContent \+=/.test(src), '答えを素の文のまま足している');
    // innerHTML に外から来た文を流していないこと。
    assert.ok(!/innerHTML\s*=/.test(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/ui/web/markdown.js'), 'utf8')));
  });
});
