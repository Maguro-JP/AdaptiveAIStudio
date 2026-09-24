/**
 * Checkpoint に「前の中身を渡して記録する」口（`remember`）。
 *
 * 外のツールが変えたファイルは、変えた後にしか道が分からない。ディスクを読んでも
 * 後の中身しか無いので、前の中身は渡してもらう。綴りの違う同じ道を二つ記録しない。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { Checkpoint } from '../src/harness/checkpoint.ts';

describe('Checkpoint.remember', () => {
  test('渡された前の中身へ戻す。前が無ければ消す', async () => {
    const root = await tempDir('aas-cp-');
    await writeFile(join(root, 'a.txt'), 'after\n');
    await writeFile(join(root, 'made.txt'), 'made by tool\n');
    const cp = new Checkpoint(root);
    cp.remember('a.txt', 'before\n');
    cp.remember('made.txt', undefined);
    const restored = await cp.restore();
    assert.deepEqual(restored.sort(), ['a.txt', 'made.txt']);
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'before\n');
    assert.equal(await stat(join(root, 'made.txt')).catch(() => undefined), undefined, '前は無かったものが残っている');
  });

  test('綴りが違っても同じ道なら、最初の一度だけ', async () => {
    const root = await tempDir('aas-cp-');
    await writeFile(join(root, 'a.txt'), 'v1\n');
    const cp = new Checkpoint(root);
    await cp.capture('./a.txt');           // v1 を記録する
    await writeFile(join(root, 'a.txt'), 'v2\n');
    cp.remember('a.txt', 'v2\n');          // 同じ道。上書きしない
    await writeFile(join(root, 'a.txt'), 'v3\n');
    assert.equal(cp.size, 1, '同じ道を二つ記録している');
    await cp.restore();
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'v1\n', '後から記録した方（v2）に戻っている');
  });

  test('作業場の外は記録しない', async () => {
    const root = await tempDir('aas-cp-');
    const cp = new Checkpoint(root);
    cp.remember('../outside.txt', 'x');
    assert.equal(cp.size, 0);
  });
});
