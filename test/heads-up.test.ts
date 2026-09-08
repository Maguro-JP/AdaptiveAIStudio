/**
 * 開いた時点で、どれをどれだけ待って読むかを言う。
 *
 * GPU の無い機械で 8B を読んでいたとき、最初の答えに何分もかかった。
 * その間、画面には「待機中」しか無く、送った人には無視されたようにしか
 * 見えなかった。**送る前に言う。**読み込みは始めない。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { headsUp, HEAVY_ON_CPU_BYTES } from '../src/runtime/inproc.ts';

const GB = 1024 ** 3;
const RAM = 16 * GB;
const big = { ref: 'big-8b.gguf', sizeBytes: 5 * GB };
const small = { ref: 'small-1b.gguf', sizeBytes: 0.8 * GB };

describe('先の一言', () => {
  test('GPU なしで大きいものを読むなら、待つことと小さい方を言う', () => {
    const s = headsUp([big, small], RAM, 'big-8b.gguf', false);
    assert.ok(s, '何も言っていない');
    assert.match(s, /big-8b\.gguf（5\.0GB）/);
    assert.match(s, /数分/);
    assert.match(s, /small-1b\.gguf（819MB）/, '1GB 未満は MB で言う');
  });

  test('小さい方が無ければ、待つことだけ言う', () => {
    const s = headsUp([big], RAM, undefined, false);
    assert.ok(s);
    assert.ok(!s.includes('小さいものもあります'));
  });

  test('GPU があるなら、何も言わない', () => {
    assert.equal(headsUp([big, small], RAM, 'big-8b.gguf', true), undefined);
  });

  test('設定が無ければ小さい方が選ばれるので、何も言わない（対）', () => {
    // GPU なしの自動選択は小さい方。待たされないなら、脅さない。
    assert.equal(headsUp([big, small], RAM, undefined, false), undefined);
  });

  test('線より小さいものは、何も言わない', () => {
    assert.equal(headsUp([{ ref: 'a.gguf', sizeBytes: HEAVY_ON_CPU_BYTES - 1 }], RAM, undefined, false), undefined);
  });

  test('載らないものは、ここでは言わない（そちらは別の口が断る）', () => {
    assert.equal(headsUp([{ ref: 'huge.gguf', sizeBytes: 40 * GB }], RAM, undefined, false), undefined);
  });
});
