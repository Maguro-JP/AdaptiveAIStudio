/**
 * 戻す前に、**戻るファイルを全部並べる。**
 *
 * 画面は選んだ一件の `paths` だけを出して「戻します」と訊いていた。戻るのは
 * その後の回の分も含む（`src/core/undo.ts` の `restore`）ので、並べていない
 * ファイルまで書き戻る。押した人は、何が消えるか分からないまま押すことになる。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { willRestore, wontRestore } from '../src/ui/web/undo-scope.js';

// 新しい順。いちばん新しいものが先頭。
const LIST = [
  { paths: ['c.txt'] },
  { paths: ['b.txt', 'c.txt'] },
  { paths: ['a.txt'] },
];

describe('ここまで戻すと、どれが書き戻るか', () => {
  test('いちばん新しいものは、その一件だけ', () => {
    assert.deepEqual(willRestore(LIST, 0), ['c.txt']);
  });

  test('**古いものを選ぶと、その後の回の分も並ぶ**', () => {
    assert.deepEqual(willRestore(LIST, 2), ['c.txt', 'b.txt', 'a.txt']);
  });

  test('同じファイルは一度だけ並べる', () => {
    assert.deepEqual(willRestore(LIST, 1), ['c.txt', 'b.txt']);
  });

  test('paths が無い回が混ざっても落ちない', () => {
    assert.deepEqual(willRestore([{ paths: ['x'] }, undefined, { paths: ['y'] }], 2), ['x', 'y']);
  });

  test('番号が外れていても、何も落とさない', () => {
    assert.deepEqual(willRestore(LIST, -1), ['c.txt']);
    assert.deepEqual(willRestore(LIST, 99), ['c.txt', 'b.txt', 'a.txt']);
    assert.deepEqual(willRestore(undefined as unknown as typeof LIST, 0), []);
  });
});

/**
 * **戻らないものを、戻る顔で並べない。**
 *
 * 大きすぎて控えられなかったファイルは、戻り先に中身が入っていない。知らせは
 * 流れにしか出していなかったので、既定の並びで見ている人には届かない。
 */
describe('ここまで戻しても、戻らないもの', () => {
  const WITH_SKIP = [
    { paths: ['a.txt'], skipped: ['big.bin'] },
    { paths: ['b.txt'] },
    { paths: ['c.txt'], skipped: ['big.bin', 'huge.bin'] },
  ];

  test('**控えられなかったファイルを並べる**', () => {
    assert.deepEqual(wontRestore(WITH_SKIP, 0), ['big.bin']);
    assert.deepEqual(wontRestore(WITH_SKIP, 2), ['big.bin', 'huge.bin']);
  });

  test('控えられなかったものが無ければ、空', () => {
    assert.deepEqual(wontRestore([{ paths: ['a.txt'] }], 0), []);
    assert.deepEqual(wontRestore(undefined as unknown as typeof WITH_SKIP, 0), []);
  });
});
