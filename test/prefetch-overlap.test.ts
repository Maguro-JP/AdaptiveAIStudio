/**
 * 書くたびの作り直しを重ねない。
 *
 * `invalidate()` は前の作り直しを止めずに新しい作り直しを始めていたので、段取りで五人が五十回書けば、
 * 五十本の一覧づくりと `git status` が同時に走っていた。走っている間の作り直しは一回にまとめる。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { Prefetcher, type PrefetchEvent } from '../src/agent/prefetch.ts';

test('**走っている間に何度作り直しを頼んでも、同時に走るのは一本、作り直すのは最後の一回だけ**', async () => {
  const root = await tempDir('aas-prefetch-overlap-');
  await mkdir(join(root, 'src'), { recursive: true });
  for (let i = 0; i < 200; i++) await writeFile(join(root, 'src', `f${i}.ts`), 'x');
  let running = 0;
  let most = 0;
  let starts = 0;
  const onEvent = (e: PrefetchEvent): void => {
    if (e.task !== 'index') return;
    if (e.type === 'start') { running += 1; starts += 1; most = Math.max(most, running); }
    else running -= 1;
  };
  const p = new Prefetcher(root, onEvent, () => true);
  p.start();
  for (let i = 0; i < 20; i++) p.invalidate();
  await writeFile(join(root, 'src', 'late.ts'), 'x');
  p.invalidate();
  const snap = await p.snapshot();
  assert.equal(most, 1, `同時に ${most} 本走った`);
  assert.ok(starts <= 2, `作り直しを ${starts} 回走らせた（最初の一回と、まとめた一回だけでよい）`);
  assert.ok(snap?.files.some((f) => f.endsWith('late.ts')), '最後に頼んだ作り直しの結果が届いていない（古い一覧のまま）');
});

test('走り終えた後の作り直しは、今までどおり新しく作る（対）', async () => {
  const root = await tempDir('aas-prefetch-after-');
  await writeFile(join(root, 'a.ts'), 'x');
  const p = new Prefetcher(root, undefined, () => true);
  p.start();
  await p.snapshot();
  await writeFile(join(root, 'b.ts'), 'x');
  p.invalidate();
  const snap = await p.snapshot();
  assert.ok(snap?.files.some((f) => f.endsWith('b.ts')), JSON.stringify(snap?.files));
});
