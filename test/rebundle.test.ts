/**
 * bundle を組み直すとき（置いたものを戻す・退避フォルダを残す・改名）。
 *
 * 1 件ごとに配る形を写すので重い（手元で 10〜30 秒）。home.test.ts に同居していたので、
 * 入れた機械の env で home.test.ts を丸ごと走らせる試験（installed-env.test.ts）が、
 * Windows で 300 秒の上限を超えて落ちていた。根の決め方とは別のファイルにする。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tempDir } from './tmp.ts';
import { installRoot } from '../src/core/home.ts';

describe('bundle を組み直すとき', () => {
  test('data（portable ではモデル・設定・会話が入っている）は残し、前に組んだものは片づける', async () => {
    const out = await tempDir('aas-rebundle-');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(out, 'data', 'models'), { recursive: true });
    await writeFile(join(out, 'data', 'models', 'keep.gguf'), 'GGUF');
    await mkdir(join(out, 'app'), { recursive: true });
    await writeFile(join(out, 'app', 'stale.txt'), '前に組んだ残り');
    const { bundle } = await import('../scripts/bundle.mjs');
    await bundle({ out, srcRoot: installRoot(), version: 'test-rebundle', keepData: true });
    assert.equal(await readFile(join(out, 'data', 'models', 'keep.gguf'), 'utf8'), 'GGUF', '組み直したら data が消えた');
    assert.equal(existsSync(join(out, 'app', 'stale.txt')), false, '前に組んだものが残っている');
    assert.ok(existsSync(join(out, 'AdaptiveAIStudio.cmd')));
    // 頼まれなければ残さない（開発者の手元で組み直した bundle に、その人の会話やモデルを載せて配らない）
    await bundle({ out, srcRoot: installRoot(), version: 'test-rebundle' });
    assert.equal(existsSync(join(out, 'data')), false, '頼まれていないのに data を残した');
  });

  test('**組む途中で落ちたら、置いたものを消して前の版に戻す**（前の版を先に消していたので、動く版が一つも残らなかった）', async () => {
    const out = await tempDir('aas-rebundle-fail-');
    const { readdir } = await import('node:fs/promises');
    const { bundle } = await import('../scripts/bundle.mjs');
    await bundle({ out, srcRoot: installRoot(), version: 'test-good' });
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(out, 'data'), { recursive: true });
    await writeFile(join(out, 'data', 'keep.txt'), '利用者の data');
    // 無い zip を渡すと、app を置き始めた後（Node を取り出すところ）で落ちる
    await assert.rejects(bundle({ out, srcRoot: installRoot(), version: 'test-broken', keepData: true, nodeZip: join(out, 'no-such.zip') }));
    assert.match(await readFile(join(out, 'VERSION'), 'utf8'), /test-good/, '前の版に戻っていない');
    assert.ok(existsSync(join(out, 'AdaptiveAIStudio.cmd')));
    assert.ok(existsSync(join(out, 'app', 'package.json')));
    assert.equal(await readFile(join(out, 'data', 'keep.txt'), 'utf8'), '利用者の data');
    assert.deepEqual((await readdir(out)).filter((n) => n.startsWith('.old-')), [], '退避フォルダが残っている');
  });

  test('**前の回に戻しきれず残した版（退避フォルダ）は、組めるまで消さない**', async () => {
    // 先に消していたので、「残してあります」と言った版を、もう一度押しただけで消していた
    const out = await tempDir('aas-rebundle-stuck-');
    const { mkdir, readdir } = await import('node:fs/promises');
    const { bundle } = await import('../scripts/bundle.mjs');
    await bundle({ out, srcRoot: installRoot(), version: 'test-good' });
    await mkdir(join(out, '.old-999-1'), { recursive: true });
    await writeFile(join(out, '.old-999-1', 'VERSION'), '前の回に残した版');
    await assert.rejects(bundle({ out, srcRoot: installRoot(), version: 'test-broken', nodeZip: join(out, 'no-such.zip') }));
    assert.equal(await readFile(join(out, '.old-999-1', 'VERSION'), 'utf8'), '前の回に残した版', '組めなかった回で、残した版を消した');
    await bundle({ out, srcRoot: installRoot(), version: 'test-good-again' });
    assert.deepEqual((await readdir(out)).filter((n) => n.startsWith('.old-')), [], '組めたのに退避フォルダが残っている');
  });

  test('**組み立て元の node_modules がリンクでも、写すのは中身で、組み立て元の型定義と .map を消さない**', async () => {
    const { mkdir, readdir, symlink, copyFile, stat } = await import('node:fs/promises');
    const { lstatSync } = await import('node:fs');
    const { bundle, PAYLOAD, launcherIn } = await import('../scripts/bundle.mjs');
    // 組み立て元: 製品の中身はフォルダごとリンクし（Windows では junction）、node_modules だけ作り物にする
    const src = await tempDir('aas-linked-src-');
    for (const item of PAYLOAD) {
      if (item === 'node_modules') continue;
      const from = join(installRoot(), item);
      const s = await stat(from).catch(() => undefined);
      if (!s) continue;
      if (s.isDirectory()) await symlink(from, join(src, item), 'junction');
      else await copyFile(from, join(src, item));
    }
    // 入口は、リポジトリでは launcher.cmd、bundle の中では一つ上の AdaptiveAIStudio.cmd にある。どちらで走らせても同じになるよう、
    // 見つけた方を launcher.cmd として置く
    await copyFile(launcherIn(installRoot()), join(src, 'launcher.cmd'));
    const modules = await tempDir('aas-linked-modules-');
    await mkdir(join(modules, 'pkg'), { recursive: true });
    await writeFile(join(modules, 'pkg', 'index.d.ts'), 'export {};');
    await writeFile(join(modules, 'pkg', 'index.js.map'), '{}');
    await writeFile(join(modules, 'pkg', 'index.js'), '');
    await symlink(modules, join(src, 'node_modules'), 'junction');
    const out = await tempDir('aas-linked-out-');
    await bundle({ out, srcRoot: src, version: 'test-linked' });
    assert.deepEqual((await readdir(join(modules, 'pkg'))).sort(), ['index.d.ts', 'index.js', 'index.js.map'], '組み立て元の中身を消した');
    assert.equal(lstatSync(join(out, 'app', 'node_modules')).isSymbolicLink(), false, '配る先にリンクを入れた');
    assert.ok(existsSync(join(out, 'app', 'node_modules', 'pkg', 'index.js')));
  });

  test('組んだものでないフォルダを出力先に渡されたら、組まずに止め、中身を消さない', async () => {
    // 中に入れてくれるつもりで既存のフォルダ（デスクトップなど）を渡すと、data 以外の中身がすべて消えていた
    const out = await tempDir('aas-rebundle-foreign-');
    await writeFile(join(out, 'notes.txt'), '利用者のメモ');
    const { bundle } = await import('../scripts/bundle.mjs');
    await assert.rejects(bundle({ out, srcRoot: installRoot(), version: 'test-foreign', keepData: true }), /組んだものでない/);
    assert.equal(await readFile(join(out, 'notes.txt'), 'utf8'), '利用者のメモ', '利用者のファイルを消した');
  });

  test('前に組んだもの（見分けの元あり）なら、前の版の形で残った名前も片づける（対）', async () => {
    const out = await tempDir('aas-rebundle-old-');
    await writeFile(join(out, '.portable'), 'x');
    await writeFile(join(out, 'start-old.cmd'), '前の版の入口');
    const { bundle } = await import('../scripts/bundle.mjs');
    await bundle({ out, srcRoot: installRoot(), version: 'test-old-layout' });
    assert.equal(existsSync(join(out, 'start-old.cmd')), false, '前の版の残りを片づけていない');
  });

  test('いま入れてある版が動いていて runtime を動かせないなら、何も消さずに止める', async () => {
    // Windows では読み込み中の node.exe が消せず、app を途中まで消したところで投げ、元の版にも戻れなかった
    const out = await tempDir('aas-rebundle-busy-');
    const { mkdir } = await import('node:fs/promises');
    await writeFile(join(out, '.portable'), 'x');
    await mkdir(join(out, 'app'), { recursive: true });
    await writeFile(join(out, 'app', 'kept.txt'), '動いている版');
    await mkdir(join(out, 'runtime'), { recursive: true });
    const busy = async () => { throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }); };
    const { bundle } = await import('../scripts/bundle.mjs');
    await assert.rejects(bundle({ out, srcRoot: installRoot(), version: 'test-busy', renameImpl: busy }), /閉じてから/);
    assert.equal(await readFile(join(out, 'app', 'kept.txt'), 'utf8'), '動いている版', '止める前に消した');
    assert.ok(existsSync(join(out, '.portable')));
  });

  test('runtime 以外（app）が掴まれていても、先に移した分を戻して、何も消さずに止める', async () => {
    // runtime だけを確かめていたので、ほかが掴まれていると途中まで消えた。全部を退避へ移し、移せなければ戻す
    const { mkdir, readdir, rename } = await import('node:fs/promises');
    const out = await tempDir('aas-rebundle-partial-');
    await writeFile(join(out, '.portable'), 'x');
    await mkdir(join(out, 'app'), { recursive: true });
    await writeFile(join(out, 'app', 'kept.txt'), '動いている版');
    await mkdir(join(out, 'runtime'), { recursive: true });
    await writeFile(join(out, 'runtime', 'node.exe'), 'old');
    // runtime は動かせるが、app の中の読み込み中のもの（.node）で app が動かせない
    const lockedRuntime = async (from: string, to: string) => {
      if (/[\\/]app$/.test(from)) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      return rename(from, to);
    };
    const { bundle } = await import('../scripts/bundle.mjs');
    await assert.rejects(bundle({ out, srcRoot: installRoot(), version: 'test-partial', renameImpl: lockedRuntime }), /何も消していません/);
    assert.equal(await readFile(join(out, 'app', 'kept.txt'), 'utf8'), '動いている版', '移した分を戻していない');
    assert.ok(existsSync(join(out, '.portable')) && existsSync(join(out, 'runtime', 'node.exe')));
    assert.deepEqual((await readdir(out)).filter((n) => n.startsWith('.old-')), [], '退避フォルダが残っている');
  });

  test('**前の回に戻しきれず残した版（退避フォルダ）は、組めるまで消さない**', async () => {
    // 先に消していたので、「残してあります」と言った版を、もう一度押しただけで消していた
    const out = await tempDir('aas-rebundle-stuck-');
    const { mkdir, readdir } = await import('node:fs/promises');
    const { bundle } = await import('../scripts/bundle.mjs');
    await bundle({ out, srcRoot: installRoot(), version: 'test-good' });
    await mkdir(join(out, '.old-999-1'), { recursive: true });
    await writeFile(join(out, '.old-999-1', 'VERSION'), '前の回に残した版');
    await assert.rejects(bundle({ out, srcRoot: installRoot(), version: 'test-broken', nodeZip: join(out, 'no-such.zip') }));
    assert.equal(await readFile(join(out, '.old-999-1', 'VERSION'), 'utf8'), '前の回に残した版', '組めなかった回で、残した版を消した');
    await bundle({ out, srcRoot: installRoot(), version: 'test-good-again' });
    assert.deepEqual((await readdir(out)).filter((n) => n.startsWith('.old-')), [], '組めたのに退避フォルダが残っている');
  });

  test('改名が通るときは、古い runtime も退避フォルダも残さずに組み直す（対）', async () => {
    const { mkdir, readdir } = await import('node:fs/promises');
    const out = await tempDir('aas-rebundle-move-');
    await writeFile(join(out, '.portable'), 'x');
    await mkdir(join(out, 'runtime'), { recursive: true });
    await writeFile(join(out, 'runtime', 'stale-node.exe'), 'old');
    await mkdir(join(out, '.old-1-1'), { recursive: true }); // 前に途中で残った退避
    const { bundle } = await import('../scripts/bundle.mjs');
    await bundle({ out, srcRoot: installRoot(), version: 'test-move' });
    assert.equal(existsSync(join(out, 'runtime', 'stale-node.exe')), false, '古い runtime が残っている');
    assert.deepEqual((await readdir(out)).filter((n) => n.startsWith('.old-')), [], '退避フォルダが残っている');
    assert.ok(existsSync(join(out, 'AdaptiveAIStudio.cmd')));
  });

  test('VERSION と app を持つ別のプロジェクトを、前に組んだものと見なさない', async () => {
    const { mkdir } = await import('node:fs/promises');
    const out = await tempDir('aas-rebundle-rails-');
    await writeFile(join(out, 'VERSION'), '1.0.0');
    await mkdir(join(out, 'app'), { recursive: true });
    await writeFile(join(out, 'Gemfile'), 'source "x"');
    const { bundle } = await import('../scripts/bundle.mjs');
    await assert.rejects(bundle({ out, srcRoot: installRoot(), version: 'test-rails' }), /組んだものでない/);
    assert.ok(existsSync(join(out, 'Gemfile')));
  });

  test('desktop.ini・Thumbs.db だけのフォルダは、断らずに組む（対）', async () => {
    const out = await tempDir('aas-rebundle-ini-');
    await writeFile(join(out, 'desktop.ini'), '[.ShellClassInfo]');
    await writeFile(join(out, 'Thumbs.db'), 'x');
    const { bundle } = await import('../scripts/bundle.mjs');
    await bundle({ out, srcRoot: installRoot(), version: 'test-ini' });
    assert.ok(existsSync(join(out, 'AdaptiveAIStudio.cmd')));
  });

  test('元が出力先の中にあれば組まずに止め、元を消さない', async () => {
    const out = await tempDir('aas-rebundle-inside-');
    const { mkdir } = await import('node:fs/promises');
    const src = join(out, '.setup', 'src');
    await mkdir(src, { recursive: true });
    await writeFile(join(src, 'marker.txt'), 'x');
    const { bundle } = await import('../scripts/bundle.mjs');
    await assert.rejects(bundle({ out, srcRoot: src, version: 'test-inside' }), /中にあります/);
    assert.ok(existsSync(join(src, 'marker.txt')), '止める前に元を消した');
  });
});
