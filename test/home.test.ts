/**
 * 置き場所の決め方。
 *
 * 三つの事情（全角のユーザー名・ASCII への設置・持ち運び）が
 * どれも「根を移したい」だけなので、根を一つにしてある。
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { tempDir } from './tmp.ts';
import { aasHome, stateDir, binDir, modelsDir, isPortable } from '../src/core/home.ts';

const KEYS = ['AAS_HOME', 'AAS_STATE_DIR', 'AAS_BIN_DIR', 'AAS_MODELS_DIR'];
afterEach(() => { for (const k of KEYS) delete process.env[k]; });

describe('根の決め方', () => {
  test('何も指定しなければ ~/.aas', () => {
    assert.equal(aasHome(), join(homedir(), '.aas'));
  });

  test('AAS_HOME を書けば、記録も実行ファイルもモデルも一度に移る', () => {
    process.env.AAS_HOME = join('C:', 'AAS');
    assert.equal(stateDir(), join('C:', 'AAS'));
    assert.equal(binDir(), join('C:', 'AAS', 'bin'));
    assert.equal(modelsDir(), join('C:', 'AAS', 'models'));
  });

  test('空の指定は無視する（消し忘れで ~/.aas を見失わない）', () => {
    process.env.AAS_HOME = '   ';
    assert.equal(aasHome(), join(homedir(), '.aas'));
  });

  test('個別の指定は今までどおり効く。設定済みの人を壊さない', () => {
    process.env.AAS_HOME = join('C:', 'AAS');
    process.env.AAS_MODELS_DIR = join('D:', 'gguf');
    assert.equal(modelsDir(), join('D:', 'gguf'), '個別の指定が根に負けている');
    assert.equal(binDir(), join('C:', 'AAS', 'bin'), '指定していない方まで動いている');
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
    assert.equal(aasHome(), join('C:', 'AAS'));
  });
});
