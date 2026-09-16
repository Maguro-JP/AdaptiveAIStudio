/**
 * 同じところを回っているかの判定。
 *
 * 見ていたのは 1 手の繰り返しだけだった（直近 3 回が同じなら止める）。
 * `read_file(a)` → `search_text(x)` → `read_file(a)` → … の往復は
 * 一度も当たらず、ターンの上限まで回り続けていた。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { cyclePeriod, CYCLE_WINDOW } from '../src/agent/loop.ts';

describe('堂々巡りの周期', () => {
  test('1 手の繰り返しは 3 回で止める', () => {
    assert.equal(cyclePeriod(['a', 'a', 'a']), 1);
    assert.equal(cyclePeriod(['a', 'a']), undefined, '2 回では止めない');
  });

  test('**2 手の往復を見る**', () => {
    assert.equal(cyclePeriod(['a', 'b', 'a', 'b']), 2);
    assert.equal(cyclePeriod(['x', 'a', 'b', 'a', 'b']), 2, '前に別の手が在っても見る');
    assert.equal(cyclePeriod(['a', 'b', 'a']), undefined, '1 周半では止めない');
  });

  test('**3 手の巡りを見る**', () => {
    assert.equal(cyclePeriod(['a', 'b', 'c', 'a', 'b', 'c']), 3);
    assert.equal(cyclePeriod(['a', 'b', 'c', 'a', 'b']), undefined, '1 周と少しでは止めない');
  });

  test('進んでいるなら止めない（対）', () => {
    assert.equal(cyclePeriod(['a', 'b', 'c', 'd', 'e', 'f']), undefined);
    assert.equal(cyclePeriod(['a', 'b', 'a', 'c']), undefined);
    assert.equal(cyclePeriod([]), undefined);
  });

  test('同じツールでも、引数が違えば別の手（対）', () => {
    // 呼び出しは `名前:引数` の形で見分ける。別のファイルを順に読むのは進んでいる。
    const sign = (p: string) => `read_file:{"path":"${p}"}`;
    assert.equal(cyclePeriod([sign('a'), sign('b'), sign('c'), sign('d')]), undefined);
    assert.equal(cyclePeriod([sign('a'), sign('b'), sign('a'), sign('b')]), 2,
      '同じ二つを往復しているなら止める');
  });

  test('覚えておく数だけで、いちばん長い周期まで見られる', () => {
    // 3 手周期を 2 周ぶん見るには 6 要る。足りなければ、その分は一度も当たらない。
    assert.ok(CYCLE_WINDOW >= 6, `覚える数が足りません: ${CYCLE_WINDOW}`);
    const six = ['a', 'b', 'c', 'a', 'b', 'c'];
    assert.equal(cyclePeriod(six.slice(-CYCLE_WINDOW)), 3);
  });
});
