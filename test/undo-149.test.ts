import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, chmod, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { UndoStore, UndoConflict } from '../src/core/undo.ts';
import { tempDir } from './tmp.ts';

test('記録できなかった道を後から手で直したら、古い戻り先まで戻すときに断る', async () => {
  const root = await tempDir('aas-undo149-');
  const u = new UndoStore(root, join(await tempDir('aas-undo149-st-'), 'undo'));
  await writeFile(join(root, 'f.txt'), 'F0\n');
  await u.begin('A', 1000); u.capture('f.txt', 'F0\n'); await writeFile(join(root, 'f.txt'), 'F1\n'); await u.end();
  await writeFile(join(root, 'g.txt'), 'G0\n'); await u.begin('B', 2000); u.capture('g.txt', 'G0\n'); u.skip('f.txt'); await writeFile(join(root, 'f.txt'), 'F2\n'); await u.end();
  await writeFile(join(root, 'f.txt'), 'F2\nUSER\n');
  const a = (await u.list()).find((p) => p.request === 'A')!;
  await assert.rejects(u.restore(a.id), UndoConflict);
  assert.equal(await readFile(join(root, 'f.txt'), 'utf8'), 'F2\nUSER\n');
});

test('記録できなかった道を AI が書いたままなら、古い戻り先まで戻せる', async () => {
  const root = await tempDir('aas-undo149b-');
  const u = new UndoStore(root, join(await tempDir('aas-undo149b-st-'), 'undo'));
  await writeFile(join(root, 'f.txt'), 'F0\n');
  await u.begin('A', 1000); u.capture('f.txt', 'F0\n'); await writeFile(join(root, 'f.txt'), 'F1\n'); await u.end();
  await writeFile(join(root, 'g.txt'), 'G0\n'); await u.begin('B', 2000); u.capture('g.txt', 'G0\n'); u.skip('f.txt'); await writeFile(join(root, 'f.txt'), 'F2\n'); await u.end();
  const a = (await u.list()).find((p) => p.request === 'A')!;
  await u.restore(a.id);
  assert.equal(await readFile(join(root, 'f.txt'), 'utf8'), 'F0\n');
});

test('戻す前に手で付けた実行の権限を、黙って落とさない', { skip: process.platform === 'win32' }, async () => {
  const root = await tempDir('aas-undo149c-');
  const u = new UndoStore(root, join(await tempDir('aas-undo149c-st-'), 'undo'));
  await writeFile(join(root, 'run.sh'), 'echo 1\n');
  await chmod(join(root, 'run.sh'), 0o644);
  await u.begin('A', 1000); u.capture('run.sh', 'echo 1\n'); await writeFile(join(root, 'run.sh'), 'echo one\n'); await u.end();
  await chmod(join(root, 'run.sh'), 0o755);
  const a = (await u.list()).find((p) => p.request === 'A')!;
  await assert.rejects(u.restore(a.id), UndoConflict);
  assert.equal((await stat(join(root, 'run.sh'))).mode & 0o777, 0o755);
});
