/**
 * 75 回目の不具合調査（入口）の分。
 *
 * - start.sh: `sh start.sh` でも立ち上げ直せる。2 つ目からの引数も渡す
 * - start.cmd: 隣の `node\node.bin`（Z: は .exe を受け取らない）も探す。取り込みが失敗したら立ち上げ直さない
 *
 * start.cmd は cmd.exe でしか動かないので、ここでは書かれた行を見る（Windows の実機では確かめていない）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, copyFile, chmod, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, dirname, delimiter } from 'node:path';
import { tempDir } from './tmp.ts';
import { installRoot } from '../src/core/home.ts';

/** start.sh を仮の場所へ写し、受けた引数を書き出す偽の npm を置く。 */
async function shSandbox(): Promise<{ dir: string; npmLog: string; env: NodeJS.ProcessEnv }> {
  const dir = await tempDir('aas-start-sh-');
  const app = join(dir, 'app');
  const bin = join(dir, 'bin');
  await mkdir(app, { recursive: true });
  await mkdir(bin, { recursive: true });
  await copyFile(join(installRoot(), 'start.sh'), join(app, 'start.sh'));
  const npmLog = join(dir, 'npm.log');
  await writeFile(join(bin, 'npm'), `#!/bin/sh\necho "$*" >> ${JSON.stringify(npmLog)}\nexit 0\n`);
  await chmod(join(bin, 'npm'), 0o755);
  const env = { ...process.env, PATH: `${bin}${delimiter}${dirname(process.execPath)}${delimiter}/usr/bin${delimiter}/bin` };
  return { dir: app, npmLog, env };
}

describe('start.sh', { skip: process.platform === 'win32' ? 'sh で動かす入口のため' : false }, () => {
  test('**2 つ目からの引数も渡す**（`clean --yes` の --yes が落ちていた）', async () => {
    const { dir, npmLog, env } = await shSandbox();
    const r = spawnSync('sh', [join(dir, 'start.sh'), 'clean', '--yes'], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(await readFile(npmLog, 'utf8'), /^run clean -- --yes$/m);
  });

  test('引数が一つなら、そのまま（対）', async () => {
    const { dir, npmLog, env } = await shSandbox();
    spawnSync('sh', [join(dir, 'start.sh'), 'doctor'], { env, encoding: 'utf8' });
    assert.match(await readFile(npmLog, 'utf8'), /^run doctor$/m);
  });

  test('**`sh start.sh` で起こしても、新しくした後に立ち上げ直せる**', async () => {
    const { dir, env } = await shSandbox();
    // 7 = 新しくする → y = 立ち上げ直す → 0 = やめる
    const r = spawnSync('sh', ['start.sh'], { cwd: dir, env, input: '7\ny\n0\n', encoding: 'utf8' });
    const out = r.stdout + r.stderr;
    assert.doesNotMatch(out, /not found/, out);
    assert.equal((out.match(/番号を入れて Enter/g) ?? []).length, 2, `立ち上げ直していない:\n${out}`);
    assert.equal(r.status, 0, out);
  });
});

describe('start.cmd', () => {
  const source = async (): Promise<string> => new TextDecoder('shift_jis').decode(await readFile(join(installRoot(), 'start.cmd')));

  test('**隣の node.bin も探し、見つかれば .bin として呼ぶ**（Z: は .exe を受け取らない）', async () => {
    const text = await source();
    assert.match(text, /^if exist "%HERE%node\\node\.bin" set "BUNDLED=%HERE%node"\r?$/m, '隣の node\\node.bin を探していない');
    assert.match(text, /^if exist "%HERE%runtime\\node\.bin" set "BUNDLED=%HERE%runtime"\r?$/m);
    // .bin で見つけたときは NODEFILE を node.bin にしてから :bundled へ（node.exe のつもりで呼ぶと起こせない）
    const at = text.indexOf('if exist "%HERE%node\\node.bin"');
    const after = text.slice(at, at + 300);
    assert.match(after, /set "NODEFILE=node\.bin"[\s\S]*goto :bundled/, after);
  });

  test('**取り込みが失敗したら、立ち上げ直さない**', async () => {
    const text = await source();
    const at = text.search(/^:updated\r?$/m);
    assert.ok(at >= 0, ':updated が無い');
    const next = text.slice(at).split(/\r?\n/).slice(1, 4).join('\n');
    assert.match(next, /errorlevel[\s\S]*goto :ran/, `失敗を見ていない:\n${next}`);
  });
});
