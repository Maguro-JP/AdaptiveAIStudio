/**
 * Tab 補完。エディタで手が止まったら続きを数行もらい、Tab で入れる。
 * 小さいモデルは囲いを付けたり直前の行を写し直したりするので、掃除を見る。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { cleanCompletion, buildCompletionInput, MAX_LINES } from '../src/core/completion.ts';

describe('返ってきたものの掃除', () => {
  test('囲いを外す', () => {
    assert.equal(cleanCompletion('const a = ', '```js\n1;\n```'), '1;');
  });
  test('直前の行を写し直していたら、その分を落とす', () => {
    assert.equal(cleanCompletion('function add(a, b) {\n  return ', '  return a + b;\n}'), 'a + b;\n}');
  });
  test('空行で切る（次の塊まで書き始めている）', () => {
    assert.equal(cleanCompletion('x = ', '1;\ny = 2;\n\nfunction other() {}'), '1;\ny = 2;');
  });
  test('行数の上限で切る', () => {
    const many = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n');
    assert.equal(cleanCompletion('', many).split('\n').length, MAX_LINES);
  });
  test('<CURSOR> が混ざっても落とす', () => {
    assert.equal(cleanCompletion('a', '<CURSOR>bc'), 'bc');
  });
  test('空でも落ちない', () => {
    assert.equal(cleanCompletion('', ''), '');
    assert.equal(cleanCompletion('x', undefined as unknown as string), '');
  });
});

describe('頼み方', () => {
  test('前後を切り詰めて、<CURSOR> を挟んで渡す', () => {
    const { system, messages } = buildCompletionInput('a.ts', 'p'.repeat(5000), 's'.repeat(5000));
    assert.match(system, /ONLY/);
    const body = messages[0]!.content;
    assert.ok(body.includes('<CURSOR>'));
    assert.ok(body.length < 3000, `長すぎる: ${body.length}`);
    assert.ok(body.includes('File: a.ts'));
  });
});
