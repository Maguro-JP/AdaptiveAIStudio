/**
 * 1ターンの結末に、**どのモデルがどれだけの速さだったか**を添える。
 *
 * 「完了 · 182.3秒」とだけ出ていた。8B を CPU で読んでいて一言に 3 分
 * かかっていたとき、遅い理由がどこにも無く、壊れているようにしか見えなかった。
 * 数字は metrics に溜まっていたが、設定の奥で、誰も見ない。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { verdictText, slowNote, SLOW_TPS } from '../src/ui/web/verdict.js';
import { speedOf } from '../src/core/session.ts';

describe('結末の一行', () => {
  test('モデルと速さを、同じ行に出す', () => {
    const line = verdictText({ reason: 'completed', checked: 'notRun', seconds: 12.34, model: 'a.gguf', tps: 4.2 });
    assert.equal(line, '完了（検証していません） · 12.3秒 · a.gguf · 約 4.2 tok/s');
  });

  test('測れていない回は、速さを出さない（でたらめな数字を出さない）', () => {
    const line = verdictText({ reason: 'completed', checked: 'passed', seconds: 0.4, model: 'a.gguf' });
    assert.equal(line, '完了（検証を通りました） · 0.4秒 · a.gguf');
    assert.equal(slowNote({ reason: 'completed', seconds: 0.4, model: 'a.gguf' }), '');
  });

  test('遅ければ、その場で理由を言う', () => {
    const slow = slowNote({ reason: 'completed', seconds: 180, model: 'big-8b.gguf', tps: 1.1 });
    assert.match(slow, /遅い/);
    assert.match(slow, /1\.1 tok\/s/);
    assert.match(slow, /小さいモデル/);
    assert.equal(slowNote({ reason: 'completed', seconds: 10, model: 'a', tps: SLOW_TPS }), '');
  });

  test('失敗した回も、理由の語はそのまま', () => {
    assert.match(verdictText({ reason: 'aborted', seconds: 3 }), /^aborted · 3\.0秒$/);
  });
});

describe('速さの数え方', () => {
  test('文字数から見積もり、metrics と同じ線で切る', () => {
    assert.deepEqual(speedOf('m', 300, 10), { model: 'm', outputTokens: 100, tps: 10 });
    // 一言（20 トークン未満）や 1 秒未満は数えない。非現実的な値になる。
    assert.deepEqual(speedOf('m', 30, 10), { model: 'm', outputTokens: 10 });
    assert.deepEqual(speedOf('m', 300, 0.5), { model: 'm', outputTokens: 100 });
  });
});
