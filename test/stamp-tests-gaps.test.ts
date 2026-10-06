/**
 * 作業場の記録とテストの数え方の不具合（57 回目の調査）。
 *
 * - 作業場の中の別のリポジトリ（フォルダ一つで挙がる）の中を書き換えても、「変わっていない」と読んだ
 * - `test.skipIf(…)`・`test.fixme(…)`・テストの中の `test.skip()`・`this.skip()` で止めたテストを、止めたと数えなかった
 * - Python の三重引用符で囲んで止めたテストを、そのまま数えた
 *
 * test/ の下の大きな置き物を丸ごと読んでいた件は、読んだ結果（定義 0）が直す前と同じで、試験では見分けられないので書いていない。
 * edit_file が外れたときの近い所探しの手間（行数 × find の行数の 2 乗）は、時間で見る試験が揺れるので書いていない。数え方が変わって
 * いないことは `test/` の既存の近い所の試験で見る。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { workspaceStamp, stampChanges } from '../src/agent/workspace-stamp.ts';
import { countCases, countSkips } from '../src/agent/test-patterns.ts';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

async function committed(root: string): Promise<void> {
  git(root, 'init', '-q');
  git(root, 'config', 'core.autocrlf', 'false');
  git(root, 'add', '-A');
  git(root, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
}

describe('作業場の記録', () => {
  test('**中の別のリポジトリのファイルを書き換えたら、変わったと読む**', async () => {
    const home = await tempDir('aas-stamp-nested-');
    const root = join(home, 'repo');
    await mkdir(join(root, 'nested', 'src'), { recursive: true });
    await writeFile(join(root, 'top.txt'), 'a\n');
    await committed(root);
    await writeFile(join(root, 'nested', 'src', 'a.txt'), 'one\n');
    await committed(join(root, 'nested'));
    const before = await workspaceStamp(root);
    assert.ok(before, '前提: 記録が取れない');
    await writeFile(join(root, 'nested', 'src', 'a.txt'), 'one two three\n');
    const after = await workspaceStamp(root);
    assert.ok(after);
    assert.notDeepEqual(stampChanges(before, after), [], '中の別のリポジトリでの書き込みを「変わっていない」とした');
    // 何もしていなければ、変わったと言わない（毎回騒がない）
    const again = await workspaceStamp(root);
    assert.deepEqual(stampChanges(after, again!), []);
  });
});

describe('テストの数え方', () => {
  const live = (t: string) => countCases(t) - countSkips(t);
  const base = "test('a', () => { assert.ok(1); })\n";

  for (const [name, text] of [
    ['test.skipIf', "test.skipIf(true)('a', () => { assert.ok(1); })\n"],
    ['test.fixme', "test.fixme('a', () => { assert.ok(1); })\n"],
    ['中の test.skip()', "test('a', () => { test.skip(); assert.ok(1); })\n"],
    ['this.skip()', "it('a', function () { this.skip(); assert.ok(1); })\n"],
  ] as const) {
    test(`**${name} で止めたテストは、走るテストに数えない**`, () => {
      assert.ok(live(text) < live(base), `${name}: ${live(text)} / 前 ${live(base)}`);
    });
  }

  test('**Python の三重引用符の中のテストは数えない**', () => {
    assert.equal(countCases('"""\ndef test_a():\n    pass\n"""\n'), 0);
    assert.equal(countCases("def test_a():\n    '''doc'''\n    pass\n\ndef test_b():\n    pass\n"), 2, '本物の docstring の後ろを数えなくなった');
  });
});
