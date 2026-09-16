/**
 * 落ちた試験の名前を、正しく拾えていること。
 *
 * ここが嘘をつくと、**落ちていない試験を探しに行く。**bundle の中で1件落ちた
 * 回に、報告された名前は skip されている試験だった。その名前を頼りに半日探した。
 * 出力は数千行あって流し見できないので、ここが唯一の手がかりになる。
 *
 * ここが通ること自体が、**読み込んだだけでは走らない**ことの確かめでもある
 * （読み込んだだけで走ると、試験の中で試験が始まって、ここは終わらない）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error 型を持たない script を、そのまま呼んで確かめる。
import { failedNames } from '../scripts/run-tests.mjs';

describe('落ちた名前を拾う', () => {
  test('suite の中の試験を拾い、suite の名前は出さない', () => {
    const tap = [
      '# Subtest: 決まりを読む',
      '    # Subtest: 空のファイルは、決まりとして数えない',
      '    not ok 1 - 空のファイルは、決まりとして数えない',
      '      ---',
      "      error: 'そうなっていない'",
      '      ...',
      '    1..1',
      'not ok 12 - 決まりを読む',
      '  ---',
      "  error: '1 subtest failed'",
      '  ...',
    ].join('\n');
    assert.deepEqual(failedNames(tap), ['空のファイルは、決まりとして数えない']);
  });

  test('通っているなら、何も出さない', () => {
    assert.deepEqual(failedNames('ok 1 - 通る\n# pass 1\n# fail 0\n'), []);
  });

  test('suite の外で落ちたときは、その名前を出す', () => {
    assert.deepEqual(failedNames('not ok 3 - 外で落ちた\n  ---\n  ...\n'), ['外で落ちた']);
  });

  /**
   * 落ちた理由の中に、子として走らせた試験の出力がそのまま入る
   * （`test/installed-env.test.ts` は子の TAP を assert の言葉に入れる）。
   * **その中の `not ok` は、落ちた試験ではない。**
   */
  test('**落ちた理由の中に入っている試験の名前は、拾わない**', () => {
    const tap = [
      '# Subtest: 入れた機械の env でも、テストは通る',
      '    # Subtest: **AAS_HOME が立っていても、根のテストは通る**',
      '    not ok 1 - **AAS_HOME が立っていても、根のテストは通る**',
      '      ---',
      '      error: |-',
      '        入れた機械の env で落ちる:',
      '        not ok 2 - フックが、その env を落としている',
      '        # fail 1',
      '      ...',
      '    1..1',
      'not ok 7 - 入れた機械の env でも、テストは通る',
      '  ---',
      "  error: '1 subtest failed'",
      '  ...',
    ].join('\n');
    assert.deepEqual(failedNames(tap), ['**AAS_HOME が立っていても、根のテストは通る**']);
  });
});
