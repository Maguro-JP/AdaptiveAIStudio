/**
 * start.sh が start.cmd と揃っていなかった所（86 回目の調査）。
 *
 * - Node の版を見ていなかった。22.6 より古いと、型の除去の旗が分からずに、意味の取れないエラーで落ちていた
 * - 画面の「立ち上げ直す」の合図（AAS_RELAUNCH）を渡さず、終わりの番号 75 でもう一度起こしていなかった
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, copyFile, chmod, mkdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, delimiter } from 'node:path';
import { tempDir } from './tmp.ts';
import { installRoot } from '../src/core/home.ts';

/** start.sh を仮の場所へ写し、偽の node と npm を置く。 */
async function sandbox(nodeVersion: string, npmBody: string): Promise<{ dir: string; log: string; env: NodeJS.ProcessEnv }> {
  const dir = await tempDir('aas-start-sh2-');
  const app = join(dir, 'app');
  const bin = join(dir, 'bin');
  await mkdir(app, { recursive: true });
  await mkdir(bin, { recursive: true });
  await copyFile(join(installRoot(), 'start.sh'), join(app, 'start.sh'));
  const log = join(dir, 'npm.log');
  await writeFile(join(bin, 'node'), `#!/bin/sh\n[ "$1" = "-v" ] && echo ${nodeVersion}\nexit 0\n`);
  await writeFile(join(bin, 'npm'), `#!/bin/sh\nLOG=${JSON.stringify(log)}\n${npmBody}\n`);
  await chmod(join(bin, 'node'), 0o755);
  await chmod(join(bin, 'npm'), 0o755);
  return { dir: app, log, env: { ...process.env, AAS_RELAUNCH: '', PATH: `${bin}${delimiter}/usr/bin${delimiter}/bin` } };
}

describe('start.sh', { skip: process.platform === 'win32' ? 'sh で動かす入口のため' : false }, () => {
  test('Node が 22.6 より古ければ、そう言って止まる', async () => {
    const { dir, log, env } = await sandbox('v20.11.0', 'echo "$*" >> "$LOG"');
    const r = spawnSync('sh', [join(dir, 'start.sh'), 'doctor'], { env, encoding: 'utf8' });
    assert.notEqual(r.status, 0, r.stdout);
    assert.match(r.stdout, /22\.6/, r.stdout);
    assert.equal(await readFile(log, 'utf8').catch(() => ''), '', '古い Node のまま動かした');
  });

  test('22.6 以降なら、そのまま動かす（対）', async () => {
    const { dir, log, env } = await sandbox('v22.6.0', 'echo "$*" >> "$LOG"');
    const r = spawnSync('sh', [join(dir, 'start.sh'), 'doctor'], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(await readFile(log, 'utf8'), /^run doctor$/m);
  });

  test('取り込まなかった（10）ときは、立ち上げ直しを訊かずに 0 で終える', async () => {
    const { dir, env } = await sandbox('v24.1.0', 'exit 10');
    const r = spawnSync('sh', [join(dir, 'start.sh'), 'update'], { env, encoding: 'utf8', input: '' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /立ち上げ直しますか/, r.stdout);
  });

  test('取り込んだ（0）ときは、立ち上げ直しを訊く（対）', async () => {
    const { dir, env } = await sandbox('v24.1.0', 'exit 0');
    const r = spawnSync('sh', [join(dir, 'start.sh'), 'update'], { env, encoding: 'utf8', input: 'n\n' });
    assert.match(r.stdout, /立ち上げ直しますか/, r.stdout);
  });

  test('立ち上げ直しの合図を渡し、75 で終わったらもう一度起こす', async () => {
    // 1 回目は 75 で終わり、2 回目は 0 で終わる。受けた AAS_RELAUNCH も書き出す
    const body = 'echo "$AAS_RELAUNCH $*" >> "$LOG"\n[ "$(wc -l < "$LOG")" -lt 2 ] && exit 75\nexit 0';
    const { dir, log, env } = await sandbox('v24.1.0', body);
    const r = spawnSync('sh', [join(dir, 'start.sh'), 'ui'], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const lines = (await readFile(log, 'utf8')).trim().split('\n');
    assert.deepEqual(lines, ['1 run ui', '1 run ui'], lines.join('\n'));
  });
});
