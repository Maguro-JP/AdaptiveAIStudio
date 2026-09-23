/**
 * 確かめた木と、押す木が同じか。
 *
 * pre-push が見るのは**いまの作業の木**で、押されるのは git が push の時点で
 * 読み直した ref の先。同じだと思い込んでいたが、違う。10 分の確かめが試験の段を
 * 終えたあと、その裏で次の作業を commit した。確かめは前の木を見たまま
 * 「通りました」と言い、push は新しい commit を出した。
 * **一度も試験を通っていないものが、通った顔で外に出た。**
 *
 * 判断そのもの（`pushedTree`）と、**フックが本当に止めるところ**の両方を見る。
 * 前に同じ形のものを足したときは判断だけを試験にして、フックの側は手で押して
 * 確かめた。手で押した回は、別のファイルを巻き込んで**確かめたつもりになった**。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, copyFile, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tempDir } from './tmp.ts';
// @ts-expect-error 型定義を置かない開発用の script。ここだけ読む。
import { pushedTree } from '../scripts/pushed-tree.mjs';

const ZERO = '0'.repeat(40);
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

const clean = (head: string) => ({ head, dirty: [] as string[] });

describe('確かめた木と、押す木', () => {
  test('同じなら通す', () => {
    assert.equal(pushedTree({ sending: A, before: clean(A), after: clean(A) }), undefined);
  });

  test('**確かめている間に HEAD が動いたら止める**', () => {
    // 実際に起きたずれ方。確かめは A を見て、push は B を出した。
    const why = pushedTree({ sending: A, before: clean(A), after: clean(B) });
    assert.ok(why, '止めていない');
    assert.match(why, /動きました/);
    assert.match(why, /aaaaaaa/, `どの木を確かめたのかを言っていない: ${why}`);
    assert.match(why, /bbbbbbb/, `何が出るのかを言っていない: ${why}`);
  });

  test('commit していない直しがあれば止める', () => {
    const why = pushedTree({
      sending: A, before: { head: A, dirty: [' M src/a.ts'] }, after: clean(A),
    });
    assert.ok(why, '止めていない');
    assert.match(why, /src\/a\.ts/, `何が汚れているのかを言っていない: ${why}`);
    assert.match(why, /stash|commit/, `どうすればよいかを言っていない: ${why}`);
  });

  test('押す先が、いま出ている HEAD と違えば止める', () => {
    const why = pushedTree({ sending: B, before: clean(A), after: clean(A) });
    assert.ok(why, '止めていない');
    assert.match(why, /違います/);
  });

  test('確かめている間に汚れたら止める', () => {
    const why = pushedTree({
      sending: A, before: clean(A), after: { head: A, dirty: ['?? src/b.ts'] },
    });
    assert.ok(why, '止めていない');
    assert.match(why, /src\/b\.ts/);
  });

  test('押す先が突き合わせられないときは、突き合わせだけ飛ばす', () => {
    /*
     * タグを押すときの sha は commit ではないので、HEAD と比べると必ず食い違う。
     * 突き合わせは飛ばすが、**汚れているか・動いたかは見る**（確かめる木は同じ）。
     */
    assert.equal(pushedTree({ sending: '', before: clean(A), after: clean(A) }), undefined);
    assert.equal(pushedTree({ sending: ZERO, before: clean(A), after: clean(A) }), undefined);

    const dirty = pushedTree({ sending: '', before: { head: A, dirty: [' M x'] }, after: clean(A) });
    assert.ok(dirty, '汚れているのに通した');
    const moved = pushedTree({ sending: '', before: clean(A), after: clean(B) });
    assert.ok(moved, '動いたのに通した');
  });

  test('汚れが多いときは切る。全部並べると一行目が流れる', () => {
    const dirty = Array.from({ length: 30 }, (_, i) => ` M src/f${i}.ts`);
    const why = pushedTree({ sending: A, before: { head: A, dirty }, after: clean(A) });
    assert.ok(why);
    assert.match(why, /ほか 20 件/);
    assert.ok(why.split('\n').length < 20, `長すぎます: ${why.split('\n').length} 行`);
  });
});

