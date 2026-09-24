/**
 * 一つの道を前の中身へ置き戻す（`src/harness/put-back.ts`）。
 *
 * 別の担当の読み直しで分かった三つ。リンクを辿って作業場の外へ書く／切れたリンクが残る／
 * 戻せなかった道を黙って落とす。どれも「巻き戻しました」と言いながら別の姿にする。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir, symlink, lstat, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { putBack, putBackOrder } from '../src/harness/put-back.ts';
import { Checkpoint } from '../src/harness/checkpoint.ts';

const exists = (p: string) => lstat(p).then(() => true, () => false);

async function place(): Promise<{ root: string; outside: string }> {
  const home = await tempDir('aas-put-back-');
  const root = join(home, 'ws');
  const outside = join(home, 'outside');
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  return { root, outside };
}

describe('置き戻す', () => {
  test('リンクを辿って外へ書かない。リンクを消して、前のファイルを置く', async (t) => {
    const { root, outside } = await place();
    await writeFile(join(outside, 'secret.txt'), 'secret\n');
    try { await symlink(join(outside, 'secret.txt'), join(root, 'target.txt')); } catch { t.skip('シンボリックリンクを作れない'); return; }
    assert.equal(await putBack(root, 'target.txt', 'target\n'), 'restored');
    assert.equal(await readFile(join(outside, 'secret.txt'), 'utf8'), 'secret\n', '作業場の外を上書きしている');
    assert.equal((await lstat(join(root, 'target.txt'))).isSymbolicLink(), false, 'リンクのまま残っている');
    assert.equal(await readFile(join(root, 'target.txt'), 'utf8'), 'target\n');
  });

  test('前が「無い」なら、切れたリンクも消す（stat では見えない）', async (t) => {
    const { root } = await place();
    try { await symlink('/nonexistent/x', join(root, 'dangling')); } catch { t.skip('シンボリックリンクを作れない'); return; }
    assert.equal(await stat(join(root, 'dangling')).catch(() => undefined), undefined, '前提: stat では見えない');
    assert.equal(await putBack(root, 'dangling', undefined), 'restored');
    assert.equal(await exists(join(root, 'dangling')), false, '切れたリンクが残っている');
  });

  test('親がリンクで作業場の外へ出る道は、戻せなかったと言う', async (t) => {
    const { root, outside } = await place();
    try { await symlink(outside, join(root, 'link')); } catch { t.skip('シンボリックリンクを作れない'); return; }
    assert.equal(await putBack(root, 'link/secret.txt', 'x'), 'failed');
    assert.equal(await exists(join(outside, 'secret.txt')), false, '作業場の外に書いている');
  });

  test('ファイルがフォルダに入れ替わっていたら、中を消してから元のファイルを置く。中身が残るなら戻せなかったと言う', async () => {
    const { root } = await place();
    await mkdir(join(root, 'f'));
    await writeFile(join(root, 'f', 'g.txt'), 'inside\n');
    // 巻き戻しの一覧は「消す道を先に」並べる。
    const cp = new Checkpoint(root);
    cp.remember('f', 'was a file\n');
    cp.remember('f/g.txt', undefined);
    const r = await cp.restoreAll();
    assert.deepEqual(r, { restored: ['f/g.txt', 'f'], failed: [] });
    assert.equal(await readFile(join(root, 'f'), 'utf8'), 'was a file\n');
    // 中身が残っているフォルダは退けられない。黙らない（Checkpoint も戻せなかった道として返す）。
    await mkdir(join(root, 'h'));
    await writeFile(join(root, 'h', 'keep.txt'), 'x');
    assert.equal(await putBack(root, 'h', 'was a file\n'), 'failed');
    assert.equal(await exists(join(root, 'h', 'keep.txt')), true, '中身のあるフォルダを消している');
    const cp2 = new Checkpoint(root);
    cp2.remember('h', 'was a file\n');
    assert.deepEqual(await cp2.restoreAll(), { restored: [], failed: ['h'] }, '戻せなかった道を黙って落としている');
  });

  test('前が「無い」のにフォルダが在るなら、消さずに戻せなかったと言う（中身が分からない）', async () => {
    const { root } = await place();
    await mkdir(join(root, 'inner'));
    await writeFile(join(root, 'inner', 'x.txt'), 'x');
    assert.equal(await putBack(root, 'inner', undefined), 'failed');
    assert.equal(await exists(join(root, 'inner', 'x.txt')), true);
  });

  test('並びは、消す道が先', () => {
    const items = [{ path: 'a', content: 'x' }, { path: 'b', content: undefined }, { path: 'c', content: 'y' }];
    assert.deepEqual(putBackOrder(items).map((i) => i.path), ['b', 'a', 'c']);
  });
});
