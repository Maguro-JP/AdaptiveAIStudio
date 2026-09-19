/**
 * **小さいものを「0.0 GB」と言わない。**
 *
 * モデルの一覧は GB 固定で書いていたので、途中で切れた取得や小さい模型は
 * 全部「0.0 GB」になった。置いた本人にも、それが何なのか分からない。
 * 添付の大きさも同じ形で出すので、一つの所で決める。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { sizeText } from '../src/ui/web/size.js';

describe('大きさの書き方', () => {
  test('**GB に満たないものを GB で言わない**', () => {
    assert.equal(sizeText(121 * 1024), '121KB');
    assert.equal(sizeText(300 * 1024 ** 2), '300.0MB');
    assert.equal(sizeText(512), '512B');
  });

  test('GB のものは GB で言う', () => {
    assert.equal(sizeText(2 * 1024 ** 3), '2.0GB');
    assert.equal(sizeText(7.4 * 1024 ** 3), '7.4GB');
  });

  test('境目', () => {
    assert.equal(sizeText(1023), '1023B');
    assert.equal(sizeText(1024), '1KB');
    assert.equal(sizeText(1024 ** 2 - 1), '1024KB');
    assert.equal(sizeText(1024 ** 2), '1.0MB');
    assert.equal(sizeText(1024 ** 3 - 1), '1024.0MB');
    assert.equal(sizeText(1024 ** 3), '1.0GB');
  });

  test('分からないものは、何も言わない', () => {
    assert.equal(sizeText(undefined), '');
    assert.equal(sizeText(null), '');
    assert.equal(sizeText(-1), '');
    assert.equal(sizeText(0), '0B');
  });
});
