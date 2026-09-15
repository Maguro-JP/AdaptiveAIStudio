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

describe('合言葉のファイルは、本人しか読めないようにする', () => {
  /**
   * ここに入るのは `GITHUB_TOKEN` のような合言葉そのもの。既定のまま書くと
   * **644（同じ機械の他の利用者が読める）** になっていた。実測して直した。
   *
   * NetVision の `docs/DATA_PROTECTION.md` が「鍵をどこに置くかで守れる範囲が
   * 決まる」と書いていて、そのいちばん安い一手がここ。
   *
   * Windows では権限の考え方が違って、この一手はほぼ効かない。**効かない所で
   * 落とさない**ことと、効く所で効いていることを、それぞれ見る。
   */
  test('**新しく作るとき、600 で置く**', async () => {
    const { writeEnvValue } = await import('../src/core/env.ts');
    const { stat } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tempDir } = await import('./tmp.ts');
    const path = join(await tempDir('aas-env-perm-'), '.env');

    await writeEnvValue(path, 'GITHUB_TOKEN', 'ghp_dummy');
    const info = await stat(path);
    if (process.platform === 'win32') {
      // 権限の作りが違うので、ここでは中身が置けたことだけを見る。
      assert.ok(info.size > 0);
      return;
    }
    assert.equal((info.mode & 0o777).toString(8), '600', '他の利用者が読める権限で置いている');
  });

  test('**既にあるファイルにも、付け直す**', async () => {
    const { writeEnvValue } = await import('../src/core/env.ts');
    const { writeFile, stat, chmod } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tempDir } = await import('./tmp.ts');
    const path = join(await tempDir('aas-env-perm2-'), '.env');
    await writeFile(path, 'OTHER=1\n', 'utf8');
    await chmod(path, 0o644);

    await writeEnvValue(path, 'GITHUB_TOKEN', 'ghp_dummy');
    if (process.platform === 'win32') return;
    assert.equal(((await stat(path)).mode & 0o777).toString(8), '600',
      '前からあったファイルの権限が緩いまま');
  });

  test('前からあった行は残る（対）', async () => {
    const { writeEnvValue } = await import('../src/core/env.ts');
    const { writeFile, readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tempDir } = await import('./tmp.ts');
    const path = join(await tempDir('aas-env-perm3-'), '.env');
    await writeFile(path, '# 手で書いた注釈\nOTHER=1\n', 'utf8');
    await writeEnvValue(path, 'GITHUB_TOKEN', 'ghp_dummy');
    const text = await readFile(path, 'utf8');
    assert.match(text, /# 手で書いた注釈/);
    assert.match(text, /OTHER=1/);
  });
});