/** 使い捨ての repository を組む。押す先も、フックも、確かめの代役も置く。 */
async function sandbox(check: string): Promise<{ work: string; remote: string; ran: string }> {
  const base = await tempDir('aas-pushed-tree-');
  const remote = join(base, 'remote.git');
  const work = join(base, 'work');
  const here = join(import.meta.dirname, '..');

  execFileSync('git', ['init', '--bare', '-q', remote]);
  await mkdir(join(work, 'scripts'), { recursive: true });
  await mkdir(join(work, '.githooks'), { recursive: true });
  await mkdir(join(work, 'src'), { recursive: true });

  /*
   * scripts/ は**丸ごと**写す。名前を並べていたら、`git-tree.mjs` を切り出した
   * ときに写し漏れて 7 件落ちた。フックが呼ぶ物の依存まで数え上げるのは、
   * 足すたびに漏れる形。並べずに全部持っていく。
   */
  for (const f of await readdir(join(here, 'scripts'))) {
    if (f.endsWith('.mjs')) await copyFile(join(here, 'scripts', f), join(work, 'scripts', f));
  }
  await copyFile(join(here, '.githooks', 'pre-push'), join(work, '.githooks', 'pre-push'));
  /*
   * 確かめの代役。10 分の本物は回せないので、同じ場所で同じことをする物を置く。
   * **走ったことが分かる形**にしておく（走らせずに止めたかを見るため）。
   *
   * マーカーは作業の木の**外**へ置く。中に置くと、それ自体が「汚れ」として数えられて
   * 通る回まで止まる（実際に止めた）。
   */
  const ran = join(base, 'ran.txt');
  await writeFile(join(work, 'scripts', 'check.mjs'),
    "import { writeFileSync } from 'node:fs';\n"
    + `writeFileSync(${JSON.stringify(ran)}, 'ran');\n` + check);
  await writeFile(join(work, 'src', 'a.ts'), 'export const a = 1;\n');

  const git = (...args: string[]) => execFileSync('git', args, { cwd: work, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'test');
  git('config', 'core.hooksPath', '.githooks');
  git('remote', 'add', 'origin', remote);
  git('add', '-A');
  git('commit', '-q', '-m', '最初のコミット');
  return { work, remote, ran };
}

/** 押してみる。止まったかどうかと、出てきた文を返す。 */
function push(work: string, args: string[] = ['-u', 'origin', 'main']): { ok: boolean; text: string } {
  // `node` を PATH に載せる。フックは `node` と書いて呼ぶ。
  const env = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}` };
  try {
    const out = execFileSync('git', ['push', ...args],
      { cwd: work, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, text: out };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, text: `${err.stdout ?? ''}\n${err.stderr ?? ''}` };
  }
}

describe('フックが、本当に止める', () => {
  test('確かめが通って、木が動いていなければ押せる', async () => {
    const { work, ran } = await sandbox('process.exit(0);\n');
    const r = push(work);
    assert.equal(r.ok, true, `押せていない: ${r.text}`);
    assert.equal(existsSync(ran), true, '確かめが走っていない');
  });

  test('**確かめの最中に HEAD が動いたら、押さない**', async () => {
    /*
     * 実際のずれ方をそのまま作る。確かめ（の代役）が走っている間に commit する。
     * 本物は 10 分かかるので、その間に別の作業を commit できる。
     */
    const { work, ran } = await sandbox(
      "import { execFileSync } from 'node:child_process';\n"
      + "const at = new URL('../src/b.ts', import.meta.url);\n"
      + "writeFileSync(at, 'export const b = 2;\\n');\n"
      + "const cwd = new URL('..', import.meta.url).pathname;\n"
      + "execFileSync('git', ['add', '-A'], { cwd });\n"
      + "execFileSync('git', ['commit', '-q', '-m', '確かめの裏で入れた'], { cwd });\n"
      + 'process.exit(0);\n');
    const r = push(work);
    assert.equal(existsSync(ran), true, '確かめが走っていない');
    assert.equal(r.ok, false, `押せてしまった: ${r.text}`);
    assert.match(r.text, /動きました/, `理由を言っていない: ${r.text}`);
  });

  test('**汚れているなら、確かめを走らせる前に止める**', async () => {
    // 10 分待たせてから「汚れています」と言わない。
    const { work, ran } = await sandbox('process.exit(0);\n');
    await writeFile(join(work, 'src', 'a.ts'), 'export const a = 2;\n');
    const r = push(work);
    assert.equal(r.ok, false, `押せてしまった: ${r.text}`);
    assert.match(r.text, /commit していない/, `理由を言っていない: ${r.text}`);
    assert.equal(existsSync(ran), false, '確かめを走らせてしまった（待たせている）');
  });

  test('確かめの最中に汚れたら、押さない', async () => {
    const { work } = await sandbox(
      "writeFileSync(new URL('../src/a.ts', import.meta.url), 'export const a = 3;\\n');\n"
      + 'process.exit(0);\n');
    const r = push(work);
    assert.equal(r.ok, false, `押せてしまった: ${r.text}`);
    assert.match(r.text, /直しができました|直しが/, `理由を言っていない: ${r.text}`);
  });

  test('**タグは押せる（release の道を塞がない）**', async () => {
    /*
     * `v*` のタグを押すと release.yml が動く。タグの sha は commit ではないので、
     * HEAD と突き合わせると**必ず食い違って、配る道が丸ごと塞がる。**
     * 突き合わせを飛ばしていることを、ここで押さえる。
     */
    const { work } = await sandbox('process.exit(0);\n');
    execFileSync('git', ['tag', 'v0.0.1'], { cwd: work });
    const r = push(work, ['origin', 'v0.0.1']);
    assert.equal(r.ok, true, `タグが押せない: ${r.text}`);
  });

  test('タグでも、汚れていれば止める（対）', async () => {
    // 飛ばすのは突き合わせだけ。確かめる木が汚れていることは、タグでも同じ。
    const { work } = await sandbox('process.exit(0);\n');
    execFileSync('git', ['tag', 'v0.0.2'], { cwd: work });
    await writeFile(join(work, 'src', 'a.ts'), 'export const a = 9;\n');
    const r = push(work, ['origin', 'v0.0.2']);
    assert.equal(r.ok, false, `押せてしまった: ${r.text}`);
    assert.match(r.text, /commit していない/);
  });

  test('ブランチを消す push は、汚れていても通す（対）', async () => {
    /*
     * 消す push は木を運んでいない。確かめようがないので、汚れを理由に止めない。
     * ここで止めると、手元に直しがある間は片付けができなくなる。
     */
    const { work } = await sandbox('process.exit(0);\n');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: work, encoding: 'utf8' });
    git('branch', 'gone');
    assert.equal(push(work, ['origin', 'gone']).ok, true);
    await writeFile(join(work, 'src', 'a.ts'), 'export const a = 8;\n');
    const r = push(work, ['origin', ':gone']);
    assert.equal(r.ok, true, `消せない: ${r.text}`);
  });

  test('確かめが落ちたら、もちろん押さない（対）', async () => {
    const { work } = await sandbox('process.exit(1);\n');
    const r = push(work);
    assert.equal(r.ok, false, `押せてしまった: ${r.text}`);
  });
});

describe('使うものが、そろっている', () => {
  test('フックが、この二つを呼んでいる', async () => {
    /*
     * 判断を書いても、呼ばれなければ何も守らない。**呼ぶ行を見る。**
     * 前に同じ形のもので、案内だけ残して探しに行く行を消しても通った。
     */
    const hook = await readFile(join(import.meta.dirname, '..', '.githooks', 'pre-push'), 'utf8');
    assert.match(hook, /pushed-tree-check\.mjs before/, '前の確かめを呼んでいない');
    assert.match(hook, /pushed-tree-check\.mjs after/, '後の確かめを呼んでいない');
    // 後の確かめは、本物の確かめより後に置く（動いたかどうかは後でしか分からない）。
    assert.ok(
      hook.indexOf('node scripts/check.mjs') < hook.indexOf('pushed-tree-check.mjs after'),
      '後の確かめが、確かめより前に置かれています',
    );
  });
});
