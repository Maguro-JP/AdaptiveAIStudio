/** 依頼にファイルを指名する（`@道`）。 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mentionsIn, stripMentions, readMentions, expandMentions, mentionBudget } from '../src/agent/mention.ts';

test('空白でも日本語の助詞でも切れる', () => {
  assert.deepEqual(mentionsIn('@src/a.ts を直して'), ['src/a.ts']);
  assert.deepEqual(mentionsIn('@a.ts と @b.ts'), ['a.ts', 'b.ts']);
  assert.deepEqual(mentionsIn('@a.ts @a.ts'), ['a.ts']);
  assert.deepEqual(mentionsIn('指名なし'), []);
});

test('送る文からは印を外す', () => {
  assert.equal(stripMentions('@src/a.ts を直して'), 'src/a.ts を直して');
});

async function box() {
  const root = await mkdtemp(join(tmpdir(), 'aas-mention-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  return root;
}

test('指名した中身が依頼へ入る', async () => {
  const root = await box();
  const got = await expandMentions('@src/a.ts を直して', root);
  assert.match(got.text, /export const a = 1;/);
  assert.match(got.text, /指名されたファイル/);
  // 中身は前、指示は後ろ。長い中身に指示を押し流させない。
  assert.ok(got.text.indexOf('export const a') < got.text.indexOf('を直して'));
  assert.equal(got.reads[0]?.ok, true);
});

test('作業場の外は読まない', async () => {
  const root = await box();
  const got = await readMentions('@../../etc/passwd を見せて', root);
  assert.equal(got[0]?.ok, false);
  assert.match(got[0]?.body ?? '', /作業場の外/);
});

test('無いものは、無いと言う', async () => {
  const root = await box();
  const got = await readMentions('@src/none.ts', root);
  assert.equal(got[0]?.ok, false);
});

test('フォルダは断る', async () => {
  const root = await box();
  const got = await readMentions('@src', root);
  assert.equal(got[0]?.ok, false);
  assert.match(got[0]?.body ?? '', /フォルダ/);
});

test('長いものは頭だけ渡し、続きがあると言う', async () => {
  const root = await box();
  await writeFile(join(root, 'big.txt'), 'x'.repeat(5000));
  const got = await readMentions('@big.txt', root, { maxBytes: 100 });
  assert.equal(got[0]?.truncated, true);
  assert.equal(got[0]?.body.length, 100);
});

test('全部で一杯になったら、そこで止める', async () => {
  const root = await box();
  await writeFile(join(root, 'p.txt'), 'y'.repeat(200));
  await writeFile(join(root, 'q.txt'), 'z'.repeat(200));
  const got = await readMentions('@p.txt @q.txt', root, { maxBytes: 200, totalBytes: 200 });
  assert.equal(got[0]?.ok, true);
  assert.equal(got[1]?.ok, false);
});

test('指名が無ければ、依頼は素通り', async () => {
  const root = await box();
  const got = await expandMentions('ふつうの依頼', root);
  assert.equal(got.text, 'ふつうの依頼');
});

/**
 * 指名した中身の上限は、**窓から決める。**
 *
 * 固定の文字数（全部で 64,000）にしていたので、窓が 8k のモデルでは
 * それだけで溢れる。指名した中身は、いま書いた依頼の一部なので、
 * **刈る側は落とせない。**落とせないまま窓を超える。
 */
describe('窓に合わせて切る', () => {
  test('窓が狭ければ、上限も小さくなる', () => {
    const narrow = mentionBudget(4096);
    const wide = mentionBudget(32768);
    assert.ok(narrow.total < wide.total, `窓を見ていない: ${narrow.total} / ${wide.total}`);
    // 窓の全部は使わない（依頼と履歴と返事の分が要る）。
    assert.ok(narrow.total < 4096, `窓ぶん全部を指名に使っている: ${narrow.total}`);
  });

  test('一つで使い切らせない（二つ目が空にならない）', () => {
    const b = mentionBudget(8192);
    assert.ok(b.each < b.total, `一つで全部使える: ${b.each} / ${b.total}`);
  });

  test('極端に狭くても、0 にはしない', () => {
    const b = mentionBudget(256);
    assert.ok(b.each > 0 && b.total > 0);
  });

  test('窓を渡すと、そのぶんで切られる', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aas-mention-'));
    await writeFile(join(root, 'big.txt'), 'あ'.repeat(20_000));
    const narrow = await readMentions('@big.txt', root, { contextTokens: 4096 });
    const wide = await readMentions('@big.txt', root, { contextTokens: 32768 });
    assert.equal(narrow[0]?.truncated, true, '狭い窓なのに切っていない');
    assert.ok((narrow[0]?.body.length ?? 0) < (wide[0]?.body.length ?? 0),
      '窓の広さで変わっていない');
  });
});
