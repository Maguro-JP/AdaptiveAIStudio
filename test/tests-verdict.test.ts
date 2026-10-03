/**
 * selftest のテストの行の合否。`# fail 0` だけで決めていたので、時間切れで打ち切られた試験や、走らせ役が 1 で終えた回を「通った」と言っていた。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { testsPassed } from '../src/cli/tests-verdict.ts';

describe('テストの合否', () => {
  test('打ち切られた試験があれば、fail 0 でも通ったと言わない', () => {
    // node:test は timeout を超えた試験を fail ではなく cancelled に数え、終了コードは 1
    assert.equal(testsPassed('# pass 10\n# fail 0\n# cancelled 1\n', 1), false);
  });
  test('走らせ役が 1 で終えたら、fail 0 でも通ったと言わない', () => {
    assert.equal(testsPassed('# pass 10\n# fail 0\n# cancelled 0\n', 1), false);
  });
  test('起こせなかった（終了コードが無い）なら通ったと言わない', () => {
    assert.equal(testsPassed('spawn EPERM', null), false);
  });
  test('全部通って 0 で終えたら通った（対）', () => {
    assert.equal(testsPassed('# pass 10\n# fail 0\n# cancelled 0\n', 0), true);
  });
});
