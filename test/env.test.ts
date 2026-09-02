/**
 * 合言葉を data/.env から読むところ。
 *
 * 値は絶対に記録に出さない。読めた名前だけを返す。
 * 既にある環境変数は上書きしない（外から渡されたものが勝つ）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { tempDir } from './tmp.ts';
import { parseEnvFile, loadEnvFile } from '../src/core/env.ts';

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
