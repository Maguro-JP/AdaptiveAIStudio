/**
 * 確かめたワークツリーと、押すワークツリーが同じか。
 *
 * pre-push が見るのは**いまの作業のワークツリー**で、押されるのは git が push の時点で
 * 読み直した ref の先。同じだと思い込んでいたが、違う。10 分の確かめが試験の段を
 * 終えたあと、その裏で次の作業を commit した。確かめは前のワークツリーを見たまま
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
import { join, dirname, delimiter } from 'node:path';
import { tempDir } from './tmp.ts';
// @ts-expect-error 型定義を置かない開発用の script。ここだけ読む。
import { pushedTree } from '../scripts/pushed-tree.mjs';

const ZERO = '0'.repeat(40);
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

const clean = (head: string) => ({ head, dirty: [] as string[] });

/**
 * フックを見る試験だけに付ける条件。
 *
 * `.githooks/` は作業場にだけ在り、bundle には入れない（利用者の手元で push はしない）。
 * bundle の中で走らせると、写す元が無くて落ちる。それは嘘の赤なので、飛ばしてそう言う。
 * 判断そのもの（`pushedTree`）の試験は、どこでも走らせる。
 *
 * **フックが在るかで決めない。**それだと作業場でフックを消したとき、フックを守る
 * 試験が落ちる代わりに黙って飛ぶ。bundle であること（一つ上に `.portable` が在る）か、git の
 * クローンでないことで決める。
 */
const inBundle = existsSync(join(import.meta.dirname, '..', '..', '.portable'))
  || !existsSync(join(import.meta.dirname, '..', '.git'));
const sourceOnly = inBundle
  ? { skip: 'フックは作業場にしか無いので、bundle では確かめられません' }
  : {};

