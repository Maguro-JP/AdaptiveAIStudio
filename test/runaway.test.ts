/**
 * 同じ並びを吐き続けているのを見つける。
 *
 * 実機で「1+1=」に `1+100000000…` と 0 を延々と書き続け、帯は 4 分 36 秒
 * 「書いています」のままだった。止める手が無かったので、上限まで吐き切る。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { findRunaway, runawayNote } from '../src/runtime/runaway.ts';

describe('暴走（同じ並びの繰り返し）を見つける', () => {
  test('**実機で出た形。0 を吐き続けている**', () => {
    const text = `1+1${'0'.repeat(400)}`;
    const at = findRunaway(text);
    assert.ok(at >= 0, '見つけていない');
    // 「1+1」の直後から。頭の 3 文字を巻き込んで消さない。
    assert.ok(at <= 3, `切る位置が前すぎる: ${at}`);
  });

  test('長い単位の繰り返しも拾う', () => {
    const at = findRunaway(`答えます。${'これは同じ文の繰り返しです。'.repeat(20)}`);
    assert.ok(at >= 0);
  });

  test('**短ければ拾わない。**普通の文を切らない', () => {
    assert.equal(findRunaway('1+1=2 です。'), -1);
    assert.equal(findRunaway('a'.repeat(199)), -1, '閾値の手前で拾っている');
  });

  test('**罫線を暴走にしない（対）**', () => {
    // 見出しの下線や表の区切り。行の幅を超えないので、閾値の内側。
    assert.equal(findRunaway(`# 見出し\n${'-'.repeat(80)}\n本文`), -1);
    assert.equal(findRunaway(`|${'-'.repeat(60)}|\n|${'-'.repeat(60)}|`), -1);
  });

  test('**普通の日本語の文章を切らない（対）**', () => {
    const prose = 'この関数は入力を読み、結果を返します。'
      + '引数が空のときは何もしません。失敗したときは理由を添えて投げます。'
      + '呼ぶ側は、戻り値を見てから次へ進んでください。以上が仕様です。';
    assert.equal(findRunaway(prose.repeat(2)), -1, `普通の文を切っている:\n${prose}`);
  });

  test('閾値は渡せる（狭いコンテキストウィンドウの相手でも早く切れる）', () => {
    assert.ok(findRunaway('ab'.repeat(30), { minRun: 40 }) >= 0);
    assert.equal(findRunaway('ab'.repeat(30), { minRun: 500 }), -1);
  });

  test('長い入力でも、走査する量が増えない', () => {
    // 末尾しか見ない。長さに比例して遅くならないこと（二乗にしない）。
    const small = 'x'.repeat(2_000);
    const big = 'x'.repeat(200_000);
    const t0 = process.hrtime.bigint(); findRunaway(small); const a = process.hrtime.bigint() - t0;
    const t1 = process.hrtime.bigint(); findRunaway(big); const b = process.hrtime.bigint() - t1;
    // 100 倍の長さで 20 倍を超えるなら、末尾だけを見ていない。
    assert.ok(b < a * 20n + 1_000_000n, `長さに比例している: ${a} -> ${b}`);
  });

  test('止めた理由に、何を繰り返していたかが出る', () => {
    const text = `1+1${'0'.repeat(400)}`;
    const note = runawayNote(text, findRunaway(text));
    assert.match(note, /繰り返していたので止めました/);
    assert.match(note, /0/);
  });
});
