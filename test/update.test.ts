/**
 * 更新の検証。
 *
 * 本物の git リポジトリを2つ作って、実際に取ってこさせる。
 * 偽物で試すと「早送りできない場合」を作れないので、
 * ここは本物でやる（ネットワークには出ない）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { checkUpdate, applyUpdate, describeUpdate } from '../src/core/update.ts';

// git の無い機械（配った形の Windows）では、このテストは飛ばす。git を使う機能そのものが無いので。
import { spawnSync as __spawnSync } from 'node:child_process';
const GIT_OK = __spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
const onlyWithGit = { skip: GIT_OK ? false : 'この機械には git が無い' };

function git(args: string[], cwd: string): Promise<number> {
  return new Promise((resolve) => {
    const c = spawn('git', args, { cwd, stdio: 'ignore' });
    c.on('error', () => resolve(-1));
    c.on('close', (code) => resolve(code ?? -1));
  });
}

/** 「向こう側」と、そこから複製した「手元」を用意する。 */
async function pair() {
  const origin = await tempDir('aas-origin-');
  await git(['init', '--bare', '-b', 'main'], origin);

  const seed = await tempDir('aas-seed-');
  await git(['init', '-b', 'main'], seed);
  await git(['config', 'user.email', 't@example.com'], seed);
  await git(['config', 'user.name', 'test'], seed);
  await writeFile(join(seed, 'a.txt'), '1\n');
  await git(['add', '.'], seed);
  await git(['commit', '-m', '最初'], seed);
  await git(['remote', 'add', 'origin', origin], seed);
  await git(['push', '-u', 'origin', 'main'], seed);

  const local = await tempDir('aas-local-');
  const root = join(local, 'repo');
  await git(['clone', origin, root], local);
  await git(['config', 'user.email', 't@example.com'], root);
  await git(['config', 'user.name', 'test'], root);

  /** 向こう側に新しい変更を積む。 */
  const advance = async (message: string) => {
    await writeFile(join(seed, 'a.txt'), `${message}\n`);
    await git(['add', '.'], seed);
    await git(['commit', '-m', message], seed);
    await git(['push', 'origin', 'main'], seed);
  };

  return { root, advance };
}

describe('更新', () => {
  test('**調べられなかったときは、最新と取り違えないよう failed を付ける**', onlyWithGit, async () => {
    const { root } = await pair();
    assert.equal((await checkUpdate(root)).failed, undefined, '最新のときは付けない');
    await writeFile(join(root, 'a.txt'), 'dirty\n');
    const dirty = await checkUpdate(root);
    assert.equal(dirty.failed, true, '未コミットの変更');
    await git(['checkout', '--', 'a.txt'], root);
    await git(['remote', 'set-url', 'origin', join(root, 'no-such-remote')], root);
    assert.equal((await checkUpdate(root)).failed, true, '取りに行けない');
    const plain = await tempDir('aas-plain-');
    assert.equal((await checkUpdate(plain)).failed, true, 'git 管理下でない');
  });

  test('新しいものが無ければ、最新だと言う', onlyWithGit, async () => {
    const { root } = await pair();
    const s = await checkUpdate(root);
    assert.equal(s.behind, 0);
    assert.equal(s.can, false, '取ってくるものが無いのに押せる状態になっている');
    assert.match(s.reason ?? '', /最新/);
  });

  test('新しいものがあれば、件数と見出しを見せる', onlyWithGit, async () => {
    const { root, advance } = await pair();
    await advance('二つ目の変更');

    const s = await checkUpdate(root);
    assert.equal(s.behind, 1);
    assert.equal(s.can, true, s.reason);
    assert.equal(s.incoming.length, 1);
    assert.match(s.incoming[0]!, /二つ目の変更/);
    assert.match(describeUpdate(s), /1件の変更があります/);
  });

  test('取ってくると、実際に新しくなる', onlyWithGit, async () => {
    const { root, advance } = await pair();
    await advance('新しい中身');

    const r = await applyUpdate(root);
    assert.equal(r.ok, true, r.message);
    assert.equal(r.applied, 1);
    assert.equal(r.restartNeeded, true, '立ち上げ直しを促していない');

    // 改行を直書きで比べない。Windows の git は core.autocrlf で
    // 取り出すときに LF を CRLF へ変えるので、中身は同じでも一致しない。
    // 確かめたいのは「新しくなったか」であって、改行の作法ではない。
    const got = await readFile(join(root, 'a.txt'), 'utf8');
    assert.equal(got.replace(/\r\n/g, '\n'), '新しい中身\n');
    assert.equal((await checkUpdate(root)).behind, 0);
  });

  test('未コミットの変更があるときは、取ってこない', onlyWithGit, async () => {
    const { root, advance } = await pair();
    await advance('向こうの変更');
    await writeFile(join(root, 'a.txt'), '手元でいじった\n');

    const s = await checkUpdate(root);
    assert.equal(s.can, false);
    assert.match(s.reason ?? '', /未コミットの変更/);

    const r = await applyUpdate(root);
    assert.equal(r.ok, false, '未コミットの変更を巻き込んでいる');
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), '手元でいじった\n', '手元の変更が失われた');
  });

  test('こちらにしか無い変更があるときは、早送りしない', onlyWithGit, async () => {
    const { root, advance } = await pair();
    await advance('向こうの変更');
    await writeFile(join(root, 'b.txt'), 'こちらの変更\n');
    await git(['add', '.'], root);
    await git(['commit', '-m', 'こちらの変更'], root);

    const s = await checkUpdate(root);
    assert.equal(s.can, false);
    assert.match(s.reason ?? '', /早送りできない/);
    assert.equal((await applyUpdate(root)).ok, false);
  });

  test('git 管理下でなければ、そう言って断る', onlyWithGit, async () => {
    const dir = await tempDir('aas-nogit-');
    await mkdir(join(dir, 'sub'), { recursive: true });
    const s = await checkUpdate(join(dir, 'sub'));
    assert.equal(s.can, false);
    assert.match(s.reason ?? '', /git 管理下ではありません/);
  });
});

