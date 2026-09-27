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
import { writeFile, readFile, readdir, mkdir, rm } from 'node:fs/promises';
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

describe('歩幅の記録ファイル', () => {
  const good = { size: 'medium', streak: 1, ok: 4, ng: 0 };
  for (const [name, text] of [['null', 'null'], ['文字', '"x"'], ['配列', '[1]']] as const) {
    test(`**記録が${name}でも止めず、測ったら書き直す**`, async () => {
      const dir = await tempDir('aas-stride-f-');
      const path = join(dir, 'stride.json');
      await writeFile(path, text);
      const book = new StrideBook(path);
      assert.equal((await book.get('m', 8192)).size, 'small');
      await book.record('m', 8192, true);
      assert.equal((JSON.parse(await readFile(path, 'utf8')) as Record<string, { ok: number }>).m!.ok, 1);
    });
  }

  test('**形の違う一件（null・知らない歩幅・数でない回数）は除き、正しい一件は使う**', async () => {
    const dir = await tempDir('aas-stride-f-');
    const path = join(dir, 'stride.json');
    await writeFile(path, JSON.stringify({ a: null, b: { ...good, size: 'huge' }, c: { ...good, ok: 'many' }, k: good }));
    const book = new StrideBook(path);
    assert.deepEqual(Object.keys(await book.all()), ['k']);
    assert.equal((await book.get('b', 1000)).size, 'tiny', '知らない歩幅をそのまま使った');
    assert.equal((await book.record('c', 1000, true)).ok, 1);
  });

  for (const [field, bad] of [['streak', '1'], ['ok', -1], ['ng', '5'], ['ng', 1.5], ['size', 'huge']] as const) {
    test(`**${field} が ${JSON.stringify(bad)} の一件は使わない**（使うと、足したときに文字や端数の回数になる）`, async () => {
      const dir = await tempDir('aas-stride-f-');
      const path = join(dir, 'stride.json');
      await writeFile(path, JSON.stringify({ k: { ...good, [field]: bad } }));
      const book = new StrideBook(path);
      assert.deepEqual(await book.all(), {});
      const r = await book.record('k', 8192, false);
      assert.deepEqual([r.size, r.streak, r.ok, r.ng], ['tiny', 0, 0, 1]);
    });
  }

  test('**入れ物が受け継いだ名前（constructor・toString）も、ただのモデル名として扱う**', async () => {
    const dir = await tempDir('aas-stride-f-');
    const path = join(dir, 'stride.json');
    assert.equal((await new StrideBook(join(dir, 'none.json')).get('toString', 8192)).size, 'small');
    await mkdir(path); // 読めない（EISDIR）
    const book = new StrideBook(path);
    await book.record('m', 8192, true);
    await rm(path, { recursive: true });
    await writeFile(path, JSON.stringify({ constructor: good }));
    await book.record('m', 8192, true);
    const saved = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    assert.deepEqual(saved.constructor, good, '受け継いだ名前の記録を取り込まずに落とした');
  });

  test('**在るのに読めないときは書かない。読めたら、測っていないモデルの分を残して書く**', async () => {
    const dir = await tempDir('aas-stride-f-');
    const path = join(dir, 'stride.json');
    await mkdir(path); // 読めない（EISDIR）
    const book = new StrideBook(path);
    await book.record('m', 8192, true);
    await rm(path, { recursive: true });
    await writeFile(path, JSON.stringify({ k: good, m: { ...good, ok: 99 } }));
    await book.record('m', 8192, true);
    const saved = JSON.parse(await readFile(path, 'utf8')) as Record<string, { ok: number }>;
    assert.deepEqual(saved.k, good, '読めなかった間の空で上書きした');
    assert.equal(saved.m!.ok, 2, '測った分より古い記録を取った');
    assert.deepEqual(await readdir(dir), ['stride.json']);
  });

  test('**並んで測っても数え落とさない**', async () => {
    const dir = await tempDir('aas-stride-f-');
    const path = join(dir, 'stride.json');
    const book = new StrideBook(path);
    await Promise.all(Array.from({ length: 5 }, () => book.record('m', 8192, false)));
    assert.equal((await new StrideBook(path).get('m', 8192)).ng, 5);
  });
});
