/**
 * git が返らないとき（取得（fetch）が止まる・資格情報を訊いてくる）、待ち続けない。
 *
 * 画面の更新の口・CLI の /update が返らないまま固まっていた。返らない git の代わりに、眠り続ける node を走らせて見る。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWithin, runGit } from '../src/agent/git.ts';
import { tempDir } from './tmp.ts';

test('返らない命令は、時間切れで打ち切って失敗として返す', async () => {
  const started = Date.now();
  const r = await runWithin(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], process.cwd(), 300);
  assert.equal(r.code, -1);
  assert.match(r.out, /打ち切りました/);
  assert.ok(Date.now() - started < 10_000, `時間切れで打ち切っていない（${Date.now() - started}ms）`);
});

test('資格情報を訊かせない合図を渡す', async () => {
  const r = await runWithin(process.execPath, ['-e', 'process.stdout.write(String(process.env.GIT_TERMINAL_PROMPT))'], process.cwd(), 10_000,
    { GIT_TERMINAL_PROMPT: '0' });
  assert.equal(r.out, '0');
});

test('git そのものは今までどおり答える（対）', async () => {
  const r = await runGit(['--version'], await tempDir('aas-git-version-'));
  assert.equal(r.code, 0);
  assert.match(r.out, /git version/);
});
