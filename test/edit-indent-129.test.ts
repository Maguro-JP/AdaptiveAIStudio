import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEdit } from '../src/agent/tools/write-kind.ts';

test('1 行目の字下げが合っていても、2 行目から後のずれた字下げをファイルに合わせる', () => {
  const got = applyEdit('def f():\n    a = 1\n    b = 2\n    return b\n', 'def f():\n  a = 1\n  b = 2', 'def f():\n  a = 1\n  b = 3', false);
  assert.equal(got.text, 'def f():\n    a = 1\n    b = 3\n    return b\n');
});

test('replace がファイルの字下げで書かれていれば、そのまま入れる（二重に深くしない）', () => {
  const got = applyEdit('def f():\n    a = 1\n    b = 2\n', 'def f():\n  a = 1\n  b = 2', 'def f():\n    a = 1\n    b = 3', false);
  assert.equal(got.text, 'def f():\n    a = 1\n    b = 3\n');
});

test('CRLF のファイルを LF の find で書き換えても、CRLF のまま残す', () => {
  const got = applyEdit('a\r\n  b\r\nc\r\n', 'a\n  b', 'a\n  b2', false);
  assert.equal(got.text, 'a\r\n  b2\r\nc\r\n');
});

test('行の途中に当たった 1 行の find を複数行で置き換えたら、2 行目から後にも同じ字下げを付ける', () => {
  const got = applyEdit('if x:\n    call(x)\n', 'call(x)', 'a()\nb()', false);
  assert.equal(got.text, 'if x:\n    a()\n    b()\n');
});

test('式の途中に当たった 1 行の find は、字下げを付けない', () => {
  const got = applyEdit('x = f(a)\n', 'f(a)', 'g(\n  a)', false);
  assert.equal(got.text, 'x = g(\n  a)\n');
});

test('タブのファイルに一段深い行を足すと、タブで字下げする', () => {
  const got = applyEdit('\tif a:\n\t\tb\n', '  if a:\n    b', '  if a:\n    b\n      c', false);
  assert.equal(got.text, '\tif a:\n\t\tb\n\t\t\tc\n');
});
