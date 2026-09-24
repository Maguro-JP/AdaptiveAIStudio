/**
 * push の手前のフックを、clone に入れる仕組み（`scripts/hooks.mjs`）。
 *
 * `.githooks/README.md` に「一度だけ打つ」と書いてあったが、fresh clone で誰も打たず、
 * フックが無いまま push が通った。判断（`hooksPlan`）と、**本物の clone に入ること**を見る。
 *
 * この作業場に入っているかは見ない。CI は `npm ci` の前に `npm test` を回す（依存ゼロを
 * 確かめるため）ので、そこで見ると checkout のたびに落ちる。入れるのは `npm install` の
 * `prepare` と `npm run check` の始め。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
// @ts-expect-error 型定義を置かない開発用の script。ここだけ読む。
import { hooksPlan, installHooks, gitEnv, HOOKS_PATH } from '../scripts/hooks.mjs';

function git(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/**
 * `.githooks/pre-push` を持つ小さな clone。
 * フックの中身は見ないので書いて置く（本物を写すと、`.githooks` の無い bundle の中で落ちる）。
 */
async function clone(): Promise<string> {
  const root = await tempDir('aas-hooks-');
  await mkdir(join(root, HOOKS_PATH), { recursive: true });
  await writeFile(join(root, HOOKS_PATH, 'pre-push'), '#!/bin/sh\nexit 0\n');
  await writeFile(join(root, 'a.txt'), 'a\n');
  git(root, process.env, 'init', '-q');
  return root;
}

describe('push の手前のフック', () => {
  test('clone でなければ入れない。元が無ければ入れない。無ければ入れる。在れば触らない', () => {
    const at = (files: string[], current?: string) =>
      (hooksPlan({ exists: (p: string) => files.includes(p), current }) as { action: string; text: string });
    assert.equal(at(['.githooks/pre-push']).action, 'skip', 'clone でないのに入れようとしている');
    assert.equal(at(['.git']).action, 'skip', 'フックの元が無いのに入れようとしている');
    assert.equal(at(['.git', '.githooks/pre-push']).action, 'set');
    assert.equal(at(['.git', '.githooks/pre-push'], HOOKS_PATH).action, 'kept');
    const other = at(['.git', '.githooks/pre-push'], 'elsewhere');
    assert.equal(other.action, 'set', '別の所を指しているのに、入っていることにしている');
    assert.match(other.text, /elsewhere/, '前の値を言わずに上書きしている');
  });

  test('本物の clone に入る。二度目は触らない', async () => {
    const root = await clone();
    assert.equal((installHooks(root) as { action: string }).action, 'set');
    assert.equal(git(root, process.env, 'config', '--local', 'core.hooksPath'), HOOKS_PATH, '入っていない');
    assert.equal((installHooks(root) as { action: string }).action, 'kept');
  });

  test('git がフックへ渡す env（GIT_DIR）を持ち込まない。別の repository に書かない', async () => {
    const root = await clone();
    const other = await clone();
    const saved = process.env.GIT_DIR;
    process.env.GIT_DIR = join(other, '.git');
    try {
      assert.equal((installHooks(root) as { action: string }).action, 'set');
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved;
    }
    const clean = gitEnv(process.env) as NodeJS.ProcessEnv;
    assert.equal(git(root, clean, 'config', '--local', 'core.hooksPath'), HOOKS_PATH, 'この clone に入っていない');
    assert.throws(() => git(other, clean, 'config', '--local', 'core.hooksPath'), '別の repository に書いている');
  });
});
