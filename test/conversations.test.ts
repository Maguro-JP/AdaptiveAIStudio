/**
 * 会話を残す部分の検査。
 *
 * ここまで、やりとりはメモリの中だけだった。窓を閉じれば消えていた。
 * 「一覧に出す」「開き直す」が成り立つかを、ここで留める。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { Conversations, titleFrom, newId, ID_SHAPE } from '../src/core/conversations.ts';

async function store(): Promise<{ c: Conversations; dir: string }> {
  const dir = join(await tempDir('aas-conv-'), 'conversations');
  return { c: new Conversations(dir), dir };
}

describe('会話を残す', () => {
  test('作って、足して、読み直せる', async () => {
    const { c } = await store();
    const head = await c.create();
    await c.append(head.id, [
      { role: 'user', content: 'こんにちは' },
      { role: 'assistant', content: 'こんばんは' },
    ]);
    const back = await c.load(head.id);
    assert.deepEqual(back.map((m) => m.content), ['こんにちは', 'こんばんは']);
  });

  test('見出しは最初の依頼から。あとから書き換えない', async () => {
    // 途中の依頼で書き換わると、一覧の見出しが会話の途中を指す。
    const { c } = await store();
    const { id } = await c.create();
    await c.titleIfUnset(id, 'llama-server を用意して');
    await c.titleIfUnset(id, '次はこれ');
    assert.equal((await c.head(id)).title, 'llama-server を用意して');
  });

  test('長い依頼は切る', () => {
    assert.equal(titleFrom('あ'.repeat(80)).length, 41, '切っていない');
    assert.equal(titleFrom('\n\n  二行目が中身  \n'), '二行目が中身');
    assert.equal(titleFrom('   '), '新しい会話');
  });

  test('新しいものが上に来る', async () => {
    const { c } = await store();
    const a = await c.create('c20260101-000000-aaaa');
    const b = await c.create('c20260101-000001-bbbb');
    // 更新の時刻で並べる。触った方を上に。
    await new Promise((r) => setTimeout(r, 20));
    await c.append(a.id, [{ role: 'user', content: 'あとから触った' }]);
    const ids = (await c.list()).map((h) => h.id);
    assert.deepEqual(ids, [a.id, b.id], `並びが違う: ${ids.join(',')}`);
  });

  test('数えるのは人と返事だけ', async () => {
    const { c } = await store();
    const { id } = await c.create();
    await c.append(id, [
      { role: 'user', content: 'やって' },
      { role: 'assistant', content: '', toolCalls: [{ id: '1', name: 'read_file', args: {} }] },
      { role: 'tool', content: '中身', toolCallId: '1' },
      { role: 'assistant', content: 'できました' },
    ]);
    assert.equal((await c.head(id)).messages, 2);
    // 読み直すときは、道具のやりとりも含めて全部返す（続きを話すのに要る）。
    assert.equal((await c.load(id)).length, 4);
  });

  test('壊れた行は捨てて、読める分を返す', async () => {
    // 書いている最中に落ちると、途中までの行が残る。全部を失わせない。
    const { c, dir } = await store();
    const { id } = await c.create();
    await c.append(id, [{ role: 'user', content: '一つ目' }]);
    await writeFile(join(dir, `${id}.jsonl`), '{"t":"msg","m":{"role":"user","content":"欠け', { flag: 'a' });
    await c.append(id, [{ role: 'assistant', content: '二つ目' }]);
    assert.deepEqual((await c.load(id)).map((m) => m.content), ['一つ目', '二つ目']);
  });

  test('名前に道を混ぜたものは受け取らない', async () => {
    const { c } = await store();
    for (const bad of ['../x', 'a/b', 'a\\b', '.', '', 'x'.repeat(65)]) {
      assert.equal(ID_SHAPE.test(bad), false, `形として通ってしまう: ${bad}`);
      await assert.rejects(c.append(bad, [{ role: 'user', content: 'x' }]), /使えません/, bad);
      await assert.rejects(c.remove(bad), /使えません/, bad);
    }
  });

  test('消せる。無いものを消しても落ちない', async () => {
    const { c } = await store();
    const { id } = await c.create();
    await c.remove(id);
    await c.remove(id);
    assert.deepEqual(await c.list(), []);
  });

  test('まだ一度も話していなければ、空', async () => {
    const { c } = await store();
    assert.deepEqual(await c.list(), []);
  });

  test('会話でないファイルは見ない', async () => {
    const { c, dir } = await store();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'メモ.txt'), 'x');
    await writeFile(join(dir, '../外.jsonl'), 'x');
    assert.deepEqual(await c.list(), []);
  });

  test('id は並べれば時刻順になる', () => {
    const at = (h: number) => newId(new Date(2026, 8, 3, h, 0, 0), () => 0.5);
    assert.ok(at(9) < at(10), '順番にならない');
    assert.ok(ID_SHAPE.test(at(9)), `形が違う: ${at(9)}`);
  });

  test('読めないものは一覧から落ちるだけで、他は出る', async () => {
    const { c, dir } = await store();
    const ok = await c.create();
    await writeFile(join(dir, 'c20260101-000000-zzzz.jsonl'), '壊れています\n');
    const ids = (await c.list()).map((h) => h.id);
    assert.ok(ids.includes(ok.id), '読めるものまで消えている');
  });
});
