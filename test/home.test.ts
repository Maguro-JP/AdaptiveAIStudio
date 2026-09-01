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
    await writeFile(join(root, 'portable.txt'), '');
    assert.equal(isPortable(root), true);
  });

  test('目印が無ければ持ち運び版ではない', async () => {
    const root = await tempDir('aas-normal-');
    assert.equal(isPortable(root), false);
  });

  test('AAS_HOME があれば、持ち運びより明示が勝つ', async () => {
    const root = await tempDir('aas-portable-');
    await writeFile(join(root, 'portable.txt'), '');
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
    const raw = await readFile(join(installRoot(), 'bootstrap.cmd'), 'utf8');
    assert.match(raw, /findstr \/R "\[\^ -~\]"/, '全角の検査が無い');
    const stopAt = raw.indexOf('findstr /R "[^ -~]"');
    const fetchAt = raw.indexOf('curl -fL');
    assert.ok(stopAt < fetchAt, '取ってきた後に検査している');
  });

  test('用意用は、git も npm も要求しない', async () => {
    const raw = await readFile(join(installRoot(), 'bootstrap.cmd'), 'utf8');
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
