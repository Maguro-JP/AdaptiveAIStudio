/**
 * 渡す道を、本物の git で端まで通す。
 *
 * 決め方だけの検査（`handoff.test.ts`）は全部通っていたのに、**本物の
 * リポジトリで回したら二つ落ちた。**
 *
 *   ・`refs/remotes/origin/wip/cloud` から名前を取るとき `wip/` を二重に
 *     付けていた（`wip/wip/cloud`）。取り込みがその名前で落ちる
 *   ・`origin/<ブランチ>` がまだ無いとき（クローン直後）に、数を数える所で落ちる
 *
 * どちらも git を叩かないと出ない。**叩くところまでを検査にする。**
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFile, mkdir, readFile, copyFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './tmp.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const git = (args: string[], cwd: string): void => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
};

/**
 * その名前の機械として、渡す道を動かす。
 *
 * **その作業コピーの中に置いたものを呼ぶ。**渡す道は自分の置かれた場所から
 * リポジトリを決めるので（`check.mjs` と同じ）、外から呼ぶとこちらの
 * リポジトリを触ってしまう。
 */
const run = (cwd: string, name: string, args: string[] = []): { out: string; code: number } => {
  const r = spawnSync(process.execPath, [join(cwd, 'scripts', 'handoff.mjs'), ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, AAS_HANDOFF_NAME: name },
  });
  return { out: `${r.stdout}${r.stderr}`, code: r.status ?? 1 };
};

/** 元の置き所を一つと、そこから引いた作業コピーを二つ。 */
async function twoMachines(): Promise<{ origin: string; cloud: string; local: string }> {
  const base = await tempDir('aas-handoff-');
  const origin = join(base, 'origin.git');
  await mkdir(origin, { recursive: true });
  git(['init', '--bare', '-b', 'main'], origin);

  const cloud = join(base, 'cloud');
  git(['clone', '-q', origin, cloud], base);
  git(['config', 'user.email', 't@example.com'], cloud);
  git(['config', 'user.name', 'test'], cloud);
  // 渡す道そのものを、作業コピーの中へ置く（本番と同じ形で呼ぶ）。
  await mkdir(join(cloud, 'scripts'), { recursive: true });
  for (const f of ['handoff.mjs', 'handoff-plan.mjs']) {
    await copyFile(join(root, 'scripts', f), join(cloud, 'scripts', f));
  }
  await writeFile(join(cloud, 'はじめ.txt'), '元の中身\n', 'utf8');
  git(['add', '-A'], cloud);
  git(['commit', '-qm', '最初'], cloud);
  git(['push', '-q', '-u', 'origin', 'main'], cloud);

  const local = join(base, 'local');
  git(['clone', '-q', origin, local], base);
  git(['config', 'user.email', 't@example.com'], local);
  git(['config', 'user.name', 'test'], local);
  return { origin, cloud, local };
}

