/**
 * 入口の「4 動くか確かめる」（`scripts/smoke.mjs`）は、利用者の記録に書かない（44 回目の調査）。
 *
 * 押すたびに「1+1=」の会話が利用者の履歴に増え、画面を開いたまま押すと同じ記録に本体が二つ立っていた。
 * 記録のフォルダだけを仮のフォルダへ向け、終わったら消す。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './tmp.ts';

const smoke = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'smoke.mjs');

test('**smoke は、AAS_HOME に記録を書かず、仮のフォルダも残さない**', { timeout: 120_000 }, async () => {
  const home = await tempDir('aas-smoke-home-');
  const tmp = await tempDir('aas-smoke-tmp-');
  const cfg = join(home, 'cfg.json');
  // モデルの無い設定。送りは断られる（それが正しい）ので、ネットワークも重みも要らない
  await writeFile(cfg, JSON.stringify({ providers: [], candidates: [], runtime: { kind: 'none' } }));
  const env: NodeJS.ProcessEnv = { ...process.env, AAS_HOME: home, AAS_CONFIG: cfg, TMPDIR: tmp, TEMP: tmp, TMP: tmp };
  delete env.AAS_STATE_DIR;
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', smoke], { env, encoding: 'utf8', timeout: 100_000 });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /送ったときの返り方/, '前提: 送るところまで回っていない');
  assert.deepEqual(await readdir(home), ['cfg.json'], '利用者の AAS_HOME に書いた');
  assert.deepEqual(await readdir(tmp), [], '仮のフォルダを残した');
});
