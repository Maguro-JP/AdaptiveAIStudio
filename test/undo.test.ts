/**
 * 戻せること。
 *
 * **手元の小さいモデルは、間違った直しを当てる。**そのとき利用者にできることが
 * 「自分で書き戻す」しか無いなら、任せられない。ここが効かないと、
 * 何を頼むにも身構えることになる。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { UndoStore, MAX_POINTS, MAX_POINT_BYTES, RECENT_PATHS } from '../src/core/undo.ts';

async function store(): Promise<{ root: string; undo: UndoStore }> {
  const root = await tempDir('aas-undo-');
  const state = await tempDir('aas-undo-state-');
  return { root, undo: new UndoStore(root, join(state, 'undo')) };
}

/** 道具がするのと同じ順（控えてから書く）。 */
async function edit(root: string, undo: UndoStore, rel: string, body: string): Promise<void> {
  const abs = join(root, rel);
  const before = await readFile(abs, 'utf8').catch(() => undefined);
  undo.capture(rel, before);
  await mkdir(join(root, rel, '..'), { recursive: true });
  await writeFile(abs, body, 'utf8');
}

describe('戻す', () => {
  test('**書き換えられたファイルが、元に戻る**', async () => {
    const { root, undo } = await store();
    await writeFile(join(root, 'math.js'), 'a + b\n', 'utf8');

    await undo.begin('足し算を直して');
    await edit(root, undo, 'math.js', 'a - b\n');
    const point = await undo.end();
    assert.ok(point, '戻り先が残っていない');

    assert.equal(await readFile(join(root, 'math.js'), 'utf8'), 'a - b\n');
    const done = await undo.restore(point.id);
    assert.deepEqual(done?.paths, ['math.js']);
    assert.equal(await readFile(join(root, 'math.js'), 'utf8'), 'a + b\n');
  });

  test('**新しく作られたファイルは、消える**', async () => {
    const { root, undo } = await store();
    await undo.begin('新しいファイルを足して');
    await edit(root, undo, 'new.js', 'できたて\n');
    const point = await undo.end();
    assert.ok(point);

    await undo.restore(point.id);
    assert.equal(await stat(join(root, 'new.js')).catch(() => undefined), undefined,
      '元々無かったファイルが残っている');
  });

  test('触っていない回は、戻り先を作らない', async () => {
    const { undo } = await store();
    await undo.begin('この関数は何ですか');
    assert.equal(await undo.end(), undefined);
    assert.equal((await undo.list()).length, 0);
  });

  /**
   * **一つだけ戻さない。**後の直しが上に乗っているので、途中だけ古い状態に
   * すると、どこにも無かった形になる。三回直して二回目まで戻すなら、
   * 三回目も一緒に戻る。
   */
  test('**そこまで戻す。途中だけ古い状態を作らない**', async () => {
    const { root, undo } = await store();
    await writeFile(join(root, 'a.txt'), '0', 'utf8');
    await writeFile(join(root, 'b.txt'), '0', 'utf8');

    await undo.begin('一回目'); await edit(root, undo, 'a.txt', '1'); const first = await undo.end();
    await undo.begin('二回目'); await edit(root, undo, 'b.txt', '2'); await undo.end();
    await undo.begin('三回目'); await edit(root, undo, 'a.txt', '3'); await undo.end();

    assert.ok(first);
    const done = await undo.restore(first.id);
    assert.equal(done?.points, 3, '後の回が戻っていない');
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), '0');
    assert.equal(await readFile(join(root, 'b.txt'), 'utf8'), '0');
  });

  test('同じファイルを一往復で二度触っても、いちばん古い姿に戻る', async () => {
    const { root, undo } = await store();
    await writeFile(join(root, 'a.txt'), 'もと', 'utf8');
    await undo.begin('二度触る');
    await edit(root, undo, 'a.txt', '一度目');
    await edit(root, undo, 'a.txt', '二度目');
    const point = await undo.end();
    assert.ok(point);
    await undo.restore(point.id);
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'もと');
  });

  test('戻したら、その戻り先は消える（二度押しても増えない）', async () => {
    const { root, undo } = await store();
    await writeFile(join(root, 'a.txt'), 'もと', 'utf8');
    await undo.begin('一回'); await edit(root, undo, 'a.txt', '直した'); const p = await undo.end();
    assert.ok(p);
    await undo.restore(p.id);
    assert.equal((await undo.list()).length, 0);
    assert.equal(await undo.restore(p.id), undefined, '消えた戻り先に戻れてしまう');
  });

  test('溜めすぎない。古いものから落ちる', async () => {
    const { root, undo } = await store();
    await writeFile(join(root, 'a.txt'), '0', 'utf8');
    for (let i = 0; i < MAX_POINTS + 5; i += 1) {
      await undo.begin(`${i} 回目`);
      await edit(root, undo, 'a.txt', String(i));
      await undo.end();
    }
    const list = await undo.list();
    assert.equal(list.length, MAX_POINTS);
    assert.match(list[0]!.request, /34 回目/, '新しい方が残っていない');
  });

  test('**大きすぎて控えなかったものを、黙らない**', async () => {
    const { root, undo } = await store();
    const huge = 'あ'.repeat(9 * 1024 * 1024);
    await writeFile(join(root, 'big.txt'), huge, 'utf8');
    await undo.begin('大きいものを直す');
    await edit(root, undo, 'big.txt', 'ちいさく');
    await undo.end();
    assert.deepEqual(undo.takeSkipped(), ['big.txt']);
    assert.deepEqual(undo.takeSkipped(), [], '読んだら空になる');
  });

  test('作業場の外は戻さない', async () => {
    const { root, undo } = await store();
    await undo.begin('外を触る');
    undo.capture('../../外.txt', 'なにか');
    const point = await undo.end();
    assert.ok(point);
    const done = await undo.restore(point.id);
    assert.deepEqual(done?.paths, [], '作業場の外へ書き戻している');
  });
});

