/**
 * 保存先の環境変数の読み方（86 回目の調査）。
 *
 * - `AAS_STATE_DIR` / `AAS_BIN_DIR` が空だと、空の文字列（いまのフォルダ）を保存先にしていた。`AAS_HOME` は空を無視している
 * - `AAS_HOME` に相対の道を書くと、起動した場所ごとに根が変わり、設定・記録・モデルが黙って割れていた
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { isAbsolute, join } from 'node:path';
import { tempDir } from './tmp.ts';
import { aasHome, stateDir, binDir, modelsDir } from '../src/core/home.ts';

const KEYS = ['AAS_HOME', 'AAS_STATE_DIR', 'AAS_BIN_DIR', 'AAS_MODELS_DIR'] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const cwd = process.cwd();
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  process.chdir(cwd);
});

describe('保存先の環境変数', () => {
  test('空の AAS_STATE_DIR・AAS_BIN_DIR は、無いものとして扱う', async () => {
    process.env.AAS_HOME = await tempDir('aas-envhome-');
    process.env.AAS_STATE_DIR = '';
    process.env.AAS_BIN_DIR = '  ';
    assert.equal(stateDir(), aasHome());
    assert.equal(binDir(), join(aasHome(), 'bin'));
  });

  test('空白だけの AAS_MODELS_DIR は無いものとし、前後の空白は落とす', async () => {
    process.env.AAS_HOME = await tempDir('aas-envhome-');
    process.env.AAS_MODELS_DIR = '   ';
    assert.notEqual(modelsDir().trim(), '', '空白の名前を保存先にした');
    process.env.AAS_MODELS_DIR = ' /srv/gguf ';
    assert.equal(modelsDir(), '/srv/gguf');
  });

  test('相対の AAS_HOME は、起動した場所によらず同じ絶対の道になる', async () => {
    const a = await tempDir('aas-cwd-a-');
    const b = await tempDir('aas-cwd-b-');
    process.chdir(a);
    process.env.AAS_HOME = 'data';
    const first = aasHome();
    process.chdir(b);
    const second = aasHome();
    assert.ok(isAbsolute(first), first);
    assert.equal(first, second);
  });
});
