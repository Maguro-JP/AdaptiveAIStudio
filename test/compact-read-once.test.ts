/**
 * 追記式の記録（やり残し・段取り）を畳むとき、一度だけ読み、読めた同じ中身から書き直す。
 *
 * 前は二度読んでいた（行を数える・生きている分を解く）。二度目だけが一瞬読めない（EBUSY）と空として読み、その空で書き戻して
 * 全部消した。ここでは、畳みまでに読む回数を決めておき（下の `READS`）、それを超えた読み込みを全部失敗させる。余分に読むと、
 * その読み込みが空になる。読む回数が変わったら（読む所を足した・減らした）、この数を見直す。数を合わせるだけで通さない。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { UnfinishedWork } from '../src/core/unfinished.ts';
import { Goals, COMPACT_AFTER_LINES } from '../src/core/goals.ts';

/** 読んだ回数を数える手と、`failFrom` 回目から先を EBUSY にする手。 */
function reader(failFrom = Infinity): { read: (p: string) => Promise<string>; count: () => number } {
  let n = 0;
  return {
    read: async (p) => {
      n += 1;
      if (n >= failFrom) throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
      return readFile(p, 'utf8');
    },
    count: () => n,
  };
}

/** 足す・立てるから畳み終わるまでに読む回数。畳みは一度だけ読む。 */
const READS = { unfinishedAdd: 4, goalsOpen: 2 };

const item = (i: number) => ({ request: `依頼 ${i}`, why: 'maxTurns' as const, note: 'n' });

test('**やり残しを畳むとき、読めた同じ中身から書き直す**（二度目の読み込みが空でも消さない）', async () => {
  const dir = await tempDir('aas-compact-unf-');
  const path = join(dir, 'unfinished.jsonl');
  const seed = new UnfinishedWork(path);
  for (let i = 0; i < 5; i += 1) await seed.add(item(i), 1000 + i);
  // 畳む目安（200 行）を超えるように、効き目の無い閉じる行を足す
  const filler = Array.from({ length: 300 }, () => JSON.stringify({ t: 'close', id: 'u-none', how: 'done' })).join('\n');
  await writeFile(path, `${await readFile(path, 'utf8')}${filler}\n`);
  const copy = join(dir, 'copy.jsonl');
  await copyFile(path, copy);

  // 写しで、畳みまでに要る読み込みの回数を数える
  const probe = reader();
  await new UnfinishedWork(copy, { read: probe.read }).add(item(99), 2000);
  const needed = probe.count();
  assert.ok((await readFile(copy, 'utf8')).split('\n').length < 100, '写しで畳んでいない（この試験の前提が崩れた）');
  assert.equal(needed, READS.unfinishedAdd, '畳みまでに読む回数が変わった（二度読みに戻っていないか見て、この数を見直す）');

  // 本物で、要る回数を超えた読み込みを全部失敗させる
  const w = new UnfinishedWork(path, { read: reader(needed + 1).read });
  await w.add(item(99), 2000);
  const left = await new UnfinishedWork(path).list();
  assert.deepEqual(left.map((u) => u.request), ['依頼 0', '依頼 1', '依頼 2', '依頼 3', '依頼 4', '依頼 99'], '畳んで中身を消した');
});

test('**段取りを畳むとき、読めた同じ中身から書き直す**（二度目の読み込みが空でも消さない）', async () => {
  const dir = await tempDir('aas-compact-goals-');
  const path = join(dir, 'goals.jsonl');
  const seed = new Goals(path);
  const kept = [];
  for (let i = 0; i < 3; i += 1) kept.push((await seed.open(`段取り ${i}`, ['一', '二'], 1000 + i)).id);
  const filler = Array.from({ length: COMPACT_AFTER_LINES + 10 }, () => JSON.stringify({ t: 'close', goalId: 'g-none' })).join('\n');
  await writeFile(path, `${await readFile(path, 'utf8')}${filler}\n`);
  const copy = join(dir, 'copy.jsonl');
  await copyFile(path, copy);

  const probe = reader();
  await new Goals(copy, { read: probe.read }).open('新しい段取り', ['一'], 2000);
  const needed = probe.count();
  assert.ok((await readFile(copy, 'utf8')).split('\n').length < 100, '写しで畳んでいない（この試験の前提が崩れた）');
  assert.equal(needed, READS.goalsOpen, '畳みまでに読む回数が変わった（二度読みに戻っていないか見て、この数を見直す）');

  const g = new Goals(path, { read: reader(needed + 1).read });
  const added = await g.open('新しい段取り', ['一'], 2000);
  const left = (await new Goals(path).list()).map((x) => x.id);
  assert.deepEqual(left, [...kept, added.id], '畳んで中身を消した');
});

test('**畳むときに読めなければ、畳まずに抜ける**（記録はそのまま）', async () => {
  const dir = await tempDir('aas-compact-none-');
  const path = join(dir, 'unfinished.jsonl');
  const seed = new UnfinishedWork(path);
  await seed.add(item(0), 1000);
  const filler = Array.from({ length: 300 }, () => JSON.stringify({ t: 'close', id: 'u-none', how: 'done' })).join('\n');
  await writeFile(path, `${await readFile(path, 'utf8')}${filler}\n`);
  const before = await readFile(path, 'utf8');
  const w = new UnfinishedWork(path, { read: reader(1).read }); // 全部読めない
  await w.add(item(1), 2000).catch(() => undefined);
  const after = await readFile(path, 'utf8');
  assert.ok(after.startsWith(before), '読めないのに畳んで書き直した');
});

test('**畳むとき、別の版が書いた行は残し、途中で切れた断片は捨てる**', async () => {
  const dir = await tempDir('aas-compact-odd-');
  const path = join(dir, 'unfinished.jsonl');
  const seed = new UnfinishedWork(path);
  await seed.add(item(0), 1000);
  const future = JSON.stringify({ t: 'pin', id: 'u-x', by: '新しい版' });
  const filler = Array.from({ length: 300 }, () => JSON.stringify({ t: 'close', id: 'u-none', how: 'done' })).join('\n');
  await writeFile(path, `${await readFile(path, 'utf8')}${future}\n{"t":"add","ite\n${filler}\n`);
  await seed.add(item(1), 2000);
  const after = await readFile(path, 'utf8');
  assert.ok(after.split('\n').length < 100, '畳んでいない');
  assert.ok(after.includes(future), '別の版が書いた行を捨てた');
  assert.ok(!after.includes('{"t":"add","ite\n'), '切れた断片を残した');
  assert.deepEqual((await seed.list()).map((u) => u.request), ['依頼 0', '依頼 1']);
});