describe('bundle では、手で新しくする道を言う', () => {
  test('portable なら、取ってくる先と data を残すことを言う', onlyWithGit, async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tempDir } = await import('./tmp.ts');
    const { checkUpdate, RELEASES_URL } = await import('../src/core/update.ts');
    const product = await tempDir('aas-upd-portable-');
    const app = join(product, 'app');
    await mkdir(app, { recursive: true });
    await writeFile(join(product, '.portable'), 'built 2026-09-01\n');
    const s = await checkUpdate(app);
    assert.equal(s.can, false);
    assert.ok(s.reason?.includes(RELEASES_URL), `取ってくる先が無い: ${s.reason}`);
    assert.match(s.reason ?? '', /data/);
  });

  test('**放っておくほど古くなるタグを指さない**', onlyWithGit, async () => {
    /*
     * `releases/tag/portable` を指していた。このタグはタグを付けずに手で組んだ
     * ときにしか差し替わらない（タグを付けた回は、その版の方へ公開される）。
     * 実際に最新の版より 5 日古かった。手で入れ替える人は、いちばん新しいものが
     * 要る。GitHub が回してくれる `releases/latest` を指す。
     */
    const { RELEASES_URL } = await import('../src/core/update.ts');
    assert.ok(!RELEASES_URL.includes('/tag/'),
      `決め打ちのタグを指しています: ${RELEASES_URL}`);
    assert.match(RELEASES_URL, /\/releases\/latest$/);
  });

  /**
   * **その場で上書きさせない。**上書きすると、新しい方が動かなかったときに
   * 戻る先が無い。NetVision が同じところで「新しい ZIP は別のフォルダへ展開し、
   * 古いフォルダは消さずに残す。問題がないことを確かめてから消す」と書いていて、
   * そちらが正しい。
   *
   * ただし置き場の作りが違う。向こうはデータがアプリの外（`~/.netvision`）に
   * あるので、どちらのフォルダから起動しても同じものが見える。**こちらは
   * `data\` がフォルダの中**なので、そのまま真似ると新しい方が空で立ち上がる。
   * だから `data\` を移す一手が要る。ここが抜けると、設定と記録が消えたように見える。
   */
  test('**戻せる形で案内する（別のフォルダ・古いのを残す・data を移す）**', onlyWithGit, async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tempDir } = await import('./tmp.ts');
    const { checkUpdate } = await import('../src/core/update.ts');
    const product = await tempDir('aas-upd-back-');
    const app = join(product, 'app');
    await mkdir(app, { recursive: true });
    await writeFile(join(product, '.portable'), 'built 2026-09-01\n');
    const reason = (await checkUpdate(app)).reason ?? '';

    assert.match(reason, /別のフォルダ/, `上書きさせようとしている: ${reason}`);
    assert.match(reason, /消さない/, `古いフォルダを残すと言っていない: ${reason}`);
    assert.match(reason, /data\\.*(移す|移し)/s, `data を移す一手が抜けている: ${reason}`);
    assert.match(reason, /戻すとき/, `戻し方を言っていない: ${reason}`);
  });

  /**
   * 版を控えないと「入れ替えたつもりで古いまま動いていた」に気づけない
   * （ここで実際にやった）。控えろと言うだけでなく、その場に出す。
   */
  test('**いまの版を、その場に出す**', onlyWithGit, async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tempDir } = await import('./tmp.ts');
    const { byHandUpdate } = await import('../src/core/update.ts');
    const product = await tempDir('aas-upd-ver-');
    await mkdir(join(product, 'app'), { recursive: true });
    await writeFile(join(product, '.portable'), 'x\n');

    const withVersion = byHandUpdate(product, '0.3.0+abc1234');
    assert.match(withVersion, /いまの版: 0\.3\.0\+abc1234/, withVersion);
    assert.match(withVersion, /控え/, `控える理由を言っていない: ${withVersion}`);
    // 版が分からないときも、行き止まりにしない。
    assert.match(byHandUpdate(product), /VERSION/);
  });

  test('portable でなければ、git clone の話のまま（対）', onlyWithGit, async () => {
    const { tempDir } = await import('./tmp.ts');
    const { checkUpdate, RELEASES_URL } = await import('../src/core/update.ts');
    const s = await checkUpdate(await tempDir('aas-upd-plain-'));
    assert.match(s.reason ?? '', /git clone/);
    assert.ok(!s.reason?.includes(RELEASES_URL));
  });
});

