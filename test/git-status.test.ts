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

test('作業場がリポジトリのサブフォルダなら、道は作業場からで、作業場の外の変更は数えない', { skip: GIT_OK ? false : 'この機械には git が無い' }, async () => {
  // porcelain の道は根からなので、作業場からの道と並べると同じファイルが二つの形で並び、「計画に無いファイル」になっていた
  const root = await tempDir('aas-git-subdir-');
  const work = join(root, 'packages', 'app');
  await mkdir(join(work, 'src'), { recursive: true });
  await writeFile(join(work, 'src', 'a.ts'), 'export {};\n');
  await writeFile(join(root, 'other.txt'), 'x\n');
  git(root, 'init', '-q');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'first');
  assert.equal((await inspectGit(work)).kind, 'clean');

  await writeFile(join(work, 'src', 'a.ts'), 'export const a = 1;\n');
  await writeFile(join(root, 'other.txt'), 'changed outside\n');
  const after = await inspectGit(work);
  assert.equal(after.kind, 'dirty');
  assert.deepEqual(after.kind === 'dirty' ? after.changed : [], ['src/a.ts']);
  // 宣言・書いた道（作業場から）と合うので、計画に無いものは残らない
  assert.deepEqual(dropCoveredDirs(changedBetween([], after.kind === 'dirty' ? after.changed : []), ['src/a.ts'])
    .filter((p) => p !== 'src/a.ts'), []);

  // 作業場の外だけが変わっていれば、作業場はきれい
  git(root, 'checkout', '--', 'packages');
  assert.equal((await inspectGit(work)).kind, 'clean');
});

test('作業場までのフォルダの大小が索引と違っても（core.ignorecase）、変わっていれば「クリーン」と言わない', { skip: GIT_OK ? false : 'この機械には git が無い' }, async () => {
  // `-- .` と素の startsWith では一件も挙がらず「クリーン — いつでも巻き戻せます」と出していた（作業場の記録の側で一度直した形）
  const root = await tempDir('aas-git-case-');
  const work = join(root, 'Src', 'app');
  await mkdir(work, { recursive: true });
  await writeFile(join(work, 'a.txt'), 'a\n');
  git(root, 'init', '-q');
  git(root, 'config', 'core.ignorecase', 'true');
  git(root, 'config', 'core.autocrlf', 'false');
  // 索引には小文字で載せる（Windows でフォルダの大小だけを変えた後の姿）。大小を区別する所でも作れるよう、索引だけを書く
  const blob = git(root, 'hash-object', '-w', join('Src', 'app', 'a.txt')).trim();
  git(root, 'update-index', '--add', '--cacheinfo', `100644,${blob},src/app/a.txt`);
  git(root, 'commit', '-q', '-m', 'init');
  await writeFile(join(work, 'a.txt'), 'a\nb\n');
  const now = await inspectGit(work);
  assert.equal(now.kind, 'dirty', `変わっているのに ${now.kind} と言った`);
  assert.ok(now.kind === 'dirty' && now.changed.includes('a.txt'), JSON.stringify(now));
});

test('作業場が丸ごと未追跡なら、「クリーン」と言わない', { skip: GIT_OK ? false : 'この機械には git が無い' }, async () => {
  // git は作業場を `?? packages/` の一件で返す。作業場の外として捨てると何も残らず、戻せないのに「いつでも巻き戻せます」と出す
  const root = await tempDir('aas-git-untracked-');
  await writeFile(join(root, 'top.txt'), 'x\n');
  git(root, 'init', '-q');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'first');
  const work = join(root, 'packages', 'app');
  await mkdir(join(work, 'src'), { recursive: true });
  await writeFile(join(work, 'src', 'a.ts'), 'export {};\n');
  const now = await inspectGit(work);
  assert.equal(now.kind, 'dirty', `何もコミットされていないのに ${now.kind} と言った`);
});

test('作業場の設定の core.fsmonitor に書かれた命令を、製品の git が走らせない', { skip: GIT_OK ? false : 'この機械には git が無い' }, async () => {
  // fsmonitor の命令は `git status` のたびに走る。作業場の `.git/config` は作業の中で書き換えられうるので、承認なしに命令を走らせる道になっていた
  const root = await tempDir('aas-git-fsmonitor-');
  await writeFile(join(root, 'a.txt'), 'x\n');
  git(root, 'init', '-q');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'first');
  // 走った合図のファイルは作業場の .git の中に置く（みんなで使う一時フォルダの直下に作らない。status にも挙がらない）
  const marker = join(root, '.git', 'fsmonitor-ran');
  const hook = join(root, 'hook.sh');
  await writeFile(hook, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`, { mode: 0o755 });
  git(root, 'config', 'core.fsmonitor', hook);
  // 試験の場が本当に走らせる形になっているかを先に見る（走らないなら、この試験は何も確かめていない）
  try { git(root, 'status', '--porcelain'); } catch { /* 命令が 1 で終わっても status は続く */ }
  const { existsSync, rmSync } = await import('node:fs');
  if (!existsSync(marker)) return; // この git は fsmonitor の命令を走らせない（古い版・Windows の形）。確かめる場が無い
  rmSync(marker);

  await inspectGit(root);
  const { workspaceStamp } = await import('../src/agent/workspace-stamp.ts');
  await workspaceStamp(root);
  assert.equal(existsSync(marker), false, '作業場の設定の命令を、製品の git が走らせた');
});
