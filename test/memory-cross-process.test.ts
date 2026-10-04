/**
 * 画面と端末が同じ記憶のファイルを持つとき（別のプロセスの同時書き）。
 *
 * - 両方が同じ所まで読んでから別々に覚えても、両方の覚えが残る（同じ番号を配って片方を消さない）
 * - 片方で忘れた覚えを、もう片方の保存で書き戻さない
 * - 保存は錠で包む（よそが錠を持っている間は書かない）
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { Memory } from '../src/memory/memory.ts';

async function twoOnOneFile(): Promise<{ path: string; a: Memory; b: Memory }> {
  const path = join(await tempDir('aas-mem-cross-'), 'memory.jsonl');
  const seed = new Memory(path);
  await seed.load();
  seed.remember({ kind: 'decision', title: '最初に決めたこと', detail: 'x', now: 1_000 });
  await seed.save();
  const a = new Memory(path);
  const b = new Memory(path);
  await a.load();
  await b.load();
  return { path, a, b };
}

async function titlesOnDisk(path: string): Promise<string[]> {
  return (await readFile(path, 'utf8')).split('\n').filter((l) => l.startsWith('{"id"'))
    .map((l) => (JSON.parse(l) as { title: string }).title).sort();
}

describe('別のプロセスの同時書き', () => {
  test('**両方が同じ所まで読んでから別々に覚えても、両方の覚えが別の番号で残る**', async () => {
    const { path, a, b } = await twoOnOneFile();
    a.remember({ kind: 'decision', title: '画面で決めたこと', detail: 'A', now: 2_000 });
    b.remember({ kind: 'decision', title: '端末で決めたこと', detail: 'B', now: 3_000 });
    await a.save();
    await b.save();
    assert.deepEqual(await titlesOnDisk(path), ['最初に決めたこと', '画面で決めたこと', '端末で決めたこと'].sort());
    const ids = (await readFile(path, 'utf8')).split('\n').filter((l) => l.startsWith('{"id"')).map((l) => (JSON.parse(l) as { id: string }).id);
    assert.equal(new Set(ids).size, ids.length, `番号が重なっている: ${ids.join(',')}`);
    // もう一度ずつ保存しても、どちらも消えない
    a.touch(); await a.save();
    b.touch(); await b.save();
    assert.deepEqual(await titlesOnDisk(path), ['最初に決めたこと', '画面で決めたこと', '端末で決めたこと'].sort());
  });

  test('**片方で忘れた覚えを、もう片方の保存で書き戻さない**', async () => {
    const { path, a, b } = await twoOnOneFile();
    const id = a.recall('最初に決めたこと')[0]!.id;
    assert.ok(a.remove(id));
    await a.save();
    b.touch();
    await b.save();
    assert.deepEqual(await titlesOnDisk(path), [], '忘れた覚えが戻った');
  });

  test('手で退けた行（読めなくした行）は、よそで消されたと見なさない（対）', async () => {
    const { path, a } = await twoOnOneFile();
    const raw = await readFile(path, 'utf8');
    // 手で読めなくする（JSON として読めない）。番号は残っている
    await writeFile(path, raw.replace('"title":"最初に決めたこと"', '"title":"最初に決めたこと"broken'));
    a.touch();
    await a.save();
    assert.ok((await readFile(path, 'utf8')).includes('最初に決めたこと'), '退けた行まで消した');
  });

  test('**よそが錠を持っている間は書かない**（待っても取れなければ保存を断り、変更は持ったまま）', async () => {
    const { path, a } = await twoOnOneFile();
    await writeFile(`${path}.lock`, `${process.pid} other`);
    a.remember({ kind: 'decision', title: '錠の間に決めたこと', detail: 'x', now: 4_000 });
    await assert.rejects(a.save());
    assert.ok(!(await readFile(path, 'utf8')).includes('錠の間に決めたこと'));
  });

  test('**両方が空から最初の覚えを入れて保存しても、同じ題を二件にしない**', async () => {
    const { BUILTIN_LESSONS } = await import('../src/memory/builtin-lessons.ts');
    const path = join(await tempDir('aas-mem-cross-seed-'), 'memory.jsonl');
    const a = new Memory(path);
    const b = new Memory(path);
    await a.load(); await b.load();
    a.seedLessons();
    await new Promise((r) => setTimeout(r, 5)); // 覚えた時刻をずらす
    b.seedLessons();
    await a.save();
    await b.save();
    const lines = (await readFile(path, 'utf8')).split('\n').filter((l) => l.startsWith('{"id"'));
    assert.equal(lines.length, BUILTIN_LESSONS.length, `二重になった: ${lines.length}`);
  });

  test('**同じ題を別々に覚えても、一件に畳む**（確かめた数は足す）', async () => {
    const { path, a, b } = await twoOnOneFile();
    a.remember({ kind: 'decision', title: '名前は動詞から', detail: 'x', now: 2_000 });
    b.remember({ kind: 'decision', title: '名前は動詞から', detail: 'x', now: 3_000 });
    await a.save();
    await b.save();
    assert.deepEqual(await titlesOnDisk(path), ['名前は動詞から', '最初に決めたこと'].sort());
  });

  test('**忘れて空いた最大の番号をよそが使い回しても、よその新しい覚えを消さない**', async () => {
    const { path, a, b } = await twoOnOneFile();
    const r = a.remember({ kind: 'decision', title: 'すぐ忘れること', detail: 'x', now: 2_000 });
    await a.save();
    assert.ok(a.remove(r.entry.id));
    await a.save();
    // b は一度も保存していない（最大の番号を知らない）ので、同じ番号を配る
    b.remember({ kind: 'decision', title: '端末で決めたこと', detail: 'B', now: 3_000 });
    await b.save();
    a.touch(); await a.save();
    b.touch(); await b.save();
    assert.deepEqual(await titlesOnDisk(path), ['最初に決めたこと', '端末で決めたこと'].sort());
  });

  test('**錠が外れた後の保存では、持っていた変更を書く**', async () => {
    const { path, a } = await twoOnOneFile();
    await writeFile(`${path}.lock`, `${process.pid} other`);
    a.remember({ kind: 'decision', title: '錠の後に書くこと', detail: 'x', now: 4_000 });
    await assert.rejects(a.save());
    const { rm } = await import('node:fs/promises');
    await rm(`${path}.lock`);
    await a.save();
    assert.ok((await titlesOnDisk(path)).includes('錠の後に書くこと'));
  });
});
