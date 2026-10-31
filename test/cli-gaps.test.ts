/**
 * 73 回目の不具合調査（src/cli）の分。
 *
 * - 依頼が失敗したら、`aas agent` は 1 で終える（流し込んで使う呼び手が「通った」と読まない）
 * - 設定が壊れていても、selftest は報告のファイルを出して 1 で終える
 * - doctor は、設定で決めた llama-server（`runtime.command`）を確かめる
 * - 「新しい世代」の案内は、渡された書き方で一手を言う（配った形に npm は無い）
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, readdir, readFile, chmod } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { startFakeServer, type FakeServer } from './fake-server.ts';
import { installRoot } from '../src/core/home.ts';
import { needsStripFlag } from '../src/core/node-flags.ts';
import { cleanAasEnv } from './env.ts';
import { describeNewer } from '../src/runtime/model-updates.ts';

const flags = needsStripFlag(process.versions.node) ? ['--experimental-strip-types'] : [];

/** CLI を子として起こし、stdin に `input` を流して閉じる。終わるまで待つ。 */
function runCli(script: string, env: NodeJS.ProcessEnv, input = ''): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...flags, '--no-warnings', join(installRoot(), 'src', 'cli', script)], {
      env: cleanAasEnv({ NO_COLOR: '1', ...env }), stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (b: Buffer) => { out += b.toString(); });
    child.stderr.on('data', (b: Buffer) => { out += b.toString(); });
    const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out }); });
    child.stdin.end(input);
  });
}

describe('selftest', { timeout: 120_000 }, () => {
  test('**設定が壊れていても、報告のファイルを出して 1 で終える**', async () => {
    const dir = await tempDir('aas-cli-gaps-');
    const config = join(dir, 'aas.config.json');
    await writeFile(config, '{ "candidates": [], }');
    const reports = join(dir, 'reports');
    await mkdir(reports, { recursive: true });
    const r = await runCli('selftest.ts', {
      AAS_CONFIG: config, AAS_HOME: join(dir, 'home'), AAS_STATE_DIR: join(dir, 'state'), AAS_REPORT_DIR: reports,
    });
    assert.equal(r.code, 1, r.out.slice(-800));
    const files = await readdir(reports);
    assert.ok(files.length > 0, `報告のファイルが無い:\n${r.out.slice(-800)}`);
    const text = await readFile(join(reports, files[0]!), 'utf8');
    assert.match(text, /NG\s+設定/, `設定が NG と書いていない:\n${text}`);
    assert.match(text, /環境/, `そこまでの結果が無い:\n${text}`);
  });
});

describe('新しい世代の案内', () => {
  test('一手は渡された書き方で言う（配った形では npm を言わない）', () => {
    const text = describeNewer([{ current: 'a', found: ['b'] }], (task, args) => `AdaptiveAIStudio.cmd ${task}${args ? ` ${args}` : ''}`);
    assert.doesNotMatch(text, /npm/, text);
    assert.match(text, /AdaptiveAIStudio\.cmd models --get/, text);
  });
});

describe('doctor の llama-server', { timeout: 120_000, skip: process.platform === 'win32' ? '実行できる偽物をシェルの台本で作るため' : false }, () => {
  test('**`runtime.command` で決めた道を確かめる**（自前で入れていなくても「まだ用意していません」と言わない）', async () => {
    const dir = await tempDir('aas-cli-gaps-');
    const fakeLlama = join(dir, 'my-llama-server');
    await writeFile(fakeLlama, '#!/bin/sh\necho "version: 4321 (fake)"\n');
    await chmod(fakeLlama, 0o755);
    const config = join(dir, 'aas.config.json');
    await writeFile(config, JSON.stringify({ runtime: { kind: 'llamacpp', command: fakeLlama } }));
    const r = await runCli('doctor.ts', { AAS_CONFIG: config, AAS_HOME: join(dir, 'home'), AAS_STATE_DIR: join(dir, 'state') });
    assert.doesNotMatch(r.out, /まだ用意していません/, r.out.slice(-1500));
    assert.match(r.out, /version: 4321/, `指定した道を起こしていない:\n${r.out.slice(-1500)}`);
  });
});
