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

test('途中を省いた find でも、何度も出る閉じ括弧の手前で止めず、塊の終わりまで置き換える', () => {
  const body = (n: number) => [`  test('t${n}', () => {`, `    run(${n});`, '  });', ''];
  const before = ["describe('a', () => {", ...body(1), ...body(2), ...body(3), '});', '', 'after();'].join('\n');
  // 頭から終わりの `});` までを渡すが、真ん中の 2 行（t2 の頭と中身）を省く
  const find = ["describe('a', () => {", ...body(1), '  });', '', ...body(3), '});'].join('\n');
  const replace = "describe('a', () => {});";
  const got = applyEdit(before, find, replace, false);
  assert.equal(got.hits, 1);
  assert.equal(got.text, ["describe('a', () => {});", '', 'after();'].join('\n'));
});