describe('確かめたワークツリーと、押すワークツリー', () => {
  test('同じなら通す', () => {
    assert.equal(pushedTree({ sending: A, before: clean(A), after: clean(A) }), undefined);
  });

  test('**確かめている間に HEAD が動いたら止める**', () => {
    // 実際に起きたずれ方。確かめは A を見て、push は B を出した。
    const why = pushedTree({ sending: A, before: clean(A), after: clean(B) });
    assert.ok(why, '止めていない');
    assert.match(why, /動きました/);
    assert.match(why, /aaaaaaa/, `どのワークツリーを確かめたのかを言っていない: ${why}`);
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
     * 突き合わせは飛ばすが、**汚れているか・動いたかは見る**（確かめるワークツリーは同じ）。
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
   * マーカーは作業のワークツリーの**外**へ置く。中に置くと、それ自体が「汚れ」として数えられて
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
  // 区切りは `delimiter`（Windows は `;`）。名前も元の綴り（Windows は `Path`）に合わせる。
  // `PATH` を別に足すと二つ並び、子へはどちらか一方しか渡らない。
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const env = { ...process.env, [key]: `${dirname(process.execPath)}${delimiter}${process.env[key] ?? ''}` };
  try {
    const out = execFileSync('git', ['push', ...args],
      { cwd: work, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, text: out };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, text: `${err.stdout ?? ''}\n${err.stderr ?? ''}` };
  }
}

describe('フックが、本当に止める', sourceOnly, () => {
  test('確かめが通って、ワークツリーが動いていなければ押せる', async () => {
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
      // `.pathname` は Windows で `/C:/Users/...` になり、cwd として無い道なので git を起こせない（ENOENT）
      + "import { fileURLToPath } from 'node:url';\n"
      + "const cwd = fileURLToPath(new URL('..', import.meta.url));\n"
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
    // 飛ばすのは突き合わせだけ。確かめるワークツリーが汚れていることは、タグでも同じ。
    const { work } = await sandbox('process.exit(0);\n');
    execFileSync('git', ['tag', 'v0.0.2'], { cwd: work });
    await writeFile(join(work, 'src', 'a.ts'), 'export const a = 9;\n');
    const r = push(work, ['origin', 'v0.0.2']);
    assert.equal(r.ok, false, `押せてしまった: ${r.text}`);
    assert.match(r.text, /commit していない/);
  });

  test('ブランチを消す push は、汚れていても通す（対）', async () => {
    /*
     * 消す push はワークツリーを運んでいない。確かめようがないので、汚れを理由に止めない。
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

  test('**押すツリーが外の main と同じなら、確かめを走らせずに押せる**', async () => {
    // マージの後に作業のブランチを main へ合わせ直す push。外に新しいものは出ない。
    const { work, ran } = await sandbox('process.exit(1);\n');   // 走れば落ちる代役
    // 先に main を外へ出しておく（確かめを走らせない形で。ここは手順の準備）。
    execFileSync('git', ['push', '-q', '--no-verify', '-u', 'origin', 'main'], { cwd: work });
    execFileSync('git', ['checkout', '-q', '-b', 'feature'], { cwd: work });
    const r = push(work, ['-u', 'origin', 'feature']);
    assert.equal(r.ok, true, `押せていない: ${r.text}`);
    assert.match(r.text, /origin\/main と同じ/, `飛ばした理由を言っていない: ${r.text}`);
    assert.equal(existsSync(ran), false, '外に新しいものが無いのに確かめを走らせた');
  });

  test('**main に文書だけの更新が入った後の合わせ直しも、文書だけの push として止めない**', async () => {
    // スキルの更新（.claude/ だけ）が main に入った後、作業のブランチを main へ合わせ直して押す形。
    // 前のブランチとの差は文書だけだが、押すツリーは外の main と同じなので、外に新しいものは出ない。
    const { work, ran } = await sandbox('process.exit(1);\n');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: work, encoding: 'utf8' });
    git('push', '-q', '--no-verify', '-u', 'origin', 'main');
    git('checkout', '-q', '-b', 'feature');
    git('push', '-q', '--no-verify', '-u', 'origin', 'feature');
    git('checkout', '-q', 'main');
    await writeFile(join(work, 'README.md'), '# 更新\n');
    git('add', '-A');
    git('commit', '-q', '-m', '文書だけ');
    git('push', '-q', '--no-verify', 'origin', 'main');
    git('checkout', '-q', '-B', 'feature', 'main');
    const r = push(work, ['--force-with-lease', 'origin', 'feature']);
    assert.equal(r.ok, true, `押せていない（文書だけの push として止めた？）: ${r.text}`);
    assert.match(r.text, /origin\/main と同じ/, `飛ばした理由を言っていない: ${r.text}`);
    assert.equal(existsSync(ran), false, '外に新しいものが無いのに確かめを走らせた');
  });

  test('main と一つでも違えば、これまでどおり確かめる（対）', async () => {
    const { work, ran } = await sandbox('process.exit(0);\n');
    execFileSync('git', ['push', '-q', '--no-verify', '-u', 'origin', 'main'], { cwd: work });
    execFileSync('git', ['checkout', '-q', '-b', 'feature'], { cwd: work });
    await writeFile(join(work, 'src', 'b.ts'), 'export const b = 2;\n');
    execFileSync('git', ['add', '-A'], { cwd: work });
    execFileSync('git', ['commit', '-q', '-m', '足した'], { cwd: work });
    const r = push(work, ['-u', 'origin', 'feature']);
    assert.equal(r.ok, true, `押せていない: ${r.text}`);
    assert.equal(existsSync(ran), true, 'main と違うのに確かめを飛ばした');
  });

  test('**ブランチをタグとして押すときは、main と同じツリーでも確かめる**', async () => {
    // 手元ではブランチでも、外ではタグ（release の合図）になる。
    const { work, ran } = await sandbox('process.exit(0);\n');
    execFileSync('git', ['push', '-q', '--no-verify', '-u', 'origin', 'main'], { cwd: work });
    execFileSync('git', ['branch', 'feature'], { cwd: work });
    const r = push(work, ['origin', 'feature:refs/tags/v9.9.9']);
    assert.equal(r.ok, true, `押せていない: ${r.text}`);
    assert.doesNotMatch(r.text, /origin\/main と同じ/, `タグなのに飛ばした: ${r.text}`);
    assert.equal(existsSync(ran), true, 'タグとして押すのに確かめを飛ばした');
  });

  test('確かめが落ちたら、もちろん押さない（対）', async () => {
    const { work } = await sandbox('process.exit(1);\n');
    const r = push(work);
    assert.equal(r.ok, false, `押せてしまった: ${r.text}`);
  });
});

describe('使うものが、そろっている', sourceOnly, () => {
  test('フックが、この二つを呼んでいる', async () => {
    /*
     * 判断を書いても、呼ばれなければ何も守らない。**呼ぶ行を見る。**
     * 前に同じ形のもので、案内だけ残して探しに行く行を消しても通った。
     */
    const hook = await readFile(join(import.meta.dirname, '..', '.githooks', 'pre-push'), 'utf8');
    assert.match(hook, /pushed-tree-check\.mjs before/, '前の確かめを呼んでいない');
    assert.match(hook, /pushed-tree-check\.mjs after/, '後の確かめを呼んでいない');
    // main と同じツリーを飛ばす判断は、確かめより前に置く（飛ばすなら走らせない）。
    assert.ok(
      hook.indexOf('same-as-main.mjs') > 0 && hook.indexOf('same-as-main.mjs') < hook.indexOf('node scripts/check.mjs'),
      'main と同じツリーを飛ばす判断を、確かめより前で呼んでいない',
    );
    // 後の確かめは、本物の確かめより後に置く（動いたかどうかは後でしか分からない）。
    assert.ok(
      hook.indexOf('node scripts/check.mjs') < hook.indexOf('pushed-tree-check.mjs after'),
      '後の確かめが、確かめより前に置かれています',
    );
  });
});

/**
 * 押す ref が一つも渡らなかった（押す前に断られた・押すものが無い）とき、「wip/ のブランチなので」と言わない。
 *
 * 既定を「wip/ を押す」として、wip/ 以外の ref を見たら確かめる形だった。non-fast-forward で断られた push では ref が
 * 一行も渡らず、wip/ でないブランチなのに「wip/ のブランチなので、確かめずに通します」と言っていた。
 */
describe('押すものが無いとき', sourceOnly, () => {
  test('**ref が一つも渡らなければ、wip/ と取り違えず、押すものが無いと言う**', async () => {
    const { spawnSync } = await import('node:child_process');
    const hook = join(import.meta.dirname, '..', '.githooks', 'pre-push');
    const got = spawnSync('sh', [hook, 'origin', 'https://example.invalid/x.git'], { input: '', encoding: 'utf8', cwd: join(import.meta.dirname, '..') });
    assert.equal(got.status, 0, got.stderr);
    assert.doesNotMatch(got.stdout, /wip\//, `ref が無いのに wip/ と言った: ${got.stdout}`);
    assert.match(got.stdout, /押すものがありません/);
  });
});