describe('片方で書いて、もう片方で受け取る', () => {
  test('**書いたものが、そのまま渡る**', async () => {
    const { cloud, local } = await twoMachines();
    await writeFile(join(cloud, 'あたらしい.txt'), 'クラウドで書いた\n', 'utf8');

    const sent = run(cloud, 'cloud');
    assert.equal(sent.code, 0, sent.out);
    assert.match(sent.out, /wip\/cloud/);

    const took = run(local, 'local', ['--take']);
    assert.equal(took.code, 0, took.out);
    assert.equal(await readFile(join(local, 'あたらしい.txt'), 'utf8'), 'クラウドで書いた\n');
  });

  test('**ブランチの名前を、二重にしない**', async () => {
    // `wip/wip/cloud` になっていた。取り込みがその名前で落ちる。
    const { cloud, local } = await twoMachines();
    await writeFile(join(cloud, 'x.txt'), 'x\n', 'utf8');
    run(cloud, 'cloud');
    const listed = run(local, 'local', ['--list']);
    assert.match(listed.out, /wip\/cloud/);
    assert.doesNotMatch(listed.out, /wip\/wip/, `名前が二重になっている: ${listed.out}`);
  });

  test('渡すものが無ければ、何もしない（対）', async () => {
    const { cloud } = await twoMachines();
    const sent = run(cloud, 'cloud');
    assert.equal(sent.code, 0, sent.out);
    assert.match(sent.out, /渡すものがありません/);
  });

  test('**書きかけの上には、取り込ませない**', async () => {
    const { cloud, local } = await twoMachines();
    await writeFile(join(cloud, 'y.txt'), 'y\n', 'utf8');
    run(cloud, 'cloud');
    // 受け取る側にも書きかけがある状態にする。
    await writeFile(join(local, 'かきかけ.txt'), 'まだ途中\n', 'utf8');
    const took = run(local, 'local', ['--take']);
    assert.equal(took.code, 1, '書きかけなのに取り込んでいる');
    assert.match(took.out, /書きかけ/);
  });

  test('**まだ押していないブランチでも、送れる**', async () => {
    /*
     * `origin/<ブランチ>` がまだ無いとき、数を数える所で落ちていた。
     * 手元でブランチを切って作業する形（`git checkout -b`）では普通に起きる。
     * **決め方だけの検査では出ない。**git を叩かないと出ない。
     */
    const { cloud, local } = await twoMachines();
    git(['checkout', '-q', '-b', 'まだ押していないブランチ'], cloud);
    await writeFile(join(cloud, 'z.txt'), 'z\n', 'utf8');

    const sent = run(cloud, 'cloud');
    assert.equal(sent.code, 0, `まだ押していないブランチで落ちている: ${sent.out}`);
    assert.match(sent.out, /wip\/cloud/);

    const took = run(local, 'local', ['--take']);
    assert.equal(took.code, 0, took.out);
    assert.equal(await readFile(join(local, 'z.txt'), 'utf8'), 'z\n');
  });

  test('**いま居るブランチに、コミットを作らない**', async () => {
    /*
     * ここは `git add -A && git commit` していた。main に居れば main に
     * 「確かめていません」というコミットが載る。**実際に載せて push した**
     * （39e651a）。しかも決め方の側に「main を wip の代わりにしない」と
     * 書いておきながら、中身は何もしない空の `if` だった。
     *
     * 送っても、いまのブランチも index も working tree も動かないこと。
     */
    const { cloud, local } = await twoMachines();
    await writeFile(join(cloud, 'まだ途中.txt'), '書きかけ\n', 'utf8');
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: cloud, encoding: 'utf8' }).stdout.trim();
    const before = spawnSync('git', ['status', '--porcelain'], { cwd: cloud, encoding: 'utf8' }).stdout;

    const sent = run(cloud, 'cloud');
    assert.equal(sent.code, 0, sent.out);

    const after = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: cloud, encoding: 'utf8' }).stdout.trim();
    assert.equal(after, head, 'いま居るブランチにコミットを作っている');
    const still = spawnSync('git', ['status', '--porcelain'], { cwd: cloud, encoding: 'utf8' }).stdout;
    assert.equal(still, before, `書きかけの状態を変えている: ${still}`);
    assert.match(still, /\?\?/, 'この確かめの前提が崩れている（書きかけが無い）');

    // それでも、中身は向こうへ渡っていること。
    const took = run(local, 'local', ['--take']);
    assert.equal(took.code, 0, took.out);
    assert.equal(await readFile(join(local, 'まだ途中.txt'), 'utf8'), '書きかけ\n');
  });

  test('渡されていなければ、そう言う', async () => {
    const { local } = await twoMachines();
    const took = run(local, 'local', ['--take']);
    assert.equal(took.code, 1);
    assert.match(took.out, /渡されているものがありません/);
  });

  test('ぶつかったら、次の一手を言う（スタックを出さない）', async () => {
    const { cloud, local } = await twoMachines();
    // 両方で同じファイルの同じ所を触る。
    await writeFile(join(cloud, 'はじめ.txt'), 'クラウドの言い分\n', 'utf8');
    run(cloud, 'cloud');
    await writeFile(join(local, 'はじめ.txt'), 'ローカルの言い分\n', 'utf8');
    git(['commit', '-qam', 'ローカルで直した'], local);

    const took = run(local, 'local', ['--take']);
    assert.equal(took.code, 1);
    assert.match(took.out, /ぶつかりました/);
    assert.match(took.out, /merge --abort/, '戻し方を言っていない');
    assert.doesNotMatch(took.out, /at ModuleJob|node:internal/,
      `Node のスタックを見せている: ${took.out.slice(0, 200)}`);
  });
});
