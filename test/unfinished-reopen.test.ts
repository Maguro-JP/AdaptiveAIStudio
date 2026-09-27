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
