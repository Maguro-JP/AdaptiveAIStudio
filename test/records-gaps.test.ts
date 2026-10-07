/**
 * 塊の差分・点検の報告・段取りの記録・スキルの読み方の不具合（53 回目の調査）。
 *
 * - 画面の点検で、同じ分のうちに二度回した報告が、前の報告を黙って上書きしていた
 * - BOM 付きの SKILL.md の頭書きを読まず、name: や description: の行まで指示の本文として送っていた
 * - 点検を止めても、走らせ役の下の `node --test` が管を持ったまま残り、終わりの知らせが来なかった（POSIX で見る）
 *
 * 末尾の改行だけの違いを差分に出すのは `test/hunks.test.ts`。段取りの記録の flush は、電源断を作れないので試験を書いていない。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readdir, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { until } from './until.ts';
import { TaskRunner, type TaskEvent } from '../src/ui/tasks.ts';
import { parseSkill } from '../src/agent/commands.ts';

function failingSpawn() {
  return ((): never => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(), stderr: new EventEmitter(), pid: undefined,
      kill() { (this as unknown as EventEmitter).emit('close', null); },
    });
    // 出力を一行書いて、落ちて終わる
    setTimeout(() => { child.stdout.emit('data', Buffer.from('FAIL x\n')); child.emit('close', 1); }, 10);
    return child as never;
  }) as never;
}

describe('点検の報告', () => {
  test('**同じ分のうちに二度回しても、前の報告を上書きしない**', async () => {
    const dir = await tempDir('aas-records-reports-');
    const said: TaskEvent[] = [];
    const runner = new TaskRunner({ root: '/app', onEvent: (e) => said.push(e), spawnFn: failingSpawn(), reportsDir: dir });
    // doctor・selftest は自分で報告を置くので、ここが置く点検（clean）で見る
    for (let i = 0; i < 2; i++) {
      assert.equal(runner.start('clean'), undefined);
      await until(() => !runner.isRunning('clean'), '点検が終わらない');
    }
    await until(async () => (await readdir(dir)).length >= 2, `報告が二つ残っていない: ${(await readdir(dir)).join(',')}`);
  });
});

describe('スキルの頭書き', () => {
  test('**BOM 付きでも頭書きを読む**', () => {
    const got = parseSkill('\uFEFF---\nname: tidy\ndescription: 片づける\n---\n本文\n', 'folder');
    assert.equal(got.name, 'tidy');
    assert.equal(got.description, '片づける');
    assert.equal(got.body.trim(), '本文');
  });
});

describe('点検を止める', () => {
  test('**止めると、走らせ役の下の子も止まり、終わりの知らせが来る**', { skip: process.platform === 'win32' ? 'POSIX の一群で見る' : false, timeout: 60_000 }, async () => {
    const root = await tempDir('aas-records-stop-');
    // 走らせ役（test の入口）の代わり: 子を起こし、管を受け継がせたまま眠る
    await mkdir(join(root, 'scripts'), { recursive: true });
    await writeFile(join(root, 'scripts', 'run-tests.mjs'), [
      "import { spawn } from 'node:child_process';",
      "spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['inherit', 'inherit', 'inherit'] });",
      'setInterval(() => {}, 1000);',
    ].join('\n'));
    const said: TaskEvent[] = [];
    const runner = new TaskRunner({ root, onEvent: (e) => said.push(e) });
    assert.equal(runner.start('test'), undefined);
    await new Promise((r) => setTimeout(r, 500));
    runner.stop('test');
    await until(() => !runner.isRunning('test'), '止めたのに、まだ回していることになっている', { timeoutMs: 10_000 });
  });
});
