/**
 * 差分の塊は、終わりの改行が無いという行（`\ No newline at end of file`）を持つ。
 *
 * 「改行なし」の行を捨てていたので、終わりの改行だけを変える塊を選んで通しても当たらず（`'x'` に「改行を足す」塊を当てても `'x'` のまま）、
 * 戻すときも改行の変化だけは戻らなかった。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { applyHunks, revertLines, splitHunks } from '../src/agent/hunks.ts';
import { unifiedDiff } from '../src/agent/diff.ts';

describe('終わりの改行を当てる', () => {
  test('**改行を足す塊・消す塊を選んで通すと、その通りになる**', () => {
    assert.equal(applyHunks('x', unifiedDiff('a.txt', 'x', 'x\n'), [0]), 'x\n');
    assert.equal(applyHunks('x\n', unifiedDiff('a.txt', 'x\n', 'x'), [0]), 'x');
  });

  test('「改行なし」の行は lines に入れない（画面の行の番号と揃える）', () => {
    const h = splitHunks(unifiedDiff('a.txt', 'x', 'x\n'))[0]!;
    assert.deepEqual(h.lines, ['-x', '+x']);
    assert.deepEqual(h.noEol, [0]);
  });

  test('**元の中身の改行が「改行なし」の行と食い違えば、当てない**', () => {
    assert.equal(applyHunks('x\n', unifiedDiff('a.txt', 'x', 'x\n'), [0]), undefined);
    assert.equal(applyHunks('x', unifiedDiff('a.txt', 'x\n', 'x'), [0]), undefined);
  });

  test('**塊が二つあるとき、末尾の塊だけ・頭の塊だけ・両方を選べる**', () => {
    const before = Array.from({ length: 30 }, (_, i) => `line${i + 1}`).join('\n');
    const lines = before.split('\n');
    lines[2] = 'X';
    const after = `${lines.join('\n')}\n`;
    const d = unifiedDiff('a.ts', before, after);
    assert.equal(splitHunks(d).length, 2);
    assert.equal(applyHunks(before, d, [1]), `${before}\n`);
    assert.equal(applyHunks(before, d, [0]), lines.join('\n'));
    assert.equal(applyHunks(before, d, [0, 1]), after);
  });

  test('改行の変わらない差分は、これまでどおり（対）', () => {
    assert.equal(applyHunks('a\nb\n', unifiedDiff('a.txt', 'a\nb\n', 'a\nB\n'), [0]), 'a\nB\n');
    assert.equal(applyHunks('a\nb', unifiedDiff('a.txt', 'a\nb', 'A\nb'), [0]), 'A\nb');
  });
});

describe('終わりの改行を戻す', () => {
  test('**改行を足した塊・消した塊を戻すと、元の改行に戻る**', () => {
    assert.equal(revertLines('x\n', unifiedDiff('a.txt', 'x', 'x\n'), [{ hunk: 0 }]), 'x');
    assert.equal(revertLines('x', unifiedDiff('a.txt', 'x\n', 'x'), [{ hunk: 0 }]), 'x\n');
    assert.equal(revertLines('x\n', unifiedDiff('a.txt', 'x', 'x\n'), [{ hunk: 0, lines: [1] }]), 'x');
  });

  test('**「改行なし」の行を持つ塊を戻さないときは、改行はそのまま**', () => {
    const before = 'a\nm1\nm2\nm3\nm4\nb';
    const after = 'A\nm1\nm2\nm3\nm4\nb\n';
    const d = unifiedDiff('b.txt', before, after, 1);
    assert.equal(splitHunks(d).length, 2);
    assert.equal(revertLines(after, d, [{ hunk: 0 }]), 'a\nm1\nm2\nm3\nm4\nb\n');
    assert.equal(revertLines(after, d, [{ hunk: 1 }]), 'A\nm1\nm2\nm3\nm4\nb');
  });
});
