/**
 * 作業場の一覧。横の板に出すために読む。
 *
 * **根の外へ出さない。**画面から来た道をそのまま繋ぐと、
 * `../../..` で好きな所を覗ける口になる。文字の上で見るだけでは足りず、
 * リンクを辿ると外へ出るので、実体を解いてから比べる。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { listDir, insideRoot, MAX_ENTRIES } from '../src/ui/files.ts';

/** 作業場を1つ作る。 */
async function workRoot(): Promise<string> {
  const root = await tempDir('aas-files-');
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'node_modules', 'x'), { recursive: true });
  await mkdir(join(root, '.git'), { recursive: true });
  await writeFile(join(root, 'README.md'), '#');
  await writeFile(join(root, 'src', 'main.ts'), '// x');
  return root;
}

describe('作業場の一覧', () => {
  test('フォルダが先、その中で名前順', async () => {
    const root = await workRoot();
    const names = (await listDir(root, '')).map((e) => `${e.dir ? 'd' : 'f'}:${e.name}`);
    assert.deepEqual(names, ['d:src', 'f:README.md']);
  });

  test('見に行く用の無いものは出さない', async () => {
    // node_modules と .git は数が多く、開いても仕方がない。
    const root = await workRoot();
    const names = (await listDir(root, '')).map((e) => e.name);
    assert.ok(!names.includes('node_modules'), 'node_modules を出している');
    assert.ok(!names.includes('.git'), '.git を出している');
  });

  test('一階層だけ返す。道は根からの相対', async () => {
    const root = await workRoot();
    const entries = await listDir(root, 'src');
    assert.deepEqual(entries.map((e) => e.path), ['src/main.ts']);
  });

  test('根の外は見せない', async () => {
    const root = await workRoot();
    for (const bad of ['..', '../..', 'src/../..', '/etc']) {
      await assert.rejects(listDir(root, bad), /作業場の外/, `通ってしまった: ${bad}`);
    }
  });

  test('リンクで外へ出る道も止める', async () => {
    // 文字の上では中に見えるが、辿ると外。実体を解いてから比べる。
    const root = await workRoot();
    const outside = await tempDir('aas-outside-');
    await writeFile(join(outside, 'secret.txt'), 'x');
    await symlink(outside, join(root, 'link'));
    assert.equal(await insideRoot(root, 'link'), undefined, 'リンクの先が外なのに通っている');
    await assert.rejects(listDir(root, 'link'), /作業場の外/);
  });

  test('中のリンクは通す（対）', async () => {
    // 何でも止めるのでは、作業場の中の普通の作りが使えなくなる。
    const root = await workRoot();
    await symlink(join(root, 'src'), join(root, 'src-link'));
    assert.ok(await insideRoot(root, 'src-link'), '中を指すリンクまで止めている');
  });

  test('多すぎるときは切る', async () => {
    // node_modules を開いても画面が固まらないように。
    const root = await tempDir('aas-many-');
    for (let i = 0; i < MAX_ENTRIES + 20; i += 1) {
      await writeFile(join(root, `f${String(i).padStart(4, '0')}.txt`), 'x');
    }
    assert.equal((await listDir(root, '')).length, MAX_ENTRIES);
  });
});
