/**
 * コマンドの実行・git・コードの索引の不具合（38 回目の調査）。
 *
 * - 後ろで動く子が出力を掴んだままでも、命令が終わったら待ち続けない
 * - 出力の頭を落としたことを、コンテキストウィンドウが広くても言う
 * - git の出力（標準出力）と警告（標準エラー）を混ぜて読まない
 * - git の打ち切りで、子のプロセスツリーごと止める
 * - 指示の `$ARGUMENTS` に入れる文の `$&` `$$` を置き換えの記号として読まない
 * - repo map が依頼のファイルを含むかを、道の一部の一致で決めない
 * - 索引から読むとき、作業場の外へ出るリンクと大きすぎるファイルを読まない
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, symlink, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { until } from './until.ts';
import { execCommand } from '../src/agent/shell-exec.ts';
import { runWithin } from '../src/agent/git.ts';
import { fill } from '../src/agent/commands.ts';
import { covers } from '../src/agent/repo-map.ts';
import { readIndexed } from '../src/agent/tools/find.ts';
import { createRunCommandTool } from '../src/agent/tools/shell.ts';
import type { CodeIndex } from '../src/agent/code-index.ts';

const posix = process.platform === 'win32' ? 'POSIX の殻と処理群で確かめる' : false;

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe('後ろで動く子', { skip: posix }, () => {
  test('**命令が終わったら、出力を掴んだままの子を待ち続けない**（止めて返す）', async () => {
    const root = await tempDir('aas-cgg-bg-');
    const started = Date.now();
    const r = await execCommand('sleep 30 & echo pid=$!', root, 20_000, new AbortController().signal);
    assert.ok(Date.now() - started < 10_000, `${Date.now() - started} ms 待った`);
    assert.equal(r.timedOut, false);
    assert.equal(r.code, 0);
    const pid = Number(/pid=(\d+)/.exec(r.output)?.[1]);
    assert.ok(pid > 0, r.output);
    await until(() => !alive(pid), '後ろの子が残っている');
    assert.match(r.output, /後ろで動いていた/);
  });

  test('出力を掴まない子しかいないなら、すぐ返す（断りも付けない）', async () => {
    const root = await tempDir('aas-cgg-fg-');
    const r = await execCommand('echo done', root, 20_000, new AbortController().signal);
    assert.equal(r.code, 0);
    assert.doesNotMatch(r.output, /後ろで動いていた/);
  });
});

describe('出力の頭を落としたこと', () => {
  test('**上限を超えて頭を落としたら、そう記号を付ける**', async () => {
    const root = await tempDir('aas-cgg-cut-');
    const node = JSON.stringify(process.execPath);
    const r = await execCommand(`${node} -e "process.stdout.write('a'.repeat(5000))"`, root, 20_000, new AbortController().signal, 1000);
    assert.equal(r.truncatedHead, true);
    const s = await execCommand(`${node} -e "process.stdout.write('a'.repeat(10))"`, root, 20_000, new AbortController().signal, 1000);
    assert.notEqual(s.truncatedHead, true);
  });

  test('**コンテキストウィンドウが広くても、run_command は頭を落としたと言う**', async () => {
    const root = await tempDir('aas-cgg-cut2-');
    const tool = createRunCommandTool({ allowed: ['node'] });
    const r = await tool.run(
      { command: `node -e "process.stdout.write('b'.repeat(300000))"` },
      { root, signal: new AbortController().signal, approve: async () => true, contextTokens: 1_000_000 },
    );
    assert.match(r.content, /前略/);
  });
});

describe('git を呼ぶ口', () => {
  test('**標準出力と標準エラーを分けて返す**（警告が欄の途中に割り込まない）', async () => {
    const r = await runWithin(process.execPath, ['-e', "process.stdout.write('?? a.');process.stderr.write('warning: x\\n');process.stdout.write('ts\\0')"], process.cwd(), 10_000);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '?? a.ts\0');
    assert.match(r.out, /warning: x/);
  });

  test('**打ち切ったら、子のプロセスツリーごと止める**', { skip: posix }, async () => {
    const root = await tempDir('aas-cgg-tree-');
    const pidFile = join(root, 'pid');
    const script = `const c=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setTimeout(()=>{},60000)`;
    const r = await runWithin(process.execPath, ['-e', script], root, 1500);
    assert.equal(r.code, -1);
    const pid = Number(await readFile(pidFile, 'utf8'));
    await until(() => !alive(pid), '打ち切った後も孫が残っている');
  });
});

describe('指示の $ARGUMENTS', () => {
  test('**入れる文の $& $$ $` $\' を、そのまま入れる**', () => {
    const cmd = { name: 'fix', description: '', template: '直す: $ARGUMENTS', source: 'builtin' } as unknown as Parameters<typeof fill>[0];
    const args = "sed 's/x/$&/' と $$ と $` と $'";
    assert.equal(fill(cmd, args), `直す: ${args}`);
  });
});

describe('repo map が依頼のファイルを含むか', () => {
  const index = { files: [{ path: 'a.ts' }] } as unknown as CodeIndex;
  const seed = new Map([[0, 10]]);

  test('**道の一部の一致（data.ts・a.ts.bak）で、含むと決めない**', () => {
    assert.equal(covers('src/data.ts\n  3: f\nsrc/a.ts.bak\n', index, seed), false);
  });

  test('道そのものが見出しにあれば含む（説明付きの見出しも）', () => {
    assert.equal(covers('a.ts\n  3: f\n', index, seed), true);
    assert.equal(covers('a.ts  — 設定を読む\n', index, seed), true);
  });
});

describe('索引から読む', () => {
  test('**作業場の外を指すリンクは読まない**', { skip: process.platform === 'win32' ? 'リンクを作る権限が要る' : false }, async () => {
    const root = await tempDir('aas-cgg-link-');
    const outside = await tempDir('aas-cgg-out-');
    await writeFile(join(outside, 'secret.ts'), 'export const token = 1;\n');
    await mkdir(join(root, 'src'));
    await symlink(join(outside, 'secret.ts'), join(root, 'src', 'a.ts'));
    await assert.rejects(readIndexed(root, 'src/a.ts'));
  });

  test('**大きすぎるファイルは読まない。普通のものは読む**', async () => {
    const root = await tempDir('aas-cgg-big-');
    await writeFile(join(root, 'big.ts'), 'x'.repeat(500_000));
    await writeFile(join(root, 'ok.ts'), 'export const a = 1;\n');
    await assert.rejects(readIndexed(root, 'big.ts'));
    assert.equal(await readIndexed(root, 'ok.ts'), 'export const a = 1;\n');
  });
});
