/**
 * 81 回目の不具合調査（記憶）の分。
 *
 * - 判じ手が読めなかったときの合図で、普通の依頼を嫌がられたこととして覚えない
 * - 字数で切るときに、字の対（絵文字など）の片方だけを残さない
 * - 試したことの結果が来たら、中身もその回のものにする
 *
 * 呼び戻しの長さの上限に「前に駄目だった手」を数える件と、伏せてから切る件（session の中）は、ここでは確かめていない。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { senseDispleasure, displeasureTitle } from '../src/memory/displeasure.ts';
import { Memory, formatRecall } from '../src/memory/memory.ts';

/** 片方だけの字（対の上半分・下半分）が無いか。 */
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('嫌がられた合図', () => {
  test('**普通の依頼を、嫌がられたこととして拾わない**', () => {
    for (const said of [
      'CSVまたはJSONで出せる？',
      'AまたはBか選んで',
      '最悪の場合でも落ちないように',
      'クレーム管理画面を作って',
      '起動が遅いので速くして',
      '壊れたJSONも読めるように',
      'いつもどおりテストして',
      '余計な空白を削って',
      'キャッシュしないで読んで',
    ]) {
      assert.equal(senseDispleasure(said), undefined, `拾った: ${said} → ${JSON.stringify(senseDispleasure(said))}`);
    }
  });

  test('嫌がっている形は、これまでどおり拾う（対）', () => {
    for (const said of ['また同じ間違い？', '最悪', '遅い', '壊れた', 'いつも同じこと言わせるな', '勝手に書き換えしないで', '余計だ']) {
      assert.notEqual(senseDispleasure(said), undefined, `拾っていない: ${said}`);
    }
  });
});

describe('字数で切る所', () => {
  test('**呼び戻しの文に、字の対の片方だけを残さない**', () => {
    const text = formatRecall([{
      id: 'm1', kind: 'fact', title: `${'あ'.repeat(159)}😀`, detail: `${'い'.repeat(159)}😀`, tags: [], at: 0, seenAt: 0, confirms: 1,
    } as never]);
    assert.doesNotMatch(text, LONE);
  });

  test('**嫌がられたことの題に、字の対の片方だけを残さない**', () => {
    assert.doesNotMatch(displeasureTitle('BROKEN', `${'あ'.repeat(39)}😀`), LONE);
  });
});

describe('試したこと', () => {
  test('**結果が新しくなったら、中身もその回のものにする**', () => {
    const m = new Memory();
    m.remember({ kind: 'attempt', title: 'T', detail: '触ったもの: a — 確かめたが通らなかった（長めの説明を足す）', outcome: 'failed' });
    m.remember({ kind: 'attempt', title: 'T', detail: '触ったもの: a — 確かめて通った', outcome: 'worked' });
    const e = m.all().find((x) => x.title === 'T')!;
    assert.equal(e.outcome, 'worked');
    assert.doesNotMatch(e.detail, /通らなかった/, `結果と中身が食い違っている: ${e.detail}`);
  });
});
