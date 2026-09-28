/**
 * やめたやり残しを戻す。**元の依頼の文は、やり残しの記録にしか無い。**
 *
 * 画面の「×」は一押しで効き、取り消せなかった。押し間違えると、長く書いた依頼を打ち直すしかない。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { UnfinishedWork, BACKOFF_MS, MAX_OPEN } from '../src/core/unfinished.ts';

async function store(): Promise<{ w: UnfinishedWork; path: string }> {
  const dir = await tempDir('aas-unf-reopen-');
  const path = join(dir, 'unfinished.jsonl');
  return { w: new UnfinishedWork(path), path };
}

const item = { request: 'src を直して\n型も合わせて', why: 'maxTurns' as const, note: '40ターン' };

describe('やめたやり残しを戻す', () => {
  test('**やめたものを戻すと、同じ番号・同じ依頼・同じやり直しの回数で戻る**', async () => {
    const { w } = await store();
    const added = (await w.add(item, 1000))!;
    await w.bump(added.id, 2000);
    const before = (await w.list())[0]!;
    await w.cancel(added.id);
    assert.equal((await w.list()).length, 0);
    assert.equal(await w.reopen(added.id, 3000), 'reopened');
    assert.deepEqual(await w.list(), [{ ...before, nextAt: Math.max(before.nextAt, 3000 + BACKOFF_MS[0]!) }]);
  });

  test('**戻したとたんに走り出さない**（手を付ける時刻が過ぎていたら、最初の間を置く）', async () => {
    const { w } = await store();
    const added = (await w.add(item, 1000))!; // 手を付けてよいのは 1000 + 60 秒から
    await w.cancel(added.id);
    const now = 10 * 60_000;
    assert.equal(await w.reopen(added.id, now), 'reopened');
    assert.equal(await w.due(now), undefined, '戻したとたんに手を付ける');
    assert.equal((await w.due(now + BACKOFF_MS[0]!))?.id, added.id);
  });

  test('抱えている数が上限なら戻さない（戻したものは古いので、次に新しく記録したときに真っ先に落ちる）', async () => {
    const { w } = await store();
    const first = (await w.add({ ...item, request: 'やめるもの' }, 1))!;
    await w.cancel(first.id);
    for (let i = 0; i < MAX_OPEN; i += 1) await w.add({ ...item, request: `依頼 ${i}` }, 2 + i);
    assert.equal((await w.list()).length, MAX_OPEN);
    assert.equal(await w.reopen(first.id), 'full');
    assert.equal((await w.list()).length, MAX_OPEN);
  });

  test('やめた後に片づいた・諦めたと書かれたものは戻さない', async () => {
    const { w, path } = await store();
    const added = (await w.add(item))!;
    await w.cancel(added.id);
    await appendFile(path, `${JSON.stringify({ t: 'close', id: added.id, how: 'done' })}\n`);
    assert.equal(await w.reopen(added.id), 'gone');
  });

  test('**読めないときは「無い」と言わずに投げる**（戻す口を下げさせない）', async () => {
    const dir = await tempDir('aas-unf-reopen-dir-');
    const w = new UnfinishedWork(dir); // フォルダを読むと EISDIR
    await assert.rejects(() => w.reopen('u-1'));
  });

  test('抱えているものは戻すまでもない。二度押しても二つにならない', async () => {
    const { w } = await store();
    const added = (await w.add(item))!;
    await w.cancel(added.id);
    assert.equal(await w.reopen(added.id), 'reopened');
    assert.equal(await w.reopen(added.id), 'open');
    assert.equal((await w.list()).length, 1);
  });

  test('片づいたもの・諦めたものは戻さない（やめたものだけ）', async () => {
    const { w } = await store();
    const a = (await w.add({ ...item, request: 'ひとつめ' }))!;
    const b = (await w.add({ ...item, request: 'ふたつめ' }))!;
    await w.done(a.id);
    for (let i = 0; i < 5; i += 1) await w.bump(b.id);
    assert.equal((await w.list()).length, 0, '前提: 諦めて閉じている');
    assert.equal(await w.reopen(a.id), 'gone');
    assert.equal(await w.reopen(b.id), 'gone');
    assert.equal(await w.reopen('u-none'), 'gone');
  });

  test('やめた後に同じ依頼をもう一度記録していたら、二つにしない', async () => {
    const { w } = await store();
    const first = (await w.add(item))!;
    await w.cancel(first.id);
    await w.add(item);
    assert.equal(await w.reopen(first.id), 'duplicate');
    assert.equal((await w.list()).filter((u) => u.request === item.request).length, 1);
  });

  test('戻した後にまたやめても、また戻せる', async () => {
    const { w } = await store();
    const added = (await w.add(item))!;
    await w.cancel(added.id);
    await w.reopen(added.id);
    await w.cancel(added.id);
    assert.equal((await w.list()).length, 0);
    assert.equal(await w.reopen(added.id), 'reopened');
    assert.equal((await w.list()).length, 1);
  });

  test('**区切りより後にやめて、まだ戻せるものを、やめた新しい順に並べる**', async () => {
    const { w, path } = await store();
    const a = (await w.add({ ...item, request: '一つ目\n二行目' }, 1))!;
    const b = (await w.add({ ...item, request: '二つ目' }, 2))!;
    const c = (await w.add({ ...item, request: '三つ目' }, 3))!;
    const old = (await w.add({ ...item, request: '前の起動でやめた' }, 4))!;
    await w.cancel(old.id, { byUser: true, now: 500 });
    await w.cancel(a.id, { byUser: true, now: 1000 });
    await w.cancel(b.id, { byUser: true, now: 1000 }); // 同じ時刻でも、後にやめた方が先
    await w.cancel(c.id, { byUser: true, now: 1100 });
    assert.deepEqual((await w.canceledSince(1000)).map((x) => [x.id, x.request, x.at]),
      [[c.id, '三つ目', 1100], [b.id, '二つ目', 1000], [a.id, '一つ目\n二行目', 1000]]);
    assert.deepEqual((await w.canceledSince(1000, 2)).map((x) => x.id), [c.id, b.id], '上限を守っていない');
    // 戻したもの・片づいたと書かれたものは並べない
    assert.equal(await w.reopen(b.id), 'reopened');
    await appendFile(path, `${JSON.stringify({ t: 'close', id: c.id, how: 'done' })}\n`);
    assert.deepEqual((await w.canceledSince(1000)).map((x) => x.id), [a.id]);
    // 戻した後にまたやめたら、いちばん新しい
    await w.cancel(b.id, { byUser: true, now: 900 });
    assert.deepEqual((await w.canceledSince(0)).map((x) => x.id), [b.id, a.id, old.id]);
  });

  test('**本体が自分で閉じた分（利用者が押していない）は並べない**が、番号で戻せるまま', async () => {
    const { w } = await store();
    const mine = (await w.add({ ...item, request: '利用者がやめた' }, 1))!;
    const stuck = (await w.add({ ...item, request: '段が塞がって止めた' }, 2))!;
    await w.cancel(mine.id, { byUser: true, now: 10 });
    await w.cancel(stuck.id);
    assert.deepEqual((await w.canceledSince(0)).map((x) => x.id), [mine.id]);
    assert.equal(await w.reopen(stuck.id), 'reopened');
  });

  test('前の版が書いた（時刻の無い・形の違う時刻の）やめた行は並べないが、戻せるまま', async () => {
    const { w, path } = await store();
    const a = (await w.add(item))!;
    await appendFile(path, `${JSON.stringify({ t: 'close', id: a.id, how: 'canceled' })}\n`);
    const b = (await w.add({ ...item, request: '別の依頼' }))!;
    await appendFile(path, `${JSON.stringify({ t: 'close', id: b.id, how: 'canceled', at: 'きのう' })}\n`);
    assert.deepEqual(await w.canceledSince(0), []);
    assert.equal((await w.list()).length, 0, '形の違う時刻で、やめたものが戻った');
    assert.equal(await w.reopen(a.id), 'reopened');
    assert.equal(await w.reopen(b.id), 'reopened');
  });

  test('戻せないもの（同じ依頼をもう一度抱えている・上限まで抱えている）は並べない', async () => {
    const { w } = await store();
    const a = (await w.add({ ...item, request: '同じ依頼' }, 1))!;
    await w.cancel(a.id, { byUser: true, now: 10 });
    await w.add({ ...item, request: '同じ依頼' }, 2);
    assert.deepEqual(await w.canceledSince(0), []);
    const { w: full } = await store();
    const first = (await full.add({ ...item, request: 'やめるもの' }, 1))!;
    await full.cancel(first.id, { byUser: true, now: 10 });
    assert.equal((await full.canceledSince(0)).length, 1);
    for (let i = 0; i < MAX_OPEN; i += 1) await full.add({ ...item, request: `依頼 ${i}` }, 2 + i);
    assert.deepEqual(await full.canceledSince(0), []);
  });

  test('記録を畳んだ後は、やめたものは戻らないと言う', async () => {
    const { w, path } = await store();
    const gone = (await w.add({ ...item, request: 'やめるもの' }))!;
    await w.cancel(gone.id);
    // 畳むのは、行が溜まったとき（200 行を超えたとき）に新しく記録したとき
    await appendFile(path, '{"t":"noise"}\n'.repeat(210));
    await w.add({ ...item, request: '次のもの' });
    assert.equal(await w.reopen(gone.id), 'gone');
  });
});
