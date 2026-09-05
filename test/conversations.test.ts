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
import { Conversations, titleFrom, newId, ID_SHAPE, LIST_LIMIT } from '../src/core/conversations.ts';

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

/**
 * 一覧は、全部を読まない。
 *
 * 一覧は開くたびに作る。**会話が増えるほど重くなる**（540 件で 155ms、
 * 全部のファイルを開いていた）。誰も 540 件を辿らない。
 * 出さないだけで、**消えてはいない**。
 */
describe('一覧に上限を置く', () => {
  test('新しい方から、上限まで', async () => {
    const dir = await tempDir('aas-conv-cap-');
    const c = new Conversations(join(dir, 'conv'));
    const ids: string[] = [];
    for (let i = 0; i < LIST_LIMIT + 20; i += 1) {
      const head = await c.create();
      ids.push(head.id);
      await c.append(head.id, [{ role: 'user', content: `依頼${i}` }]);
    }
    const list = await c.list();
    assert.equal(list.length, LIST_LIMIT, `上限が効いていない: ${list.length}`);
    // 新しい方が残っていること。
    assert.ok(list.some((h) => h.id === ids[ids.length - 1]), '新しいものが出ていない');
    assert.ok(!list.some((h) => h.id === ids[0]), '古いものまで出している');
  });

  test('同じ秒に続けて作っても、順番が戻らない', () => {
    // 秒までしか時刻が入らないので、末尾の乱数だけで並びが決まっていた。
    const ids = Array.from({ length: 500 }, () => newId());
    for (let i = 1; i < ids.length; i += 1) {
      assert.ok(ids[i]! > ids[i - 1]!, `順が戻った: ${ids[i - 1]} → ${ids[i]}`);
    }
    assert.equal(new Set(ids).size, ids.length, '同じ名前を配っている');
  });

  test('末尾を使い切っても、同じ名前を配らない', () => {
    // **一度これで会話が消えた。**使い切った後に同じ名前で頭打ちにしたので、
    // 作るたびに同じファイルを上書きしていた（106 件作って 1 件しか残らない）。
    const at = new Date(2026, 8, 3, 12, 0, 0);
    const top = () => newId(at, () => 0.999999);
    const ids = Array.from({ length: 50 }, top);
    for (let i = 1; i < ids.length; i += 1) {
      assert.ok(ids[i]! > ids[i - 1]!, `順が戻った: ${ids[i - 1]} → ${ids[i]}`);
    }
    assert.equal(new Set(ids).size, ids.length, '同じ名前を配っている');
    for (const id of ids) assert.ok(ID_SHAPE.test(id), `形が違う: ${id}`);
  });

  test('**出していないだけで、消えてはいない**', async () => {
    const dir = await tempDir('aas-conv-keep-');
    const c = new Conversations(join(dir, 'conv'));
    const first = await c.create();
    await c.append(first.id, [{ role: 'user', content: '最初の話' }]);
    for (let i = 0; i < LIST_LIMIT + 5; i += 1) {
      const head = await c.create();
      await c.append(head.id, [{ role: 'user', content: `依頼${i}` }]);
    }
    assert.equal(await c.count(), LIST_LIMIT + 6, '数え方が違う');
    // 一覧に出ていなくても、開けば読める。
    const back = await c.load(first.id);
    assert.equal(back[0]?.content, '最初の話');
  });

  test('少ないうちは、そのまま全部出す', async () => {
    const dir = await tempDir('aas-conv-few-');
    const c = new Conversations(join(dir, 'conv'));
    for (let i = 0; i < 3; i += 1) {
      const head = await c.create();
      await c.append(head.id, [{ role: 'user', content: `依頼${i}` }]);
    }
    assert.equal((await c.list()).length, 3);
  });
});

/**
 * 一覧のために、ファイルを丸ごと読まない。
 *
 * 半年ひとつの会話を続けると 16.6MB になり、見出しを作るだけで 177ms
 * かかっていた（読むだけで 90ms。数え方を速くしても効かない）。
 * 一覧は最大 100 件読むので、**長く使うほど開けなくなる。**
 *
 * 正しく数える必要があるのは**小さいうちだけ**（空かどうかの判定）。
 * 多い側は「たくさん」で足りる。
 */
describe('見出しは、頭だけ読む', () => {
  /** 長い会話を作る。往復ごとに道具の結果を挟む。 */
  async function long(c: Conversations, id: string, rounds: number): Promise<void> {
    const batch = [];
    for (let i = 0; i < 20; i += 1) {
      batch.push({ role: 'user' as const, content: `依頼${i}` });
      batch.push({ role: 'tool' as const, content: '中身'.repeat(500), toolCallId: String(i) });
      batch.push({ role: 'assistant' as const, content: `返事${i}` });
    }
    for (let r = 0; r < rounds; r += 1) await c.append(id, batch);
  }

  test('小さいうちは、正確に数える', async () => {
    const { c } = await store();
    const { id } = await c.create();
    await c.append(id, [
      { role: 'user', content: 'ひとつめ' },
      { role: 'assistant', content: '返事' },
    ]);
    const head = await c.head(id);
    assert.equal(head.messages, 2);
    assert.equal(head.more, undefined, '小さいのに数え切れていないと言っている');
  });

  test('**空の判定は、正確なまま**', async () => {
    // ここが狂うと、押すたびに空の会話が増える（一覧が空の見出しで埋まる）。
    const { c } = await store();
    const { id } = await c.create();
    assert.equal((await c.head(id)).messages, 0);
  });

  test('大きくなったら、数え切れていないと言う', async () => {
    const { c } = await store();
    const { id } = await c.create();
    await long(c, id, 30);
    const head = await c.head(id);
    assert.equal(head.more, true, '全部読んでいる（または言っていない）');
    assert.ok(head.messages > 0, '空だと言っている');
    assert.equal(head.title, '新しい会話', '見出しが取れていない');
  });

  test('**大きくなっても、かかる時間が比例して増えない**', async () => {
    const { c } = await store();
    const at = async (rounds: number): Promise<number> => {
      const { id } = await c.create();
      await long(c, id, rounds);
      await c.head(id); // 温めてから測る
      const t0 = process.hrtime.bigint();
      await c.head(id);
      return Number(process.hrtime.bigint() - t0) / 1e6;
    };
    const small = Math.max(await at(5), 0.5);
    const large = await at(50);
    assert.ok(
      large / small < 5,
      `10 倍の大きさで ${(large / small).toFixed(1)} 倍かかっている（丸ごと読んでいる）`,
    );
  });
});
