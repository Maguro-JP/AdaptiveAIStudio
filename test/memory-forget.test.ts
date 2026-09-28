/**
 * 画面の「忘れる」は一押しで効く。押し間違えた覚えを戻せること、保存できなかったら忘れていないと言うこと。
 *
 * 前は、保存の失敗を黙って捨てて「忘れました」と返していた。手元だけ忘れて、次に開くと戻ってくる。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { Memory, type MemoryEntry } from '../src/memory/memory.ts';
import { ForgetShelf, forgetAndSave, restoreAndSave } from '../src/memory/forget-shelf.ts';

/** 決め直しで繋がった二つと、無関係の一つ。 */
function threeEntries(m: Memory): { old: string; next: string; other: string } {
  const old = m.remember({ kind: 'decision', title: '保存は一時ファイルから', now: 1000 }).entry.id;
  const other = m.remember({ kind: 'fact', title: 'Z: は exe を受け取らない', now: 2000 }).entry.id;
  const next = m.remember({ kind: 'decision', title: '保存は一時ファイルから置き換える', supersedes: old, now: 3000 }).entry.id;
  return { old, next, other };
}

/** 欄の並びに左右されずに比べる（戻すと、切って付け直した欄は後ろへ回る）。 */
const plain = (m: Memory): unknown[] => m.all().map((e) => JSON.parse(JSON.stringify(e)));
const byId = (m: Memory, id: string): MemoryEntry | undefined => m.all().find((e) => e.id === id);

/** 書く手を落とせる記憶。 */
async function failable(dir: string): Promise<{ m: Memory; fail: (on: boolean) => void }> {
  let failing = false;
  const m = new Memory(join(dir, 'memory.jsonl'), {
    write: async (p, body) => {
      if (failing) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      await writeFile(p, body);
    },
  });
  await m.load();
  return { m, fail: (on) => { failing = on; } };
}

