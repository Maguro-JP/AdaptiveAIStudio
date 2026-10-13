import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEdit } from '../src/agent/tools/write-kind.ts';

test('真ん中に空行を足した find でも、塊のすぐ後ろの同じ形の閉じ括弧を消さない', () => {
  const before = [
    "describe('a', () => {",
    "  test('one', () => {",
    '    const x = 1;',
    '    const y = 2;',
    '    assert.equal(x + 1, y);',
    '  });',
    '});',
    '',
    "describe('b', () => {});",
  ].join('\n');
  // 空行を一つ足して渡す（小さいモデルの崩し方）
  const find = ["  test('one', () => {", '    const x = 1;', '', '    const y = 2;', '    assert.equal(x + 1, y);', '  });'].join('\n');
  const replace = ["  test('one', () => {", '    const x = 1;', '    const y = 3;', '    assert.equal(x + 2, y);', '  });'].join('\n');
  const got = applyEdit(before, find, replace, false);
  assert.equal(got.hits, 1);
  assert.equal(got.text, before.replace('const y = 2;', 'const y = 3;').replace('x + 1, y', 'x + 2, y'));
});
