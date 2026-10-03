/**
 * 作業場の外へ出さない、をリンク越しでも守ること。
 *
 * 文字の上で中でも、実体が外なら外。モデルは ln -s を打てる。
 * リンクを作れない機械（Windows の一般権限）では、その検査は飛ばす。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir, writeFile, symlink, realpath } from 'node:fs/promises';
import { tempDir } from './tmp.ts';
import { realSafeResolve, safeResolve, toDisplayPath } from '../src/agent/tools/paths.ts';
import { writeFileTool, readFileTool } from '../src/agent/tools/fs.ts';
import type { ToolContext } from '../src/agent/tools/types.ts';

async function canLink(): Promise<boolean> {
  const d = await tempDir('aas-ln-');
  await writeFile(join(d, 'a'), 'x');
  try { await symlink(join(d, 'a'), join(d, 'b')); return true; } catch { return false; }
}
const linkable = await canLink();
const onlyWithLinks = { skip: linkable ? false : 'この機械ではリンクを作れない' };

function ctx(root: string): ToolContext {
  return { root, signal: new AbortController().signal, approve: async () => true } as ToolContext;
}

describe('リンクの先まで見る', () => {
  test('外を指すリンク越しの道は、外', onlyWithLinks, async () => {
    const outside = await tempDir('aas-out-');
    await writeFile(join(outside, 'secret'), 'S');
    const root = await tempDir('aas-root-');
    await symlink(outside, join(root, 'link'));
    // 文字の上では中に見える。
    assert.ok(safeResolve(root, 'link/secret'));
    // 実体は外。
    assert.equal(await realSafeResolve(root, 'link/secret'), undefined);
  });

  test('中を指すリンクは中（対）', onlyWithLinks, async () => {
    const root = await tempDir('aas-root-');
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'a.ts'), 'x');
    await symlink(join(root, 'src'), join(root, 'alias'));
    const got = await realSafeResolve(root, 'alias/a.ts');
    // 返るのは、**渡した root の綴りのまま**。リンクは辿るが、
    // 実体の綴りに置き換えては返さない（下の「渡した綴りのまま返す」を見る）。
    assert.equal(got, join(root, 'src', 'a.ts'));
  });

  test('まだ無いファイルは、在る所まで遡って決める', async () => {
    const root = await tempDir('aas-root-');
    await mkdir(join(root, 'src'));
    assert.ok(await realSafeResolve(root, 'src/new/deep.ts'));
    assert.equal(await realSafeResolve(root, '../x.ts'), undefined);
  });
});

/**
 * 作業場そのものが、実体と違う綴りで渡ってくることがある。
 *
 * Windows の CI で実際に壊れた。`%TEMP%` が `C:\Users\RUNNER~1\...`（8.3 の
 * 短い名前）なのに realpath は `C:\Users\runneradmin\...` を返す。返る道を
 * 実体の綴りにしていたので、控える道が `../../../../../runneradmin/...` になり、
 * **戻す（undo）が何も戻さずに黙って終わっていた**（safeResolve が `..` を弾くため）。
 *
 * 利用者の機械でも、junction・ネットワークの割り当て・OneDrive の付け替えで同じ形になる。
 * ここは linux でも symlink を根にすれば同じ形が作れるので、リンクで確かめる。
 */
