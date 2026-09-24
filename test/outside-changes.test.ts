/**
 * 外のツールが変えたファイルの「前の中身」を、本物の git で取れることを見る。
 *
 * 前の中身は三つの道で取る（`src/agent/outside-changes.ts`）。
 * 呼ぶ前から変わっていたものは呼ぶ前に読む。きれいだったものは索引から取る。
 * 無かったものは「前は無い」。どれか一つでも外すと、戻したときに別の姿になる。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, appendFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { OutsideChanges } from '../src/agent/outside-changes.ts';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

async function repo(opts: { git?: boolean } = {}): Promise<string> {
  const home = await tempDir('aas-outside-changes-');
  const root = join(home, 'repo');
  await mkdir(join(root, 'sub'), { recursive: true });
  await writeFile(join(root, 'clean.txt'), 'clean\n');
  await writeFile(join(root, 'dirty.txt'), 'committed\n');
  await writeFile(join(root, 'sub', 'gone.txt'), 'gone\n');
  if (opts.git !== false) {
    git(root, 'init', '-q');
    git(root, 'add', '-A');
    git(root, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  }
  return root;
}

const byPath = (r: { changes: Array<{ path: string; previous: string | undefined }> }) =>
  Object.fromEntries(r.changes.map((c) => [c.path, c.previous]));

describe('外のツールが変えたファイルの、前の中身', () => {
  test('きれいだった・変わっていた・無かった、のそれぞれで正しい「前」を返す', async () => {
    const root = await repo();
    await appendFile(join(root, 'dirty.txt'), 'edited by hand\n');   // 呼ぶ前から変わっている
    const outside = new OutsideChanges(root);
    await outside.before();
    // 外のツールの代わりに、こちらで変える。
    await writeFile(join(root, 'clean.txt'), 'tool wrote\n');          // きれいだったものを変えた
    await writeFile(join(root, 'dirty.txt'), 'tool overwrote\n');      // 変わっていたものをさらに変えた
    await writeFile(join(root, 'new.txt'), 'brand new\n');             // 無かったものを作った
    await rm(join(root, 'sub', 'gone.txt'));                           // きれいだったものを消した
    const r = await outside.after();
    assert.equal(r.comparable, true);
    assert.deepEqual(byPath(r), {
      'clean.txt': 'clean\n',                       // 索引から
      'dirty.txt': 'committed\nedited by hand\n',   // 呼ぶ前に読んだもの（索引の姿ではない）
      'new.txt': undefined,                         // 前は無い
      'sub/gone.txt': 'gone\n',                     // 消されても索引から
    });
    assert.deepEqual(r.tooLarge, []);
    assert.deepEqual(outside.paths, ['clean.txt', 'dirty.txt', 'new.txt', 'sub/gone.txt']);
  });

  test('同じ道は最初の一度だけ。二度目の呼び出しでは返さない', async () => {
    const root = await repo();
    const outside = new OutsideChanges(root);
    await outside.before();
    await writeFile(join(root, 'clean.txt'), 'first\n');
    const one = await outside.after();
    await outside.before();
    await writeFile(join(root, 'clean.txt'), 'second\n');
    await writeFile(join(root, 'other.txt'), 'x\n');
    const two = await outside.after();
    assert.deepEqual(byPath(one), { 'clean.txt': 'clean\n' });
    assert.deepEqual(byPath(two), { 'other.txt': undefined }, '二度目に「前」を取り直している（後の中身が「前」になる）');
  });

  test('大きすぎるものは読まず、名前だけ返す', async () => {
    const root = await repo();
    await writeFile(join(root, 'big.txt'), 'x'.repeat(2048));          // 呼ぶ前から変わっていて、大きい
    const outside = new OutsideChanges(root, { maxBytes: 1024 });
    await outside.before();
    await writeFile(join(root, 'big.txt'), 'tool\n');
    const r = await outside.after();
    assert.deepEqual(byPath(r), {});
    assert.deepEqual(r.tooLarge, ['big.txt']);
  });

  test('git の管理下でない作業場では、比べられないと言う', async () => {
    const root = await repo({ git: false });
    const outside = new OutsideChanges(root);
    await outside.before();
    await writeFile(join(root, 'clean.txt'), 'tool wrote\n');
    const r = await outside.after();
    assert.equal(r.comparable, false);
    assert.deepEqual(r.changes, []);
  });

  test('作業場がリポジトリの下のフォルダでも、道は作業場からで、索引も引ける', async () => {
    const root = await repo();
    const ws = join(root, 'sub');
    const outside = new OutsideChanges(ws);
    await outside.before();
    await writeFile(join(ws, 'gone.txt'), 'tool wrote\n');
    await writeFile(join(root, 'clean.txt'), 'outside the workspace\n');   // 作業場の外
    const r = await outside.after();
    assert.deepEqual(byPath(r), { 'gone.txt': 'gone\n' });
  });
});
