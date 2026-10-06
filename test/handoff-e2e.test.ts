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
import { writeFile, mkdir, readFile, copyFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './tmp.ts';

// git の無い機械（配った形の Windows）では、このテストは飛ばす。git を使う機能そのものが無いので。
import { spawnSync as __spawnSync } from 'node:child_process';
const GIT_OK = __spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
const onlyWithGit = { skip: GIT_OK ? false : 'この機械には git が無い' };

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * 走らせている側の git の env を、こちらの git へ持ち込まない。
 *
 * git はフック（pre-push など）に `GIT_DIR` や `GIT_INDEX_FILE` を渡す。
 * 継ぐと、ここで作る一時の repository ではなく**走らせている repository** を
 * 触りにいくので、`git init --bare` した先が「そんな repository は無い」になる。
 * 実際に、pre-push から `npm run check` を回したときだけ 8 件が落ちた。
 * **確かめの側が嘘をつくと、確かめを迂回する癖がつく。**
 */
const withoutGitEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k];
  return env;
};

const git = (args: string[], cwd: string): void => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: withoutGitEnv() });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
};

/**
 * 行末を変換しない形でクローンする。
 *
 * Windows の git は既定で `core.autocrlf=true` なので、この試験が作る
 * 一時のクローンでも checkout のときに `\n` が `\r\n` へ書き換わる。
 * その結果、渡ったものを見ている所が
 * `'クラウドで書いた\r\n' !== 'クラウドで書いた\n'` で落ちた
 * （Windows の CI で実際に三つそう落ちた）。渡す道の不具合ではない。
 *
 * **比べる側で行末をそろえてはいけない。**ここで見たいのは
 * 「書いたものがそのまま渡る」ことなので、比べる前にそろえてしまうと、
 * 本当に書き換わっていても通る試験になる。**変換する側を止める。**
 *
 * `--config` は最初の checkout より前に効くので、一度も変換されない
 * （クローンしてから `git config` を書いても、もう遅い）。
 * 手元の git の設定（グローバル）には触らない。ここで作ったものだけ。
 */
const cloneVerbatim = (from: string, to: string, cwd: string): void => {
  git(['clone', '-q', '--config', 'core.autocrlf=false', '--config', 'core.eol=lf', from, to], cwd);
};

/**
 * その名前の機械として、渡す道を動かす。
 *
 * **その作業コピーの中に置いたものを呼ぶ。**渡す道は自分の置かれた場所から
 * リポジトリを決めるので（`check.mjs` と同じ）、外から呼ぶとこちらの
 * リポジトリを触ってしまう。
 */
const run = (cwd: string, name: string, args: string[] = [], tmp?: string): { out: string; code: number } => {
  const r = spawnSync(process.execPath, [join(cwd, 'scripts', 'handoff.mjs'), ...args], {
    cwd, encoding: 'utf8', env: { ...withoutGitEnv(), AAS_HANDOFF_NAME: name, ...(tmp ? { TMPDIR: tmp, TMP: tmp, TEMP: tmp } : {}) },
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
  cloneVerbatim(origin, cloud, base);
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
  cloneVerbatim(origin, local, base);
  git(['config', 'user.email', 't@example.com'], local);
  git(['config', 'user.name', 'test'], local);
  return { origin, cloud, local };
}

describe('片方で書いて、もう片方で受け取る', () => {
  test('**書いたものが、そのまま渡る**', onlyWithGit, async () => {
    const { cloud, local } = await twoMachines();
    await writeFile(join(cloud, 'あたらしい.txt'), 'クラウドで書いた\n', 'utf8');

    const sent = run(cloud, 'cloud');
    assert.equal(sent.code, 0, sent.out);
    assert.match(sent.out, /wip\/cloud/);

    const took = run(local, 'local', ['--take']);
    assert.equal(took.code, 0, took.out);
    assert.equal(await readFile(join(local, 'あたらしい.txt'), 'utf8'), 'クラウドで書いた\n');
  });

  test('**送るときに作る一時的な index を、temp に残さない**', onlyWithGit, async () => {
    // 送るたびに `aas-handoff-*/index` が一つずつ残り、試験を回すたびに積もっていた
    const { cloud } = await twoMachines();
    await writeFile(join(cloud, 'y.txt'), 'y\n', 'utf8');
    const tmp = await tempDir('aas-handoff-tmp-');
    const sent = run(cloud, 'cloud', [], tmp);
    assert.equal(sent.code, 0, sent.out);
    assert.deepEqual(await readdir(tmp), [], '一時的な index のフォルダが残った');
  });

  test('**ブランチの名前を、二重にしない**', onlyWithGit, async () => {
    // `wip/wip/cloud` になっていた。取り込みがその名前で落ちる。
    const { cloud, local } = await twoMachines();
    await writeFile(join(cloud, 'x.txt'), 'x\n', 'utf8');
    run(cloud, 'cloud');
    const listed = run(local, 'local', ['--list']);
    assert.match(listed.out, /wip\/cloud/);
    assert.doesNotMatch(listed.out, /wip\/wip/, `名前が二重になっている: ${listed.out}`);
  });

  test('渡すものが無ければ、何もしない（対）', onlyWithGit, async () => {
    const { cloud } = await twoMachines();
    const sent = run(cloud, 'cloud');
    assert.equal(sent.code, 0, sent.out);
    assert.match(sent.out, /渡すものがありません/);
  });

  test('**書きかけの上には、取り込ませない**', onlyWithGit, async () => {
    const { cloud, local } = await twoMachines();
    await writeFile(join(cloud, 'y.txt'), 'y\n', 'utf8');
    run(cloud, 'cloud');
    // 受け取る側にも書きかけがある状態にする。
    await writeFile(join(local, 'かきかけ.txt'), 'まだ途中\n', 'utf8');
    const took = run(local, 'local', ['--take']);
    assert.equal(took.code, 1, '書きかけなのに取り込んでいる');
    assert.match(took.out, /書きかけ/);
  });

  test('**まだ押していないブランチでも、送れる**', onlyWithGit, async () => {
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

  test('**いま居るブランチに、コミットを作らない**', onlyWithGit, async () => {
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
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: cloud, encoding: 'utf8', env: withoutGitEnv() }).stdout.trim();
    const before = spawnSync('git', ['status', '--porcelain'], { cwd: cloud, encoding: 'utf8', env: withoutGitEnv() }).stdout;

    const sent = run(cloud, 'cloud');
    assert.equal(sent.code, 0, sent.out);

    const after = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: cloud, encoding: 'utf8', env: withoutGitEnv() }).stdout.trim();
    assert.equal(after, head, 'いま居るブランチにコミットを作っている');
    const still = spawnSync('git', ['status', '--porcelain'], { cwd: cloud, encoding: 'utf8', env: withoutGitEnv() }).stdout;
    assert.equal(still, before, `書きかけの状態を変えている: ${still}`);
    assert.match(still, /\?\?/, 'この確かめの前提が崩れている（書きかけが無い）');

    // それでも、中身は向こうへ渡っていること。
    const took = run(local, 'local', ['--take']);
    assert.equal(took.code, 0, took.out);
    assert.equal(await readFile(join(local, 'まだ途中.txt'), 'utf8'), '書きかけ\n');
  });

  test('渡されていなければ、そう言う', onlyWithGit, async () => {
    const { local } = await twoMachines();
    const took = run(local, 'local', ['--take']);
    assert.equal(took.code, 1);
    assert.match(took.out, /渡されているものがありません/);
  });

  test('ぶつかったら、次の一手を言う（スタックを出さない）', onlyWithGit, async () => {
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