describe('根が実体と違う綴りでも、道が壊れない', () => {
  /** 実体のフォルダと、それを指すリンクを作って、リンクの方を根として渡す。 */
  async function linkedRoot(): Promise<{ asRoot: string; real: string }> {
    const base = await tempDir('aas-linkroot-');
    const real = join(base, 'real');
    const asRoot = join(base, 'asroot');
    await mkdir(real);
    await symlink(real, asRoot);
    return { asRoot, real };
  }

  test('**返る道は、渡した綴りのまま**', onlyWithLinks, async () => {
    const { asRoot, real } = await linkedRoot();
    await writeFile(join(real, 'math.js'), 'x');
    const got = await realSafeResolve(asRoot, 'math.js');
    assert.equal(got, join(asRoot, 'math.js'),
      `実体の綴りで返している。渡した根: ${asRoot}`);
  });

  test('**控えた道で、戻せる**（これが効かないと undo が黙って死ぬ）', onlyWithLinks, async () => {
    const { asRoot, real } = await linkedRoot();
    await writeFile(join(real, 'math.js'), 'x');
    const abs = await realSafeResolve(asRoot, 'math.js');
    assert.ok(abs);
    // 控えるのはこの形（undo も、変えたファイルの一覧も、これを持つ）。
    const display = toDisplayPath(asRoot, abs);
    assert.equal(display, 'math.js', '控える道が相対の形になっていない');
    // 戻す側は safeResolve を通す。`..` で始まると弾かれて、黙って何もしない。
    assert.ok(safeResolve(asRoot, display), '控えた道から戻せない');
  });

  test('根そのものを指したときも、渡した綴りで返す', onlyWithLinks, async () => {
    const { asRoot } = await linkedRoot();
    assert.equal(await realSafeResolve(asRoot, '.'), asRoot);
  });

  test('**綴りをそろえても、外へは出さない（対）**', onlyWithLinks, async () => {
    // 綴りを合わせるのは外に返す道だけで、中か外かは実体で見る。ここを緩めない。
    const { asRoot } = await linkedRoot();
    const outside = await tempDir('aas-linkout-');
    await writeFile(join(outside, 'secret'), 'S');
    await symlink(outside, join(asRoot, 'link'));
    assert.equal(await realSafeResolve(asRoot, 'link/secret'), undefined,
      '外を指すリンクを通してしまっている');
    assert.equal(await realSafeResolve(asRoot, '../secret'), undefined);
  });
});

describe('道具も、リンク越しには出ない・書かない', () => {
  test('外を指すリンク越しには読めない', onlyWithLinks, async () => {
    const outside = await tempDir('aas-out-');
    await writeFile(join(outside, 'secret'), 'S');
    const root = await tempDir('aas-root-');
    await symlink(outside, join(root, 'link'));
    const r = await readFileTool.run({ path: 'link/secret' }, ctx(root));
    assert.equal(r.isError, true);
  });

  test('リンクそのものには書かない', onlyWithLinks, async () => {
    const root = await tempDir('aas-root-');
    await writeFile(join(root, '.env'), 'SECRET=1');
    await symlink(join(root, '.env'), join(root, 'link'));
    const r = await writeFileTool.run({ path: 'link', content: 'SECRET=2' }, ctx(root));
    assert.equal(r.isError, true);
    const { readFile } = await import('node:fs/promises');
    assert.equal(await readFile(join(root, '.env'), 'utf8'), 'SECRET=1', 'リンク越しに書き換わった');
  });

  test('ふつうのファイルには書ける（対）', async () => {
    const root = await tempDir('aas-root-');
    const r = await writeFileTool.run({ path: 'a.txt', content: 'x' }, ctx(root));
    assert.notEqual(r.isError, true);
  });
});

describe('.. で始まる名前は、中のファイル', () => {
  /** `rel.startsWith('..')` で見ていたので、作業場の中の `..foo` のような名前まで外として断っていた。 */
  test('outsideRel は最初の区切りが .. のときだけ外', async () => {
    const { outsideRel, safeResolve } = await import('../src/agent/tools/paths.ts');
    const { sep, join, resolve } = await import('node:path');
    assert.equal(outsideRel('..foo'), false);
    assert.equal(outsideRel(`..env${sep}bak`), false);
    assert.equal(outsideRel('..'), true);
    assert.equal(outsideRel(`..${sep}x`), true);
    // Windows は区切りの末の点と空白を落とすので、`.. ` や `...` は `..` になりうる。断る側
    assert.equal(outsideRel('.. '), true);
    assert.equal(outsideRel(`...${sep}x`), true);
    // 根は絶対の道にする。`join(sep, 'work')` は Windows ではドライブの無い `\work` で、
    // safeResolve が resolve で付けるドライブ（`D:\work\..foo`）と綴りが合わなかった。
    const root = resolve(sep, 'work');
    assert.equal(safeResolve(root, '..foo'), join(root, '..foo'));
    assert.equal(safeResolve(root, '../foo'), undefined);
    assert.equal(safeResolve(root, 'a/../../foo'), undefined);
  });
});
