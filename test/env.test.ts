/**
 * トークンを data/.env から読むところ。
 *
 * 値は絶対に記録に出さない。読めた名前だけを返す。
 * 既にある環境変数は上書きしない（外から渡されたものが勝つ）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { tempDir } from './tmp.ts';
import { parseEnvFile, loadEnvFile, envForChild, secretNames } from '../src/core/env.ts';

describe('一行ずつ読む', () => {
  test('KEY=VALUE、注釈、引用符、空行', () => {
    const got = parseEnvFile([
      '# 注釈', '', 'GITHUB_TOKEN=ghp_abc', 'A="x y"', "B='z'", 'C=v # 後ろの注釈', 'D=a#b',
      '=bad', 'bad line', '1X=no',
    ].join('\n'));
    assert.deepEqual(got, { GITHUB_TOKEN: 'ghp_abc', A: 'x y', B: 'z', C: 'v', D: 'a#b' });
  });
  test('CRLF でも読める（Windows のメモ帳）', () => {
    assert.deepEqual(parseEnvFile('A=1\r\nB=2\r\n'), { A: '1', B: '2' });
  });
});

describe('環境変数へ入れる', () => {
  test('無いものは入れ、あるものは上書きしない。返すのは名前だけ', async () => {
    const dir = await tempDir('aas-env-');
    await writeFile(join(dir, '.env'), 'NEW_ONE=secret\nALREADY=fromfile\n');
    const env: NodeJS.ProcessEnv = { ALREADY: 'outside' };
    const names = loadEnvFile(join(dir, '.env'), env);
    assert.deepEqual(names, ['NEW_ONE']);
    assert.equal(env.NEW_ONE, 'secret');
    assert.equal(env.ALREADY, 'outside', '外から渡されたものが負けている');
  });
  test('ファイルが無ければ何もしない（対）', async () => {
    const dir = await tempDir('aas-env-');
    const env: NodeJS.ProcessEnv = {};
    assert.deepEqual(loadEnvFile(join(dir, '.env'), env), []);
    assert.deepEqual(env, {});
  });
});

/**
 * **トークンを、子のプロセスへ渡さない。**
 *
 * `spawn` に `env` を渡していなかったので、親の環境変数がそのまま全部子へ
 * 行っていた。外部ツール（MCP）の子も、`run_command` で走らせるものも同じで、
 * **`echo` 一つでトークンが読める**（出力はモデルの履歴と会話の記録に入る）。
 */
describe('子のプロセスへ渡す環境', () => {
  test('**名前がトークンらしいものは渡さない**', () => {
    const got = envForChild({
      PATH: '/usr/bin', HOME: '/home/x',
      GITHUB_TOKEN: 'ghp_abc', ANTHROPIC_API_KEY: 'sk-abc',
      MY_SECRET: 'x', DB_PASSWORD: 'p', SESSION_ID: 's', NPM_TOKENS: 'n',
    });
    assert.deepEqual(got, { PATH: '/usr/bin', HOME: '/home/x' });
  });

  test('トークンらしくない名前は、そのまま渡す（対）', () => {
    const got = envForChild({ PATH: '/usr/bin', CI: '1', NODE_ENV: 'test', KEYBOARD_LAYOUT: 'jp' });
    assert.deepEqual(got, { PATH: '/usr/bin', CI: '1', NODE_ENV: 'test', KEYBOARD_LAYOUT: 'jp' });
  });

  test('**`.env` から入れた名前は、トークンらしくなくても渡さない**', async () => {
    const dir = await tempDir('aas-env-child-');
    await writeFile(join(dir, '.env'), 'PLAIN_NAME=v\n');
    // 本物の process.env へ入れる（覚えるのはそのときだけ）。
    delete process.env.PLAIN_NAME;
    const names = loadEnvFile(join(dir, '.env'));
    try {
      assert.deepEqual(names, ['PLAIN_NAME']);
      assert.ok(secretNames().includes('PLAIN_NAME'), '入れた名前を覚えていない');
      const got = envForChild({ PATH: '/usr/bin', PLAIN_NAME: 'v' });
      assert.deepEqual(got, { PATH: '/usr/bin' });
    } finally {
      delete process.env.PLAIN_NAME;
    }
  });

  test('値が無いもの（undefined）は渡さない', () => {
    assert.deepEqual(envForChild({ PATH: '/usr/bin', GONE: undefined }), { PATH: '/usr/bin' });
  });
});
