/**
 * 検索結果を、本文を読んで並べ直す（rerank）。
 *
 * `scoreFiles` は索引の head（冒頭 600 字＋コメント 2400 字）しか見ていない。
 * **本文にだけ答えがあるファイルは、そこでは当たらない。**
 * このリポジトリの履歴 200 件では、repo map に入らなかった 209 件のうち
 * 56 件（27%）がこれだった。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { buildIndex } from '../src/agent/code-index.ts';
import { rerankByBody, rerankShare } from '../src/agent/rerank.ts';

/**
 * 答えが本文にだけあるファイルを持つリポジトリ。
 *
 * `head` は冒頭 600 字とコメントなので、そこに入らないよう、
 * 探す語はずっと後ろの、コメントでない行に置く。
 */
async function project(): Promise<string> {
  const root = await tempDir('aas-rerank-');
  await mkdir(join(root, 'src'), { recursive: true });
  const filler = Array.from({ length: 40 }, (_, i) => `export function pad${i}() { return ${i}; }`).join('\n');
  await writeFile(join(root, 'src', 'deep.ts'),
    `${filler}\nexport function handleWebhookRetry() { return 1; }\n`, 'utf8');
  await writeFile(join(root, 'src', 'other.ts'),
    'export function unrelated() { return 2; }\n', 'utf8');
  return root;
}

describe('本文にだけある答えを、引き上げる', () => {
  test('**head に無くても、本文に在れば点が付く**', async () => {
    const index = await buildIndex(await project());
    const at = index.files.findIndex((f) => f.path === 'src/deep.ts');
    assert.ok(at >= 0);
    assert.ok(!index.files[at]!.head.includes('handleWebhookRetry'),
      'この試験の前提が崩れている（head に入ってしまっている）');

    const seed = new Map([[at, 1]]);
    const after = await rerankByBody(index, 'handleWebhookRetry', seed, 1);
    assert.ok((after.get(at) ?? 0) > 1, '本文に在るのに、点が上がっていない');
  });

  test('元の点は下げない。足すだけ（対）', async () => {
    const index = await buildIndex(await project());
    const a = index.files.findIndex((f) => f.path === 'src/deep.ts');
    const b = index.files.findIndex((f) => f.path === 'src/other.ts');
    const seed = new Map([[a, 1], [b, 5]]);
    const after = await rerankByBody(index, 'handleWebhookRetry', seed, 1);
    assert.ok((after.get(b) ?? 0) >= 5, '当たらなかった方の点を下げている');
  });

  test('当たらなければ、そのまま返す', async () => {
    const index = await buildIndex(await project());
    const at = index.files.findIndex((f) => f.path === 'src/deep.ts');
    const seed = new Map([[at, 1]]);
    const after = await rerankByBody(index, 'zzzzznotfound', seed, 1);
    assert.deepEqual([...after], [...seed]);
  });

  test('**上位だけ読む。下位は読みに行かない**', async () => {
    const index = await buildIndex(await project());
    const a = index.files.findIndex((f) => f.path === 'src/deep.ts');
    const b = index.files.findIndex((f) => f.path === 'src/other.ts');
    // deep.ts の点を低くして、上位 1 件から外す。
    const seed = new Map([[a, 1], [b, 100]]);
    const after = await rerankByBody(index, 'handleWebhookRetry', seed, 1, 1);
    assert.equal(after.get(a), 1, '上位に入っていないものまで読んでいる');
  });
});

describe('効かせ方は、repo map の予算で決める', () => {
  /**
   * 数件しか見せられないときほど、上位の精度が効く。ほとんどのファイルを
   * 見せられるなら、並べ直しても入れ替わるだけで、入っていたものを押し出す。
   * 常に強く効かせると、予算 8000 で 84.8% → 82.4% に落ちた（実測）。
   */
  test('狭いほど強く、広いほど効かせない', () => {
    assert.equal(rerankShare(1000), 1);
    assert.equal(rerankShare(2000), 1);
    assert.equal(rerankShare(8000), 0);
    assert.equal(rerankShare(16000), 0);
    const middle = rerankShare(5000);
    assert.ok(middle > 0 && middle < 1, `間が効いていない: ${middle}`);
  });

  test('間は、なだらかに落ちる（対）', () => {
    assert.ok(rerankShare(3000) > rerankShare(6000),
      '広い方が強く効いている');
  });

  test('効かせないときは、読みにも行かない', async () => {
    const index = await buildIndex(await project());
    const at = index.files.findIndex((f) => f.path === 'src/deep.ts');
    const seed = new Map([[at, 1]]);
    const after = await rerankByBody(index, 'handleWebhookRetry', seed, 0);
    assert.equal(after, seed, 'share が 0 でも並べ直している');
  });
});
