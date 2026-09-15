/**
 * 訊かれただけなのか、作業を頼まれたのかを見分ける。
 *
 * 実機で「明日の天気は？」と打ったら、作業者の決まり（read_file で確認する・
 * write_file には全内容を渡す・終わったら TASK_DONE）が載った状態で 2B へ渡り、
 * 問いをなぞって「完了（検証していません）・36.0秒」と返した。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeChat } from '../src/core/intent.ts';

describe('問いかけとして扱うもの', () => {
  for (const q of [
    '明日の天気は？',
    '1+1=',
    '2 + 2 は？',
    'こんにちは',
    '今日は何日？',
    'ありがとう',
    'TypeScript って何？',
    'おすすめの本ある？',
  ]) {
    test(`「${q}」`, () => assert.equal(looksLikeChat(q), true));
  }
});

describe('作業として扱うもの（**迷ったらこちらへ倒す**）', () => {
  for (const q of [
    'src/a.ts を直して',
    'テストを走らせて',
    'この関数を読んで説明して',
    'README を作って',
    'npm test が落ちる',
    'package.json を見て',
    'ログイン処理を実装して',
    '不要なファイルを消して',
    'fix the parser',
    '```\nconst a = 1\n```\nこれで合ってる？',
  ]) {
    test(`「${q.split('\n')[0]}」`, () => assert.equal(looksLikeChat(q), false));
  }
});

describe('見分けの縁', () => {
  test('空は作業でも問いでもない（false に倒す）', () => {
    assert.equal(looksLikeChat(''), false);
    assert.equal(looksLikeChat('   '), false);
  });

  test('**長いものは作業へ倒す。**説明が続いているとき、問いとして扱わない', () => {
    const long = 'あ'.repeat(200);
    assert.equal(looksLikeChat(long), false);
  });

  test('問いの形でも、作業場のものを指していれば作業', () => {
    assert.equal(looksLikeChat('src/core/session.ts って何してるの？'), false);
  });
});

/**
 * 「作業の動詞に当てはまらない」だけで問いとして扱っていた。
 * 「echo を使って」が問いになり、ツールを取り上げた（自分の試験が先に落とした）。
 * **問いの合図が在るものだけを通す**に倒し直した。
 */
describe('合図が無いものは、作業へ倒す', () => {
  for (const q of ['echo を使って', 'それ', 'お願い', '続き', 'もう一回']) {
    test(`「${q}」は作業`, () => assert.equal(looksLikeChat(q), false));
  }
  for (const q of ['明日の天気を教えて', 'これって何？', 'ありがとう', '1+1=']) {
    test(`「${q}」は問い`, () => assert.equal(looksLikeChat(q), true));
  }
});
