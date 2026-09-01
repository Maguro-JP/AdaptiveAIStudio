/**
 * 作業場の外へ出さない、をリンク越しでも守ること。
 *
 * 文字の上で中でも、実体が外なら外。モデルは ln -s を打てる。
 * リンクを作れない機械（Windows の一般権限）では、その検査は飛ばす。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir, writeFile, symlink, realpath } from 'node:fs/promises';
import { tempDir } from './tmp.ts';
import { realSafeResolve, safeResolve } from '../src/agent/tools/paths.ts';
import { writeFileTool, readFileTool } from '../src/agent/tools/fs.ts';
import type { ToolContext } from '../src/agent/tools/types.ts';

async function canLink(): Promise<boolean> {
  const d = await tempDir('aas-ln-');
  await writeFile(join(d, 'a'), 'x');
  try { await symlink(join(d, 'a'), join(d, 'b')); return true; } catch { return false; }
}
const linkable = await canLink();
const onlyWithLinks = { skip: linkable ? false : 'この機械ではリンクを作れない' };

function ctx(root: string): ToolContext {
  return { root, signal: new AbortController().signal, approve: async () => true } as ToolContext;
}

describe('リンクの先まで見る', () => {
  test('外を指すリンク越しの道は、外', onlyWithLinks, async () => {
    const outside = await tempDir('aas-out-');
    await writeFile(join(outside, 'secret'), 'S');
    const root = await tempDir('aas-root-');
    await symlink(outside, join(root, 'link'));
    // 文字の上では中に見える。
    assert.ok(safeResolve(root, 'link/secret'));
    // 実体は外。
    assert.equal(await realSafeResolve(root, 'link/secret'), undefined);
  });

  test('中を指すリンクは中（対）', onlyWithLinks, async () => {
    const root = await tempDir('aas-root-');
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'a.ts'), 'x');
    await symlink(join(root, 'src'), join(root, 'alias'));
    const got = await realSafeResolve(root, 'alias/a.ts');
    assert.equal(got, join(await realpath(root), 'src', 'a.ts'));
  });

  test('まだ無いファイルは、在る所まで遡って決める', async () => {
    const root = await tempDir('aas-root-');
    await mkdir(join(root, 'src'));
    assert.ok(await realSafeResolve(root, 'src/new/deep.ts'));
    assert.equal(await realSafeResolve(root, '../x.ts'), undefined);
  });
});

describe('道具も、リンク越しには出ない・書かない', () => {
  test('外を指すリンク越しには読めない', onlyWithLinks, async () => {
    const outside = await tempDir('aas-out-');
    await writeFile(join(outside, 'secret'), 'S');
    const root = await tempDir('aas-root-');
    await symlink(outside, join(root, 'link'));
    const r = await readFileTool.run({ path: 'link/secret' }, ctx(root));
    assert.equal(r.isError, true);
  });

  test('リンクそのものには書かない', onlyWithLinks, async () => {
    const root = await tempDir('aas-root-');
    await writeFile(join(root, '.env'), 'SECRET=1');
    await symlink(join(root, '.env'), join(root, 'link'));
    const r = await writeFileTool.run({ path: 'link', content: 'SECRET=2' }, ctx(root));
    assert.equal(r.isError, true);
    const { readFile } = await import('node:fs/promises');
    assert.equal(await readFile(join(root, '.env'), 'utf8'), 'SECRET=1', 'リンク越しに書き換わった');
  });

  test('ふつうのファイルには書ける（対）', async () => {
    const root = await tempDir('aas-root-');
    const r = await writeFileTool.run({ path: 'a.txt', content: 'x' }, ctx(root));
    assert.notEqual(r.isError, true);
  });
});
