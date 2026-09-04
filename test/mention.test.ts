/** 依頼にファイルを指名する（`@道`）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mentionsIn, stripMentions, readMentions, expandMentions } from '../src/agent/mention.ts';

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
