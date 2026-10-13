import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { listFilesTool } from '../src/agent/tools/fs.ts';
import { tempDir } from './tmp.ts';

const ctxAt = (root: string) => ({ root, signal: new AbortController().signal, approve: async () => true }) as never;

test('.gitignore に無い dist を決め打ちで飛ばしたら、飛ばしたと言う', async () => {
  const root = await tempDir('aas-list133-');
  await mkdir(join(root, 'dist'));
  await writeFile(join(root, 'dist', 'app.js'), 'x');
  await writeFile(join(root, 'README'), 'x');
  const r = await listFilesTool.run({}, ctxAt(root));
  assert.match(r.content, /README/);
  assert.match(r.content, /中を見ていないフォルダ: dist/);
});

test('.gitignore に書いてある dist は、飛ばしたと言わない（書いた人は知っている）', async () => {
  const root = await tempDir('aas-list133b-');
  await mkdir(join(root, 'dist'));
  await writeFile(join(root, 'dist', 'app.js'), 'x');
  await writeFile(join(root, '.gitignore'), 'dist/\n');
  await writeFile(join(root, 'README'), 'x');
  const r = await listFilesTool.run({}, ctxAt(root));
  assert.doesNotMatch(r.content, /中を見ていないフォルダ/);
});

test('リンクは辿らないが、在ることを言う', { skip: process.platform === 'win32' }, async () => {
  const root = await tempDir('aas-list133c-');
  await writeFile(join(root, 'a.ts'), 'x');
  await symlink('a.ts', join(root, 'link.ts'));
  const r = await listFilesTool.run({}, ctxAt(root));
  assert.match(r.content, /リンク 1 個は辿っていません/);
});

test('「全部無視して src だけ戻す」書き方で、src の中身が出る', async () => {
  const root = await tempDir('aas-list133d-');
  await mkdir(join(root, 'src'));
  await mkdir(join(root, 'other'));
  await writeFile(join(root, 'src', 'a.ts'), 'x');
  await writeFile(join(root, 'other', 'b.ts'), 'x');
  await writeFile(join(root, '.gitignore'), '/*\n!/src/\n');
  const r = await listFilesTool.run({}, ctxAt(root));
  assert.match(r.content, /src\/a\.ts/);
  assert.doesNotMatch(r.content, /other\/b\.ts/);
});