describe('直近で触ったファイルを覚える', () => {
  /**
   * 戻すためではなく、**次にどこを見せるか**を決めるために持つ。
   * 地図の起点になる（`repo-map.test.ts`）。
   */
  test('新しい順に並ぶ', async () => {
    const { undo } = await store();
    await undo.begin('直して');
    undo.capture('a.ts', 'x');
    undo.capture('b.ts', 'y');
    assert.deepEqual([...undo.recent()], ['b.ts', 'a.ts']);
  });

  test('同じファイルを二度触ったら、新しい方の位置になる（二つ並べない）', async () => {
    const { undo } = await store();
    await undo.begin('直して');
    undo.capture('a.ts', 'x');
    undo.capture('b.ts', 'y');
    await undo.end();
    await undo.begin('もう一度');
    undo.capture('a.ts', 'z');
    assert.deepEqual([...undo.recent()], ['a.ts', 'b.ts']);
  });

  test('一往復を越えても残る（次の依頼のためのものなので）', async () => {
    const { undo } = await store();
    await undo.begin('直して');
    undo.capture('a.ts', 'x');
    await undo.end();
    await undo.begin('次');
    assert.deepEqual([...undo.recent()], ['a.ts']);
  });

  test('溜め込まない', async () => {
    const { undo } = await store();
    await undo.begin('直して');
    for (let i = 0; i < RECENT_PATHS + 5; i += 1) undo.capture(`f${i}.ts`, 'x');
    assert.equal(undo.recent().length, RECENT_PATHS);
    assert.equal(undo.recent()[0], `f${RECENT_PATHS + 4}.ts`);
  });

  test('**大きすぎて控えられなかったものも、触ったことは覚える**', async () => {
    const { undo } = await store();
    await undo.begin('直して');
    undo.capture('huge.ts', 'x'.repeat(MAX_POINT_BYTES + 1));
    undo.capture('small.ts', 'x');
    await undo.end();
    assert.deepEqual(undo.takeSkipped(), ['huge.ts'], '控えなかったことを言っていない');
    assert.ok(undo.recent().includes('huge.ts'),
      '戻せないことと、いま作業しているかどうかを混ぜている');
  });

  /**
   * **戻らないものを、戻り先そのものに書いておく。**
   *
   * 控えなかったことは流れ（`log`）にだけ出していた。既定の並びにそのパネルは
   * 無いので、人は見ていない。戻り先の行は普通に見えるのに、そのファイルは
   * 戻らない。選ぶ所（横の一覧）に出せるように、戻り先に持たせる。
   */
  test('**控えなかったファイルが、戻り先の一覧に出る**', async () => {
    const { undo } = await store();
    await undo.begin('直して');
    undo.capture('huge.ts', 'x'.repeat(MAX_POINT_BYTES + 1));
    undo.capture('small.ts', 'x');
    const point = await undo.end();
    assert.deepEqual(point?.skipped, ['huge.ts'], '戻り先が、控えなかったことを持っていない');
    assert.deepEqual(point?.paths, ['small.ts'], '控えていないものを、戻る顔で並べている');

    const list = await undo.list();
    assert.deepEqual(list[0]?.skipped, ['huge.ts'], '一覧に、控えなかったことが出ていない');
  });

  test('控えられたものだけなら、戻り先は何も抱えない（対）', async () => {
    const { undo } = await store();
    await undo.begin('直して');
    undo.capture('small.ts', 'x');
    const point = await undo.end();
    assert.equal(point?.skipped, undefined, '控えなかったものが無いのに、空でない');
    assert.equal((await undo.list())[0]?.skipped, undefined);
  });
});
