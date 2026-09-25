/**
 * 押すツリーが外の main と同じなら、push の手前の確かめを飛ばす（`scripts/same-as-main.mjs`）。
 *
 * 飛ばしてよいのは「外に新しく出るものが無い」ときだけ。飛ばしすぎると、確かめていない
 * ものが外に出る。**飛ばさない側の形を、飛ばす側と同じだけ見る。**
 * フックが本当に飛ばす・飛ばさないは `test/pushed-tree.test.ts` で見る。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error 型定義を置かない開発用の script。ここだけ読む。
import { sameAsMain } from '../scripts/same-as-main.mjs';

const M = 'm'.repeat(40);
const X = 'x'.repeat(40);

describe('main と同じツリーなら飛ばす', () => {
  test('押すブランチのツリーが全部 main と同じなら、理由を言って飛ばす', () => {
    const why = sameAsMain({ trees: [M], mainTree: M, other: false, remote: 'origin' });
    assert.ok(why, '飛ばしていない');
    assert.match(why, /origin\/main と同じ/);
    assert.match(why, /mmmmmmm/, `どのツリーかを言っていない: ${why}`);
  });

  test('一つでも違えば飛ばさない', () => {
    assert.equal(sameAsMain({ trees: [M, X], mainTree: M, other: false, remote: 'origin' }), undefined);
    assert.equal(sameAsMain({ trees: [X], mainTree: M, other: false, remote: 'origin' }), undefined);
  });

  test('タグなど、ブランチ以外が混ざれば飛ばさない（release の合図になる）', () => {
    assert.equal(sameAsMain({ trees: [M], mainTree: M, other: true, remote: 'origin' }), undefined);
  });

  test('比べる相手（手元の main）が無ければ飛ばさない。押すブランチが無くても飛ばさない', () => {
    assert.equal(sameAsMain({ trees: [M], mainTree: undefined, other: false, remote: 'origin' }), undefined);
    assert.equal(sameAsMain({ trees: [], mainTree: M, other: false, remote: 'origin' }), undefined);
  });
});
