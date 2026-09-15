/**
 * 歩幅 — そのモデルが、一歩でどこまでやれるか。
 *
 * ここまで、依頼の大きさは**人が決めたまま**渡していた。
 * そして**落ちたときに同じ大きさで挑み直していた**。
 * 通らなかったものを、もう一度そのまま渡しても通らない。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import {
  StrideBook, nextStride, firstStride, guideFor, strideText, type StrideRecord,
} from '../src/agent/stride.ts';

const at = (size: StrideRecord['size']): StrideRecord => ({ size, streak: 0, ok: 0, ng: 0 });

describe('歩幅の決め方', () => {
  test('落ちたら、すぐ狭める', () => {
    // 落ちる方が高くつく（やり直しの時間も、壊れたものを戻す手間も）。
    assert.equal(nextStride(at('large'), false).size, 'medium');
    assert.equal(nextStride(at('medium'), false).size, 'small');
    assert.equal(nextStride(at('small'), false).size, 'tiny');
  });

  test('いちばん狭いところより下へは行かない', () => {
    assert.equal(nextStride(at('tiny'), false).size, 'tiny');
  });

  test('広げるのは、三回続けて通ってから', () => {
    // 一度通っただけで広げると、たまたま通った一回で元へ戻る。
    let s = at('small');
    s = nextStride(s, true);
    assert.equal(s.size, 'small', '一回で広げている');
    s = nextStride(s, true);
    assert.equal(s.size, 'small', '二回で広げている');
    s = nextStride(s, true);
    assert.equal(s.size, 'medium', '三回続けても広がらない');
  });

  test('連勝は、一度落ちたら消える', () => {
    let s = at('small');
    s = nextStride(s, true);
    s = nextStride(s, true);
    s = nextStride(s, false);
    assert.equal(s.streak, 0);
    s = nextStride(s, true);
    s = nextStride(s, true);
    assert.equal(s.size, 'tiny', '落ちた後も連勝を持ち越している');
  });

  test('いちばん広いところより上へは行かない', () => {
    let s = at('large');
    for (let i = 0; i < 10; i += 1) s = nextStride(s, true);
    assert.equal(s.size, 'large');
  });

  test('測る前は、窓の広さから見当をつける', () => {
    // 見当が外れても、一回落ちれば狭まる。**外れる前提で置く。**
    assert.equal(firstStride(4096), 'tiny');
    assert.equal(firstStride(8192), 'small');
    assert.equal(firstStride(32_768), 'medium');
    assert.equal(firstStride(128_000), 'large');
  });

  test('歩幅ごとに、分解の目安が違う', () => {
    // 狭いほど、段の数は多くなる。
    assert.ok(guideFor('tiny').steps > guideFor('large').steps);
    assert.ok(guideFor('tiny').text.includes('1箇所'));
    assert.ok(guideFor('large').text.length > 0);
    for (const s of ['tiny', 'small', 'medium', 'large'] as const) {
      assert.ok(strideText(s).length > 0, s);
    }
  });
});

describe('歩幅を覚える', () => {
  test('モデルごとに覚える。置き場に残る', async () => {
    const dir = await tempDir('aas-stride-');
    const path = join(dir, 'stride.json');
    const book = new StrideBook(path);
    await book.record('小さいの.gguf', 8192, false);
    // 別の器から読み直しても残っていること。
    const again = new StrideBook(path);
    assert.equal((await again.get('小さいの.gguf', 8192)).size, 'tiny');
    // 触っていないモデルは、見当のまま。
    assert.equal((await again.get('別のもの.gguf', 32_768)).size, 'medium');
  });

  test('通った跡で測る。数も残る', async () => {
    const dir = await tempDir('aas-stride2-');
    const book = new StrideBook(join(dir, 'stride.json'));
    await book.record('m', 8192, true);
    await book.record('m', 8192, true);
    const r = await book.record('m', 8192, false);
    assert.equal(r.ok, 2);
    assert.equal(r.ng, 1);
    assert.equal(r.size, 'tiny', '落ちたのに狭めていない');
  });
});
