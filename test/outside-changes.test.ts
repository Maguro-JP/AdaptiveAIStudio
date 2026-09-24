/**
 * 外のツールが変えたファイルの「前の中身」を、本物の git で取れることを見る。
 *
 * 前の中身は三つの道で取る（`src/agent/outside-changes.ts`）。
 * 呼ぶ前から変わっていたものは呼ぶ前に読む。きれいだったものは HEAD から取る。
 * 無かったものは「前は無い」。どれか一つでも外すと、戻したときに別の姿になる。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, appendFile, rm, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tempDir } from './tmp.ts';
import { OutsideChanges } from '../src/agent/outside-changes.ts';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function commit(root: string): void {
  git(root, 'add', '-A');
  git(root, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
}

async function repo(opts: { git?: boolean } = {}): Promise<string> {
  const home = await tempDir('aas-outside-changes-');
  const root = join(home, 'repo');
  await mkdir(join(root, 'sub'), { recursive: true });
  await writeFile(join(root, 'clean.txt'), 'clean\n');
  await writeFile(join(root, 'dirty.txt'), 'committed\n');
  await writeFile(join(root, 'sub', 'gone.txt'), 'gone\n');
  if (opts.git !== false) {
    git(root, 'init', '-q');
    // 走らせる環境の設定（Windows の autocrlf=true など）で結果が変わらないように、ここで決める。
    git(root, 'config', 'core.autocrlf', 'false');
    git(root, 'config', 'status.renames', 'true');
    commit(root);
  }
  return root;
}

const byPath = (r: { changes: Array<{ path: string; previous: string | undefined }> }) =>
  Object.fromEntries(r.changes.map((c) => [c.path, c.previous]));

describe('外のツールが変えたファイルの、前の中身', () => {
  test('きれいだった・変わっていた・無かった、のそれぞれで正しい「前」を返す', async () => {
    const root = await repo();
    await appendFile(join(root, 'dirty.txt'), 'edited by hand\n');   // 呼ぶ前から変わっている
    const outside = new OutsideChanges(root);
    await outside.before();
    // 外のツールの代わりに、こちらで変える。
    await writeFile(join(root, 'clean.txt'), 'tool wrote\n');          // きれいだったものを変えた
    await writeFile(join(root, 'dirty.txt'), 'tool overwrote\n');      // 変わっていたものをさらに変えた
    await writeFile(join(root, 'new.txt'), 'brand new\n');             // 無かったものを作った
    await rm(join(root, 'sub', 'gone.txt'));                           // きれいだったものを消した
    const r = await outside.after();
    assert.equal(r.comparable, true);
    assert.deepEqual(byPath(r), {
      'clean.txt': 'clean\n',                       // HEAD から
      'dirty.txt': 'committed\nedited by hand\n',   // 呼ぶ前に読んだもの（HEAD の姿ではない）
      'new.txt': undefined,                         // 前は無い
      'sub/gone.txt': 'gone\n',                     // 消されても HEAD から
    });
    assert.deepEqual(r.unrecorded, []);
    assert.deepEqual(outside.paths, ['clean.txt', 'dirty.txt', 'new.txt', 'sub/gone.txt']);
  });

  test('同じ道は最初の一度だけ。二度目の呼び出しでは返さない', async () => {
    const root = await repo();
    const outside = new OutsideChanges(root);
    await outside.before();
    await writeFile(join(root, 'clean.txt'), 'first\n');
    const one = await outside.after();
    await outside.before();
    await writeFile(join(root, 'clean.txt'), 'second\n');
    await writeFile(join(root, 'other.txt'), 'x\n');
    const two = await outside.after();
    assert.deepEqual(byPath(one), { 'clean.txt': 'clean\n' });
    assert.deepEqual(byPath(two), { 'other.txt': undefined }, '二度目に「前」を取り直している（後の中身が「前」になる）');
  });

  test('大きすぎるものは読まず、名前だけ返す', async () => {
    const root = await repo();
    await writeFile(join(root, 'big.txt'), 'x'.repeat(2048));          // 呼ぶ前から変わっていて、大きい
    const outside = new OutsideChanges(root, { maxBytes: 1024 });
    await outside.before();
    await writeFile(join(root, 'big.txt'), 'tool\n');
    const r = await outside.after();
    assert.deepEqual(byPath(r), {});
    assert.deepEqual(r.unrecorded, ['big.txt']);
  });

  test('HEAD に在るが大きすぎて取れないものも、名前だけ返す（「前は無い」と読まない）', async () => {
    const root = await repo();
    await writeFile(join(root, 'big.txt'), 'x'.repeat(2048));
    commit(root);                                                      // きれい。HEAD に在る
    const outside = new OutsideChanges(root, { maxBytes: 1024 });
    await outside.before();
    await writeFile(join(root, 'big.txt'), 'tool\n');
    const r = await outside.after();
    assert.deepEqual(byPath(r), {}, '取れないものを「前は無い」にしている（戻すと消える）');
    assert.deepEqual(r.unrecorded, ['big.txt']);
  });

  test('一回の合計にも上限がある。超えた分は名前だけ', async () => {
    const root = await repo();
    await writeFile(join(root, 'a.txt'), 'a'.repeat(600));            // どちらも呼ぶ前から変わっている
    await writeFile(join(root, 'b.txt'), 'b'.repeat(600));
    const outside = new OutsideChanges(root, { maxBytes: 1024, maxTotalBytes: 1000 });
    await outside.before();
    await writeFile(join(root, 'a.txt'), 'tool\n');
    await writeFile(join(root, 'b.txt'), 'tool\n');
    const r = await outside.after();
    assert.deepEqual(byPath(r), { 'a.txt': 'a'.repeat(600) });
    assert.deepEqual(r.unrecorded, ['b.txt']);
  });

  test('git の管理下でない作業場では、比べられないと言う', async () => {
    const root = await repo({ git: false });
    const outside = new OutsideChanges(root);
    await outside.before();
    await writeFile(join(root, 'clean.txt'), 'tool wrote\n');
    const r = await outside.after();
    assert.equal(r.comparable, false);
    assert.deepEqual(r.changes, []);
  });

  test('作業場がリポジトリの下のフォルダでも、道は作業場からで、HEAD も引ける', async () => {
    const root = await repo();
    const ws = join(root, 'sub');
    const outside = new OutsideChanges(ws);
    await outside.before();
    await writeFile(join(ws, 'gone.txt'), 'tool wrote\n');
    await writeFile(join(root, 'clean.txt'), 'outside the workspace\n');   // 作業場の外
    const r = await outside.after();
    assert.deepEqual(byPath(r), { 'gone.txt': 'gone\n' });
  });

  test('作業場がシンボリックリンク越しでも、道は作業場からで、HEAD も引ける', async (t) => {
    const root = await repo();
    const link = join(dirname(root), 'link');
    try { await symlink(root, link, 'dir'); } catch { t.skip('シンボリックリンクを作れない'); return; }
    const outside = new OutsideChanges(join(link, 'sub'));
    await outside.before();
    await writeFile(join(link, 'sub', 'gone.txt'), 'tool wrote\n');
    const r = await outside.after();
    assert.deepEqual(byPath(r), { 'gone.txt': 'gone\n' }, `道が作業場からになっていない: ${JSON.stringify(r)}`);
  });

  test('run_command が索引を動かしても（git rm / mv / add）、前の中身は HEAD から取る', async () => {
    const root = await repo();
    const outside = new OutsideChanges(root);
    await outside.before();
    git(root, 'rm', '-q', 'clean.txt');                                 // 索引からも作業ツリーからも消した
    git(root, 'mv', 'sub/gone.txt', 'sub/moved.txt');                   // 名前を変えた
    await writeFile(join(root, 'dirty.txt'), 'tool overwrote\n');
    git(root, 'add', 'dirty.txt');                                      // 変えて索引に入れた。索引はもう「前」ではない
    await writeFile(join(root, 'new.txt'), 'brand new\n');
    git(root, 'add', 'new.txt');                                        // 新しく作って索引に入れた
    const r = await outside.after();
    assert.deepEqual(byPath(r), {
      'clean.txt': 'clean\n',
      'dirty.txt': 'committed\n',
      'new.txt': undefined,
      'sub/gone.txt': 'gone\n',          // 元の名前へ戻す
      'sub/moved.txt': undefined,        // 新しい名前は消す
    });
    assert.deepEqual(r.unrecorded, []);
  });

  test('core.autocrlf が付いていれば、前の中身も作業ツリーの形（CRLF）で返す', async () => {
    const root = await repo();
    git(root, 'config', 'core.autocrlf', 'true');
    const outside = new OutsideChanges(root);
    await outside.before();
    await writeFile(join(root, 'clean.txt'), 'tool wrote\n');
    const r = await outside.after();
    assert.deepEqual(byPath(r), { 'clean.txt': 'clean\r\n' }, 'blob のまま返している（Windows で全行が差分になる）');
  });

  test('`git rm --cached`（追跡をやめるが作業ツリーには残す）を「前は無い」と読まない', async () => {
    const root = await repo();
    const outside = new OutsideChanges(root);
    await outside.before();
    git(root, 'rm', '-q', '--cached', 'clean.txt');                    // status は `D ` と `??` の二行
    const r = await outside.after();
    assert.deepEqual(byPath(r), { 'clean.txt': 'clean\n' }, '在るファイルを「前は無い」にしている（戻すと消える）');
  });

  test('`git mv` の後に元の名前へ書いた回は、元の名前を HEAD の中身へ戻す', async () => {
    const root = await repo();
    const outside = new OutsideChanges(root);
    await outside.before();
    git(root, 'mv', 'clean.txt', 'moved.txt');
    await writeFile(join(root, 'clean.txt'), 'export * from "./moved";\n');   // 元の名前は `??`
    const r = await outside.after();
    assert.deepEqual(byPath(r), { 'clean.txt': 'clean\n', 'moved.txt': undefined });
  });

  test('utf8 で往復しないもの（二進）は、呼ぶ前から変わっていても HEAD からでも、名前だけ返す', async () => {
    const root = await repo();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80, 0x81, 0xc3]);
    await writeFile(join(root, 'logo.png'), png);
    commit(root);                                                      // きれい → HEAD から
    await writeFile(join(root, 'dirty.png'), png);                     // 呼ぶ前から変わっている → 呼ぶ前に読む
    const sjis = Buffer.from([0x82, 0xa0, 0x82, 0xa2, 0x0a]);          // Shift_JIS の「あい」。NUL は無いが utf8 ではない
    await writeFile(join(root, 'memo.txt'), sjis);
    const outside = new OutsideChanges(root);
    await outside.before();
    await writeFile(join(root, 'logo.png'), 'tool\n');
    await writeFile(join(root, 'dirty.png'), 'tool\n');
    await writeFile(join(root, 'memo.txt'), 'tool\n');
    const r = await outside.after();
    assert.deepEqual(byPath(r), {}, '二進を文字列として持っている（戻すと壊れる）');
    assert.deepEqual(r.unrecorded, ['dirty.png', 'logo.png', 'memo.txt']);
  });

  test('HEAD ではリンクだったものを、リンク先の文字列のファイルとして戻さない', async (t) => {
    const root = await repo();
    try { await symlink('clean.txt', join(root, 'link')); } catch { t.skip('シンボリックリンクを作れない'); return; }
    commit(root);
    const outside = new OutsideChanges(root);
    await outside.before();
    await rm(join(root, 'link'));
    await writeFile(join(root, 'link'), 'now a file\n');               // status は ` T link`
    const r = await outside.after();
    assert.deepEqual(byPath(r), {}, 'リンク先の文字列を「前の中身」にしている');
    assert.deepEqual(r.unrecorded, ['link']);
  });

  test('作業場の上のフォルダの名前が空白で始まっても、変化が見える', async () => {
    const home = await tempDir('aas-outside-space-');
    const root = join(home, ' repo');                                   // 先頭が空白
    await mkdir(join(root, 'sub'), { recursive: true });
    await writeFile(join(root, 'sub', 'f.txt'), 'f\n');
    git(root, 'init', '-q');
    git(root, 'config', 'core.autocrlf', 'false');
    commit(root);
    const outside = new OutsideChanges(join(root, 'sub'));
    await outside.before();
    await writeFile(join(root, 'sub', 'f.txt'), 'tool\n');
    const r = await outside.after();
    assert.deepEqual(byPath(r), { 'f.txt': 'f\n' }, `変化が見えていない: ${JSON.stringify(r)}`);
  });
});
