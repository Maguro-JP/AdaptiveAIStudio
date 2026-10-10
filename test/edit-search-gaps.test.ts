/**
 * 書き換えと探すツールの不具合（88 回目の調査）。
 *
 * - edit_file: 字下げの浅い一行の `find` が行の頭の空白の途中に当たると、複数行の `replace` の二行目から後を浅い字下げのまま入れ、
 *   しかも「完全に一致した」として何も言わなかった（Python では黙って壊れる）
 * - search_text: 改行を含む文字列は、ファイルに在っても「該当なし」になっていた（行ごとに探していたため）
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { applyEdit } from '../src/agent/tools/write-kind.ts';
import { searchText } from '../src/agent/tools/fs.ts';

describe('edit_file の字下げ', () => {
  test('字下げを落とした一行の find でも、置き換えの各行を元の字下げに合わせる', () => {
    const r = applyEdit('def f():\n    if a:\n        pass\n', '  if a:', '  if a:\n      b()', false);
    assert.equal(r.text, 'def f():\n    if a:\n        b()\n        pass\n', JSON.stringify(r.text));
    assert.notEqual(r.how, 'exact', '字下げを合わせたのに、完全に一致したと言っている');
  });

  test('行の途中の名前の付け替えは、そのまま完全一致（対）', () => {
    const r = applyEdit('const a = foo(1);\n', 'foo', 'bar', false);
    assert.equal(r.text, 'const a = bar(1);\n');
    assert.equal(r.how, 'exact');
  });
});

describe('search_text の改行を含む文字列', () => {
  test('複数行にまたがる文字列も見つけ、始まりの行を返す', async () => {
    const root = await tempDir('aas-search-nl-');
    await writeFile(join(root, 'a.ts'), 'x\nfoo\nbar\n');
    const r = await searchText(root, 'foo\nbar', '.', new AbortController().signal);
    assert.equal(r.hits.length, 1, JSON.stringify(r));
    assert.equal(r.hits[0]!.line, 2);
  });
});

describe('edit_file の緩い当ての字下げ', () => {
  test('元で行の頭にあった行は、行の頭のまま（最初の行の差を全部に足さない）', () => {
    const r = applyEdit('x = 1\n  foo()\nbar()\n', 'foo()\nbar()', 'foo2()\nbar2()', false);
    assert.equal(r.text, 'x = 1\n  foo2()\nbar2()\n', JSON.stringify(r.text));
  });

  test('揃って字下げを落としたなら、全部の行を揃えて戻す（対）', () => {
    const r = applyEdit('def f():\n    a()\n    b()\n', 'a()\nb()', 'a2()\nb2()', false);
    assert.equal(r.text, 'def f():\n    a2()\n    b2()\n', JSON.stringify(r.text));
  });
});
