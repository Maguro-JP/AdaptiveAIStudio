/**
 * 会話の保存で、中身を失う・取り違える形を止める。
 *
 * 見出しの書き換えは、ファイル全体を読み、一行目を変え、まるごと書き戻していた。その間に足した返事は
 * 古い中身で上書きされて消え、書き戻しの途中で落ちると会話が丸ごと消えた。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { Conversations, titleFrom } from '../src/core/conversations.ts';

async function store() {
  const dir = await tempDir('aas-conv-safe-');
  return { dir, c: new Conversations(dir) };
}

describe('会話の保存を壊さない', () => {
  test('**見出しを変えている間に足した返事を消さない**', async () => {
    // 書き戻しに時間がかかる大きさにする（小さいと、読んでから書くまでの間に足す隙が無い）。
    const { c } = await store();
    let lost = 0;
    for (let i = 0; i < 10; i += 1) {
      const { id } = await c.create();
      await c.append(id, Array.from({ length: 20 }, (_, k) => ({ role: 'user' as const, content: `${'x'.repeat(20000)}${k}` })));
      await Promise.all([c.append(id, [{ role: 'assistant', content: 'a' }]), c.rename(id, `名前${i}`)]);
      await Promise.all([c.rename(id, `名前${i}b`), c.append(id, [{ role: 'assistant', content: 'b' }])]);
      if ((await c.load(id)).length !== 22) lost += 1;
      assert.equal((await c.head(id)).title, `名前${i}b`);
    }
    assert.equal(lost, 0, `見出しの書き換えが、足した返事を消した（10 回中 ${lost} 回）`);
  });

  test('**最初の見出しを付けている間に足した依頼を消さない**', async () => {
    const { c } = await store();
    const { id } = await c.create();
    await Promise.all([c.titleIfUnset(id, '最初の依頼'), c.append(id, [{ role: 'user', content: '最初の依頼' }])]);
    assert.equal((await c.load(id)).length, 1, '見出しを付ける書き戻しが、足した依頼を消した');
    assert.equal((await c.head(id)).title, '最初の依頼');
  });

  test('見出しの書き換えは一時ファイルから置き換え（上書きしない）、一時ファイルを残さない', async () => {
    const { c, dir } = await store();
    const { id } = await c.create();
    const before = (await stat(join(dir, `${id}.jsonl`))).ino;
    await c.rename(id, 'a');
    // 置き換えならファイルの番号が変わる。その場で上書きすると同じ番号のまま（途中で落ちると空になる形）。
    assert.notEqual((await stat(join(dir, `${id}.jsonl`))).ino, before, 'その場で上書きした');
    assert.deepEqual((await readdir(dir)).sort(), [`${id}.jsonl`]);
  });

  test('**自動の見出しと人が付けた名前が重なっても、人の名前を自動の見出しで上書きしない**', async () => {
    const { c } = await store();
    const { id } = await c.create();
    await Promise.all([c.titleIfUnset(id, '自動の見出し'), c.rename(id, '人が付けた名前')]);
    assert.equal((await c.head(id)).title, '人が付けた名前');
  });

  test('**同じ名前で作り直して、既にある会話を空にしない**', async () => {
    const { c } = await store();
    await c.create('same');
    await c.append('same', [{ role: 'user', content: 'keep' }]);
    await assert.rejects(c.create('same'), /既に/);
    assert.equal((await c.load('same')).length, 1, '既にある会話を空にした');
  });

  test('形の合わない行（m が無い・content が文字でない）は捨て、会話を一覧から消さない', async () => {
    const { c, dir } = await store();
    const { id } = await c.create();
    await c.append(id, [{ role: 'user', content: 'hi' }]);
    await appendFile(join(dir, `${id}.jsonl`), '{"t":"msg","at":"x"}\n{"t":"msg","at":"x","m":{"role":"assistant","content":null}}\n');
    assert.deepEqual(await c.load(id), [{ role: 'user', content: 'hi' }]);
    assert.equal((await c.list()).length, 1, '一覧から消えた');
  });

  test('後ろから読むとき、行の頭ちょうどから始まる一行を捨てない', async () => {
    const { c, dir } = await store();
    const { id } = await c.create();
    await c.append(id, [{ role: 'user', content: 'one' }, { role: 'assistant', content: 'two' }]);
    const raw = await readFile(join(dir, `${id}.jsonl`), 'utf8');
    const last = raw.split('\n').filter(Boolean).at(-1)!;
    const tail = await c.load(id, { tailBytes: Buffer.byteLength(`${last}\n`) });
    assert.deepEqual(tail, [{ role: 'assistant', content: 'two' }], '読んだ範囲の端の一通を捨てた');
  });

  test('後ろから読んでツールの結果しか無ければ、宙に浮いた結果を渡さない', async () => {
    const { c, dir } = await store();
    const { id } = await c.create();
    await c.append(id, [{ role: 'user', content: 'u' }, { role: 'tool', content: 'r1', toolCallId: 'a' }, { role: 'tool', content: 'r2', toolCallId: 'b' }]);
    const raw = await readFile(join(dir, `${id}.jsonl`), 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const bytes = Buffer.byteLength(`${lines.slice(-2).join('\n')}\n`);
    assert.deepEqual(await c.load(id, { tailBytes: bytes }), []);
  });

  // 対になっていない代用の字（割れた絵文字）が在るか。
  const broken = (t: string): boolean => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(t);
  test('見出しを切るとき、絵文字を半分に割らない', async () => {
    const t = titleFrom(`${'あ'.repeat(39)}😀です`);
    assert.equal(broken(t), false, `割れた: ${JSON.stringify(t)}`);
    const { c } = await store();
    const { id } = await c.create();
    const named = await c.rename(id, `${'あ'.repeat(39)}😀です`);
    assert.equal(broken(named), false, `割れた: ${JSON.stringify(named)}`);
  });
});