describe('配った形では git を見ない', () => {
  test('portable を別の git リポジトリの中に置いても、親のリポジトリを製品と取り違えない', onlyWithGit, async () => {
    const { RELEASES_URL } = await import('../src/core/update.ts');
    const { root, advance } = await pair();
    const product = join(root, 'prod');
    const app = join(product, 'app');
    await mkdir(app, { recursive: true });
    await writeFile(join(product, '.portable'), 'built\n');
    // 親のリポジトリはきれいなまま（置いた portable は git から外す）。見に行けば上流の変更が見える形にする
    await writeFile(join(root, '.git', 'info', 'exclude'), 'prod/\n');
    await advance('PARENT-REPO-ONLY');
    const s = await checkUpdate(app);
    assert.equal(s.can, false, `親のリポジトリを取り込めることにした: ${JSON.stringify(s)}`);
    assert.ok(!s.incoming.some((l) => l.includes('PARENT-REPO-ONLY')), `親の変更を製品の更新として出した: ${JSON.stringify(s)}`);
    assert.ok(s.reason?.includes(RELEASES_URL), `手で新しくする道を言っていない: ${s.reason}`);
  });

  test('インストーラで入れた形（app の中、.portable なし）には、打てない git clone の案内を出さない', async () => {
    const { RELEASES_URL } = await import('../src/core/update.ts');
    const product = await tempDir('aas-upd-installed-');
    const app = join(product, 'app');
    await mkdir(app, { recursive: true });
    // インストーラも bundle の中身をそのまま置く（`app\` の隣に入口と VERSION がある）
    await writeFile(join(product, 'AdaptiveAIStudio.cmd'), '@echo off\r\n');
    const s = await checkUpdate(app);
    assert.equal(s.can, false);
    assert.doesNotMatch(s.reason ?? '', /git clone/, `入れた形に git の案内を出した: ${s.reason}`);
    assert.match(s.reason ?? '', /setup\.exe/);
    assert.ok(s.reason?.includes(RELEASES_URL), `取ってくる先が無い: ${s.reason}`);
  });
});

describe('aas update の引数', () => {
  test('**`--` で始まる引数を場所と読まずに断る**（別の場所を見て「git 管理下ではありません」と 0 で返していた）', () => {
    const r = __spawnSync(process.execPath, ['--experimental-strip-types', 'src/cli/update.ts', '--yes'], { encoding: 'utf8' });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /知らない引数です: --yes/);
  });
});

describe('手元にだけ変更があるとき（86 回目の調査）', () => {
  test('取り込むものが無ければ「最新です」と言う（手で取り込めとは言わない）', onlyWithGit, async () => {
    const { root } = await pair();
    await writeFile(join(root, 'b.txt'), 'local\n');
    await git(['add', '.'], root);
    await git(['commit', '-m', '手元だけ'], root);
    const r = await checkUpdate(root);
    assert.equal(r.ahead, 1);
    assert.equal(r.behind, 0);
    assert.equal(r.can, false);
    assert.equal(r.reason, '最新です');
  });

  test('取り込むものもあれば、手で取り込むよう言う（対）', onlyWithGit, async () => {
    const { root, advance } = await pair();
    await advance('向こう');
    await writeFile(join(root, 'b.txt'), 'local\n');
    await git(['add', '.'], root);
    await git(['commit', '-m', '手元だけ'], root);
    const r = await checkUpdate(root);
    assert.equal(r.can, false);
    assert.match(r.reason ?? '', /手で取り込んで/);
  });
});
