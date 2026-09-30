/**
 * git の状態から取る道は、本物の道にする。
 *
 * `--porcelain` だけで読んでいたので、新しいフォルダを `sub/` と縮め、日本語の名前を `"\350..."` と引用し、名前の変更を `a -> b` と一行にした。
 * その文字をそのまま道として使い、段取りの受け入れで `sub/a.ts` を作っても `sub/` という無いファイルを「計画に無いファイル」として挙げていた。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { inspectGit } from '../src/agent/git.ts';
import { changedBetween, dropCoveredDirs } from '../src/agent/acceptance.ts';

const GIT_OK = (() => { try { execFileSync('git', ['--version']); return true; } catch { return false; } })();
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], {
  cwd, encoding: 'utf8',
  env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' },
});

test('日本語の名前・名前の変更を本物の道で返し、新しいフォルダは書いたファイルで中身が分かれば計画に無いものとして挙げない', { skip: GIT_OK ? false : 'この機械には git が無い' }, async () => {
  const root = await tempDir('aas-git-status-');
  git(root, 'init', '-q');
  await writeFile(join(root, 'old.txt'), 'x\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'first');
  const before = await inspectGit(root);
  assert.equal(before.kind, 'clean');

  await mkdir(join(root, 'sub'), { recursive: true });
  await writeFile(join(root, 'sub', 'a.ts'), 'export {};\n');
  await writeFile(join(root, '設計.md'), '# 設計\n');
  git(root, 'mv', 'old.txt', 'new.txt');
  const after = await inspectGit(root);
  assert.equal(after.kind, 'dirty');
  const changed = after.kind === 'dirty' ? after.changed : [];
  for (const want of ['sub/', '設計.md', 'new.txt', 'old.txt']) {
    assert.ok(changed.includes(want), `${want} が無い: ${JSON.stringify(changed)}`);
  }
  assert.ok(!changed.some((p) => p.startsWith('"') || p.includes(' -> ')), `引用や矢の付いた道が混ざった: ${JSON.stringify(changed)}`);
  // 書いたファイルで中身が分かっているフォルダは外し、書いていないフォルダは残す
  assert.deepEqual(dropCoveredDirs(changedBetween([], changed), ['sub/a.ts']).includes('sub/'), false);
  assert.deepEqual(dropCoveredDirs(['other/'], ['sub/a.ts']), ['other/']);
});
