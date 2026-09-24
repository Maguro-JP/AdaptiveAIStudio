/**
 * 作業場が変わったかを、git に聞いて見分ける（`src/agent/workspace-stamp.ts`）。
 *
 * 作業場がリポジトリの根とは限らない。git の警告が出ることもある。
 * どちらでも、書いたものを見逃さず、外の変化を数えないことを、本物の git で見る。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, appendFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { workspaceStamp, stampChanges } from '../src/agent/workspace-stamp.ts';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

async function repo(): Promise<string> {
  const home = await tempDir('aas-stamp-');
  const root = join(home, 'repo');
  await mkdir(join(root, 'pkg'), { recursive: true });
  await writeFile(join(root, 'pkg', 'f.txt'), 'a\n');
  await writeFile(join(root, 'other.txt'), 'a\n');
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  return root;
}

describe('作業場の記録', () => {
  test('作業場がリポジトリの下のフォルダでも、もともと変わっていたファイルへの追記を見逃さない', async () => {
    const root = await repo();
    const ws = join(root, 'pkg');
    await appendFile(join(ws, 'f.txt'), 'b\n');            // 作業前から変わっている
    const before = await workspaceStamp(ws);
    await appendFile(join(ws, 'f.txt'), 'ccc\n');          // さらに書き足す
    const after = await workspaceStamp(ws);
    assert.ok(before && after);
    assert.deepEqual(stampChanges(before, after), ['pkg/f.txt'],
      `下のフォルダの書き足しを見逃している: ${JSON.stringify([...before], null, 0)}`);
  });

  test('作業場の外の変化は、この作業場の変化と数えない（対）', async () => {
    const root = await repo();
    const ws = join(root, 'pkg');
    const before = await workspaceStamp(ws);
    await appendFile(join(root, 'other.txt'), 'b\n');
    const after = await workspaceStamp(ws);
    assert.ok(before && after);
    assert.deepEqual(stampChanges(before, after), [], '作業場の外の変化を数えている');
  });

  test('git が標準エラーに何か書いても、記録が壊れない', async () => {
    /*
     * 警告（`core.autocrlf` の「LF will be replaced by CRLF」など）は、版や設定で
     * 出たり出なかったりする（git 2.43 の status では出なかった）。運で通る試験に
     * しないため、**必ず標準エラーに書く** `GIT_TRACE=1` を代わりに使う。
     */
    const root = await repo();
    await writeFile(join(root, 'new.txt'), 'x\n');
    const saved = process.env.GIT_TRACE;
    process.env.GIT_TRACE = '1';
    try {
      const stamp = await workspaceStamp(root);
      assert.ok(stamp);
      for (const key of stamp.keys()) {
        assert.ok(!/trace|git\.c|run_command/.test(key), `標準エラーが記録に混ざっている: ${key}`);
      }
      assert.deepEqual([...stamp.keys()], ['new.txt'], `記録がずれている: ${[...stamp.keys()].join(',')}`);
    } finally {
      if (saved === undefined) delete process.env.GIT_TRACE; else process.env.GIT_TRACE = saved;
    }
  });

});
