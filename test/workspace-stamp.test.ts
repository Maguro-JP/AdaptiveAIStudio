/**
 * 作業場が変わったかを、git に聞いて見分ける（`src/agent/workspace-stamp.ts`）。
 *
 * 作業場がリポジトリの根とは限らない。git の警告が出ることもある。
 * どちらでも、書いたものを見逃さず、外の変化を数えないことを、本物の git で見る。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, appendFile, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tempDir } from './tmp.ts';
import { workspaceStamp, stampChanges, headContent } from '../src/agent/workspace-stamp.ts';

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
  git(root, 'config', 'core.autocrlf', 'false');
  // 名前変更の検出は設定で切れる。断定は設定に依らせない。
  git(root, 'config', 'status.renames', 'true');
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
    // 鍵は作業場からの道。git の根からの道（pkg/f.txt）ではない。
    assert.deepEqual(stampChanges(before, after), ['f.txt'],
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

  test('作業場がシンボリックリンク越しでも、鍵は作業場からの道', async (t) => {
    const root = await repo();
    const link = join(dirname(root), 'link');
    try { await symlink(root, link, 'dir'); } catch { t.skip('シンボリックリンクを作れない'); return; }
    const ws = join(link, 'pkg');
    await appendFile(join(ws, 'f.txt'), 'b\n');
    const stamp = await workspaceStamp(ws);
    assert.ok(stamp);
    // `--show-toplevel` は実体の道を返すので、リンクの道から relative() を取ると `../../repo/...` になる。
    assert.deepEqual([...stamp.keys()], ['f.txt'], `鍵が作業場からの道でない: ${[...stamp.keys()].join(',')}`);
    assert.match(stamp.get('f.txt')!, /^ M \d+ /, '大きさが取れていない（stat の道がずれている）');
  });

  test('名前を変えたものは、元の名前も「消えた」として記録する', async () => {
    const root = await repo();
    const before = await workspaceStamp(root);
    git(root, 'mv', 'pkg/f.txt', 'pkg/g.txt');
    const after = await workspaceStamp(root);
    assert.ok(before && after);
    assert.deepEqual(stampChanges(before, after), ['pkg/f.txt', 'pkg/g.txt'], '元の名前が変わったことになっていない');
    assert.equal(after.get('pkg/f.txt'), 'R  -');
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

  test('HEAD から、触る前の中身を作業ツリーの形で取れる。無い・取れない、を分けて言う', async () => {
    const root = await repo();
    const ws = join(root, 'pkg');
    // 変える前はきれい。変えた後・消した後でも、HEAD には前の中身が残っている。
    await writeFile(join(ws, 'f.txt'), 'changed\n');
    assert.deepEqual(await headContent(ws, 'f.txt', 1024), { kind: 'content', content: 'a\n' });
    await writeFile(join(ws, 'g.txt'), 'new\n');
    assert.deepEqual(await headContent(ws, 'g.txt', 1024), { kind: 'absent' }, 'HEAD に無いものを取れたことにしている');
    // 在るが大きすぎる。「無い」ではない。
    assert.deepEqual(await headContent(ws, 'f.txt', 1), { kind: 'unavailable', why: 'tooLarge' });
  });

  test('作業場の名前が全角空白で始まっても、鍵は作業場からの道', async () => {
    const root = await repo();
    const ws = join(root, '\u3000zen');
    await mkdir(ws);
    await writeFile(join(ws, 'g.txt'), 'g\n');
    git(root, 'add', '-A');
    git(root, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'zen');
    await appendFile(join(ws, 'g.txt'), 'h\n');
    const stamp = await workspaceStamp(ws);
    assert.ok(stamp);
    assert.deepEqual([...stamp.keys()], ['g.txt'], `先頭の空白を落として鍵がずれている: ${[...stamp.keys()].join(',')}`);
  });

  test('作業場までのフォルダの大小が索引と違っても（core.ignorecase）、追跡しているファイルの変化を見逃さない', async () => {
    const home = await tempDir('aas-stamp-case-');
    const root = join(home, 'repo');
    const ws = join(root, 'Src', 'app');
    await mkdir(ws, { recursive: true });
    await writeFile(join(ws, 'a.txt'), 'a\n');
    git(root, 'init', '-q');
    git(root, 'config', 'core.ignorecase', 'true');
    git(root, 'config', 'core.autocrlf', 'false');
    // 索引には小文字で載せる（Windows でフォルダの大小だけを変えた後の姿）。大小を区別する所でも作れるよう、索引だけを書く
    const blob = execFileSync('git', ['hash-object', '-w', join('Src', 'app', 'a.txt')], { cwd: root, encoding: 'utf8' }).trim();
    git(root, 'update-index', '--add', '--cacheinfo', `100644,${blob},src/app/a.txt`);
    git(root, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
    // 大小を区別しない所では「書き換えた」、区別する所では「索引の道に無い」で挙がる。どちらでも挙がらなければいけない
    await appendFile(join(ws, 'a.txt'), 'b\n');
    const stamp = await workspaceStamp(ws);
    assert.ok(stamp);
    assert.ok(stamp.has('a.txt'), `索引と大小が違うだけで、追跡しているファイルを数えていない: [${[...stamp.keys()].join(',')}]`);
    // **「前」も HEAD から引ける。**cwd からの道（`./a.txt`）は cwd の分がディスクの大小（`Src/app`）で HEAD と照らされて
    // 何も引けず、「前は無かった」と記録して、戻すときにこのファイルを消していた
    const before = await headContent(ws, 'a.txt', 1024);
    assert.equal(before.kind, 'content', `HEAD の中身を引けていない（${before.kind}）。戻すと消える`);
    if (before.kind === 'content') assert.equal(String(before.content), 'a\n');
  });

  test('**大小だけ違う二つのフォルダが HEAD に在っても、作業場のフォルダのファイルを「前」にする**', async () => {
    // 区別する機械で作ったリポジトリ。大小を無視した最初の一致（並びで先の `Src`）を取ると、別のフォルダの中身を「前」にして、
    // 戻すときにその中身を書く
    const home = await tempDir('aas-stamp-case-');
    const root = join(home, 'repo');
    await mkdir(join(root, 'Src', 'app'), { recursive: true });
    await mkdir(join(root, 'src', 'app'), { recursive: true });
    await writeFile(join(root, 'Src', 'app', 'a.txt'), 'upper\n');
    await writeFile(join(root, 'src', 'app', 'a.txt'), 'lower\n');
    git(root, 'init', '-q');
    git(root, 'config', 'core.autocrlf', 'false');
    git(root, 'add', '-A');
    git(root, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
    git(root, 'config', 'core.ignorecase', 'true');
    const before = await headContent(join(root, 'src', 'app'), 'a.txt', 1024);
    assert.equal(before.kind, 'content');
    if (before.kind === 'content') assert.equal(String(before.content), 'lower\n', '別のフォルダ（Src）の中身を「前」にした');
  });

  test('大小を区別しないリポジトリでも、名前の似た隣のフォルダは数えない', async () => {
    const home = await tempDir('aas-stamp-case-');
    const root = join(home, 'repo');
    await mkdir(join(root, 'app'), { recursive: true });
    await mkdir(join(root, 'apple'), { recursive: true });
    await writeFile(join(root, 'app', 'a.txt'), 'a\n');
    git(root, 'init', '-q');
    git(root, 'config', 'core.ignorecase', 'true');
    git(root, 'add', '-A');
    git(root, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
    await writeFile(join(root, 'apple', 'x.txt'), 'x\n');
    const stamp = await workspaceStamp(join(root, 'app'));
    assert.ok(stamp);
    assert.deepEqual([...stamp.keys()], [], `隣のフォルダの変化を数えた: [${[...stamp.keys()].join(',')}]`);
  });

  test('HEAD がリンク・submodule のものは取れないと言い、二進はバイト列のまま返す', async (t) => {
    const root = await repo();
    await writeFile(join(root, 'bin.dat'), Buffer.from([0x00, 0xff, 0xfe]));
    let linked = true;
    try { await symlink('other.txt', join(root, 'lnk')); } catch { linked = false; }
    git(root, 'add', '-A');
    git(root, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'more');
    assert.deepEqual(await headContent(root, 'bin.dat', 1024), { kind: 'content', content: Buffer.from([0x00, 0xff, 0xfe]) });
    if (linked) assert.deepEqual(await headContent(root, 'lnk', 1024), { kind: 'unavailable', why: 'symlink' });
    else t.diagnostic('シンボリックリンクを作れないので、リンクの分は見ていない');
  });
});