describe('記憶を忘れて、戻す', () => {
  test('**忘れたものを戻すと、同じ番号・同じ並び・同じ繋がりに戻る**', () => {
    const m = new Memory();
    const { old, next, other } = threeEntries(m);
    const before = plain(m);
    const f = m.remove(old);
    assert.ok(f, '忘れていない');
    assert.equal(byId(m, next)?.supersedes, undefined, '消した先を指したまま');
    assert.equal(m.restore(f), true);
    assert.deepEqual(plain(m), before, '戻した形が元と違う');
    assert.deepEqual(m.all().map((e) => e.id), [old, other, next]);
  });

  test('戻す間に別の先を指すようになっていたら、その繋がりは上書きしない', () => {
    const m = new Memory();
    const { old, next, other } = threeEntries(m);
    const f = m.remove(old)!;
    byId(m, next)!.supersedes = other; // all() は写しの配列だが、要素は同じもの
    assert.equal(m.restore(f), true);
    assert.equal(byId(m, next)?.supersedes, other);
  });

  test('**相手が居ない繋がりは外して戻す。相手が後から戻れば、両向きに繋ぎ直す**（どちらの順でも）', () => {
    for (const order of [['b', 'c'], ['c', 'b']] as const) {
      const m = new Memory();
      const a = m.remember({ kind: 'decision', title: 'A', now: 1 }).entry.id;
      const b = m.remember({ kind: 'decision', title: 'B', supersedes: a, now: 2 }).entry.id;
      const c = m.remember({ kind: 'decision', title: 'C', supersedes: b, now: 3 }).entry.id;
      const before = plain(m);
      const taken = { b: m.remove(b)!, c: m.remove(c)! };
      assert.equal(m.restore(taken[order[0]]), true);
      if (order[0] === 'b') {
        // C がまだ居ないのに「C に決め直された」のままだと、B は思い出されない
        assert.equal(byId(m, b)?.supersededBy, undefined, `${order}: 居ない相手を指したまま`);
        assert.equal(byId(m, a)?.supersededBy, b);
      } else {
        assert.equal(byId(m, c)?.supersedes, undefined, `${order}: 居ない相手を指したまま`);
      }
      assert.equal(m.restore(taken[order[1]]), true);
      assert.deepEqual(plain(m), before, `${order}: 両方戻しても元の繋がりにならない`);
    }
  });

  test('同じ番号が既に在れば戻さない', () => {
    const m = new Memory();
    const { old } = threeEntries(m);
    const f = m.remove(old)!;
    assert.equal(m.restore(f), true);
    assert.equal(m.restore(f), 'taken');
    assert.equal(m.all().filter((e) => e.id === old).length, 1);
  });

  test('忘れている間に同じことを覚え直していたら、二つにしない', () => {
    const m = new Memory();
    const { other } = threeEntries(m);
    const f = m.remove(other)!;
    m.remember({ kind: 'fact', title: 'Z: は exe を受け取らない', now: 5000 });
    assert.equal(m.restore(f), 'duplicate');
    assert.equal(m.all().filter((e) => e.title === 'Z: は exe を受け取らない').length, 1);
  });

  test('戻した番号より先の番号を、後で配らない', () => {
    const m = new Memory();
    const { next } = threeEntries(m);
    const f = m.remove(next)!;
    assert.equal(m.restore(f), true);
    const fresh = m.remember({ kind: 'fact', title: 'あたらしい', now: 9000 }).entry.id;
    assert.notEqual(fresh, next);
  });

  test('**忘れて保存し、戻して保存すると、ファイルも元に戻る**（決め直しの繋がりごと）', async () => {
    const dir = await tempDir('aas-forget-');
    const path = join(dir, 'memory.jsonl');
    const m = new Memory(path);
    await m.load();
    const { old } = threeEntries(m);
    await m.save();
    const lines = async (): Promise<unknown[]> => (await readFile(path, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    const saved = await lines();
    const shelf = new ForgetShelf();

    const gone = await forgetAndSave(m, shelf, old);
    assert.deepEqual(gone, { ok: true, id: old, title: '保存は一時ファイルから' });
    assert.ok(!(await readFile(path, 'utf8')).includes(`"id":"${old}"`), 'ファイルから消えていない');

    const back = await restoreAndSave(m, shelf, old);
    assert.equal(back.ok, true);
    assert.deepEqual(await lines(), saved, 'ファイルが元に戻っていない');
    assert.equal(shelf.has(old), false, '戻したのに、まだ取ってある');
  });

  test('**保存できなければ、忘れていないと言い、覚えも残す**', async () => {
    const { m, fail } = await failable(await tempDir('aas-forget-fail-'));
    const { old, next } = threeEntries(m);
    await m.save();
    const before = plain(m);
    fail(true);
    const shelf = new ForgetShelf();
    const r = await forgetAndSave(m, shelf, old);
    assert.equal(r.ok === false && r.status, 500);
    assert.match(r.ok === false ? r.error : '', /忘れていません/);
    assert.deepEqual(plain(m), before, '手元だけ忘れている');
    assert.equal(byId(m, next)?.supersedes, old, '繋がりが切れたまま');
    assert.equal(shelf.has(old), false, '忘れていないのに、戻す口に載せた');
  });

  test('戻すときに保存できなければ、忘れたままにして、もう一度戻せる', async () => {
    const { m, fail } = await failable(await tempDir('aas-restore-fail-'));
    const { other } = threeEntries(m);
    await m.save();
    const shelf = new ForgetShelf();
    assert.equal((await forgetAndSave(m, shelf, other)).ok, true);
    fail(true);
    const r = await restoreAndSave(m, shelf, other);
    assert.equal(r.ok === false && r.status, 500);
    assert.equal(r.ok === false && r.gone, undefined, 'もう一度押せるのに、戻す口を下げさせる');
    assert.equal(m.all().some((e) => e.id === other), false, '保存していないのに戻した');
    fail(false);
    assert.equal((await restoreAndSave(m, shelf, other)).ok, true, '二度目に戻せない');
    assert.ok(m.all().some((e) => e.id === other));
  });

  test('**戻し損ねた一件は、忘れた時刻と並びを変えずに載せ直す**（最後に忘れたものに見せない）', async () => {
    const { m, fail } = await failable(await tempDir('aas-restore-fail-order-'));
    const { old, other } = threeEntries(m);
    await m.save();
    const shelf = new ForgetShelf();
    // 続けて二つ忘れたら、後に忘れた方が先
    assert.equal((await forgetAndSave(m, shelf, other)).ok, true);
    assert.equal((await forgetAndSave(m, shelf, old)).ok, true);
    const before = shelf.list(m.era);
    assert.deepEqual(before.map((x) => x.id), [old, other]);
    fail(true);
    assert.equal((await restoreAndSave(m, shelf, other)).ok, false);
    assert.deepEqual(shelf.list(m.era), before, '戻し損ねた一件が、最後に忘れたものとして前に出た');
    fail(false);
    assert.equal((await restoreAndSave(m, shelf, other)).ok, true);
    assert.ok(m.all().some((e) => e.id === other));
  });

  test('**読み直した記憶（セッションを作り直した）には、前に忘れた分を戻さない**（同じ番号が別の覚えになる）', async () => {
    const dir = await tempDir('aas-forget-reload-');
    const path = join(dir, 'memory.jsonl');
    const m = new Memory(path);
    await m.load();
    const { next } = threeEntries(m);
    await m.save();
    const shelf = new ForgetShelf();
    assert.equal((await forgetAndSave(m, shelf, next)).ok, true);

    const again = new Memory(path);
    await again.load();
    const newcomer = again.remember({ kind: 'fact', title: '読み直した後に覚えた', now: 9000 }).entry.id;
    assert.equal(newcomer, next, '前提: 読み直すと、忘れた番号がまた配られる');
    const r = await restoreAndSave(again, shelf, next);
    assert.equal(r.ok === false && r.status, 409);
    assert.equal(r.ok === false && r.gone, true, '押しても戻らない口を残させる');
    assert.equal(again.all().filter((e) => e.id === next).length, 1);
    assert.equal(byId(again, next)?.title, '読み直した後に覚えた', '別の覚えを上書きした');
  });

  test('**保存の途中で番号が振り直されたら、戻したふりをせず、手元では忘れていると言う**', async () => {
    // 起動したときに読めなかった（手元の番号が m1 から振られる）。保存の直前に読めて、手元の分が後ろへ振り直される
    const dir = await tempDir('aas-forget-rejoin-');
    const path = join(dir, 'memory.jsonl');
    const disk = new Memory(path);
    await disk.load();
    threeEntries(disk);
    await disk.save();
    const onDisk = plain(disk);

    let busy = true;
    let failing = false;
    const m = new Memory(path, {
      read: async (p) => {
        if (busy) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
        return readFile(p, 'utf8');
      },
      write: async (p, body) => {
        if (failing) throw new Error('disk full');
        await writeFile(p, body);
      },
    });
    await m.load();
    const mine = m.remember({ kind: 'fact', title: '読めない間に覚えた', now: 5000 }).entry.id;
    m.remember({ kind: 'fact', title: 'もうひとつ', now: 6000 });
    assert.equal(mine, 'm1', '前提: 手元の番号はファイルの番号と重なる');
    busy = false;
    failing = true;
    const shelf = new ForgetShelf();
    const r = await forgetAndSave(m, shelf, mine);
    assert.equal(r.ok === false && r.status, 500);
    assert.match(r.ok === false ? r.error : '', /手元では忘れて/, '忘れていないと偽った');
    assert.ok(!m.all().some((e) => e.title === '読めない間に覚えた'));
    assert.deepEqual(plain(m).slice(0, onDisk.length), onDisk, 'ファイルの側の同じ番号の覚えを書き換えた');
    assert.equal(shelf.has(mine), false, '別の覚えを指す番号を、戻す口に載せた');
  });

  test('同じ記憶を読み直した後は、前に取った分を戻さない', async () => {
    const dir = await tempDir('aas-forget-load-');
    const m = new Memory(join(dir, 'memory.jsonl'));
    await m.load();
    const { other } = threeEntries(m);
    await m.save();
    const f = m.remove(other)!;
    await m.load(); // 読み直すと番号が振り直され得る。ここでは番号が空いていても戻さない
    assert.equal(m.restore(f), 'reloaded');
  });

  test('**保存の途中で番号が振り直されたら、保存が通っても、戻す口に載せない**', async () => {
    const dir = await tempDir('aas-forget-rejoin-ok-');
    const path = join(dir, 'memory.jsonl');
    const disk = new Memory(path);
    await disk.load();
    threeEntries(disk);
    await disk.save();
    let busy = true;
    const m = new Memory(path, {
      read: async (p) => {
        if (busy) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
        return readFile(p, 'utf8');
      },
    });
    await m.load();
    const mine = m.remember({ kind: 'fact', title: '読めない間に覚えた', now: 5000 }).entry.id;
    busy = false;
    const shelf = new ForgetShelf();
    assert.equal((await forgetAndSave(m, shelf, mine)).ok, true);
    assert.equal(shelf.has(mine), false, '振り直す前の番号を載せた（戻すと、ファイルの側の同じ番号の覚えに当たる）');
    const r = await restoreAndSave(m, shelf, mine);
    assert.equal(r.ok === false && r.status, 404);
    assert.equal(byId(m, mine)?.title, '保存は一時ファイルから', 'ファイルの側の覚えが変わった');
  });

  test('取っていない番号は戻さない（中身は画面から受け取らない）', async () => {
    const m = new Memory();
    threeEntries(m);
    const r = await restoreAndSave(m, new ForgetShelf(), 'm999');
    assert.equal(r.ok === false && r.status, 404);
  });

  test('取っておくのは新しい 20 件まで', () => {
    const shelf = new ForgetShelf();
    const m = new Memory();
    for (let i = 0; i < 22; i += 1) {
      const id = m.remember({ kind: 'fact', title: `覚え ${i}`, now: i }).entry.id;
      shelf.put(m.remove(id)!);
    }
    assert.equal(shelf.has('m1'), false);
    assert.equal(shelf.has('m2'), false);
    assert.equal(shelf.has('m3'), true);
    assert.equal(shelf.has('m22'), true);
  });

  test('**戻せる分を新しい順に並べる。番号と題と種類と時刻だけで、中身や繋がりは出さない**', () => {
    const shelf = new ForgetShelf();
    const m = new Memory();
    const { old, next, other } = threeEntries(m);
    shelf.put(m.remove(other)!, 100);
    shelf.put(m.remove(old)!, 200);
    shelf.put(m.remove(next)!, 300);
    const list = shelf.list(m.era);
    assert.deepEqual(list.map((x) => x.id), [next, old, other]);
    assert.deepEqual(list[0], { id: next, title: '保存は一時ファイルから置き換える', kind: 'decision', at: 300 });
    // 戻したものは並べない
    shelf.take(old);
    assert.deepEqual(shelf.list(m.era).map((x) => x.id), [next, other]);
    // 同じ時刻に忘れたら、後に載せた方が先
    const tie = new ForgetShelf();
    const m2 = new Memory();
    const ids = [0, 1, 2].map((i) => m2.remember({ kind: 'fact', title: `同時 ${i}`, now: i }).entry.id);
    for (const id of ids) tie.put(m2.remove(id)!, 500);
    assert.deepEqual(tie.list(m2.era).map((x) => x.id), [...ids].reverse());
  });

  test('**読み直した後（代が違う）の分は並べない**（押しても戻らない口を出さない）', async () => {
    const dir = await tempDir('aas-forget-list-');
    const { m } = await failable(dir);
    const shelf = new ForgetShelf();
    const id = m.remember({ kind: 'fact', title: '覚え', now: 1 }).entry.id;
    await m.save();
    shelf.put(m.remove(id)!);
    assert.equal(shelf.list(m.era).length, 1);
    await m.load();
    assert.deepEqual(shelf.list(m.era), []);
  });
});
