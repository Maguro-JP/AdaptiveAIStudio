/**
 * 合言葉を書き足すところ。
 *
 * **他の行を残す。**丸ごと書き直すと、手で書いた別の合言葉や注釈が消える。
 * 画面から入れられるようにするので、ここが壊れると人の設定を潰す。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { writeEnvValue, parseEnvFile } from '../src/core/env.ts';

describe('合言葉を書き足す', () => {
  test('無い所へ書くと、作られる', async () => {
    const p = join(await tempDir('aas-env-'), 'data', '.env');
    await writeEnvValue(p, 'GITHUB_TOKEN', 'ghp_abc');
    assert.deepEqual(parseEnvFile(await readFile(p, 'utf8')), { GITHUB_TOKEN: 'ghp_abc' });
  });

  test('同じ名前は差し替える。他の行は残す', async () => {
    const p = join(await tempDir('aas-env-'), '.env');
    await writeFile(p, '# メモ\nOTHER=そのまま\nGITHUB_TOKEN=ふるい\n');
    await writeEnvValue(p, 'GITHUB_TOKEN', 'あたらしい');
    const raw = await readFile(p, 'utf8');
    assert.ok(raw.includes('# メモ'), '注釈が消えている');
    assert.deepEqual(parseEnvFile(raw), { OTHER: 'そのまま', GITHUB_TOKEN: 'あたらしい' });
  });

  test('改行を混ぜて、別の合言葉を足させない', async () => {
    const p = join(await tempDir('aas-env-'), '.env');
    await assert.rejects(writeEnvValue(p, 'A', 'x\nB=y'), /改行/);
  });

  test('名前として使えないものは断る', async () => {
    const p = join(await tempDir('aas-env-'), '.env');
    await assert.rejects(writeEnvValue(p, 'A B', 'x'), /使えません/);
    await assert.rejects(writeEnvValue(p, '1A', 'x'), /使えません/);
  });
});
