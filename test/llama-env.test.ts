/**
 * llama-server を動かすための環境。
 *
 * bundle は実行ファイルと共有ライブラリが同じ場所に入っているが、
 * Linux と macOS は実行ファイルの隣を自動では探さない。
 * **実際にこれで落ちた**（置けているのに libllama.so が見つからない）。
 * 手元が Windows だと永久に気づけない類なので、ここで固定する。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runtimeEnv, libPathVar } from '../src/runtime/llama-env.ts';

describe('共有ライブラリの探し場所', () => {
  test('Linux は LD_LIBRARY_PATH に実行ファイルの場所を足す', () => {
    const env = runtimeEnv('/home/u/.aas/bin/b4585/llama-server', 'linux', {});
    assert.equal(env.LD_LIBRARY_PATH, '/home/u/.aas/bin/b4585');
  });

  test('macOS は DYLD_LIBRARY_PATH', () => {
    const env = runtimeEnv('/Users/u/.aas/bin/b4585/llama-server', 'darwin', {});
    assert.equal(env.DYLD_LIBRARY_PATH, '/Users/u/.aas/bin/b4585');
    assert.equal(env.LD_LIBRARY_PATH, undefined);
  });

  test('Windows は何も足さない（exe の隣を自動で見るため）', () => {
    assert.equal(libPathVar('win32'), undefined);
    const env = runtimeEnv('C:\\\\bin\\\\llama-server.exe', 'win32', { PATH: 'x' });
    assert.equal(env.LD_LIBRARY_PATH, undefined);
    assert.equal(env.PATH, 'x', '元の環境を壊している');
  });

  test('元からある指定を消さない', () => {
    const env = runtimeEnv('/opt/llama/llama-server', 'linux', { LD_LIBRARY_PATH: '/usr/local/lib' });
    assert.equal(env.LD_LIBRARY_PATH, '/opt/llama:/usr/local/lib', '既存の指定を潰している');
  });

  test('元の環境変数はそのまま引き継ぐ', () => {
    const env = runtimeEnv('/opt/llama/llama-server', 'linux', { HOME: '/home/u', CUDA_VISIBLE_DEVICES: '0' });
    assert.equal(env.HOME, '/home/u');
    assert.equal(env.CUDA_VISIBLE_DEVICES, '0');
  });
});
