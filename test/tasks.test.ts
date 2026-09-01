/**
 * 点検を回す係。
 *
 * 名前を決め打ちにしてあるのが要点。package.json をそのまま実行できる
 * 作りにすると、そこを書き換えた者が何でも走らせられる口になる。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { TaskRunner, TASKS, stripAnsi } from '../src/ui/tasks.ts';
import type { TaskEvent } from '../src/ui/tasks.ts';

/** 起こしたことにする。出す中身と終わり方を、試験から決められる。 */
function fakeSpawn() {
  const calls: { file: string; args: string[] }[] = [];
  const children: (EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void })[] = [];
  const spawnFn = ((file: string, args: string[]) => {
    calls.push({ file, args });
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      killed: false,
      kill() { this.killed = true; },
    });
    children.push(child);
    return child;
  }) as never;
  return { spawnFn, calls, children };
}

function make(said: TaskEvent[] = []) {
  const { spawnFn, calls, children } = fakeSpawn();
  const runner = new TaskRunner({ root: '/app', onEvent: (e) => said.push(e), spawnFn });
  return { runner, calls, children, said };
}

describe('点検を回す係', () => {
  test('決めた名前だけを受け取る', () => {
    const { runner } = make();
    assert.equal(runner.start('doctor'), undefined);
    const { runner: r2 } = make();
    assert.match(r2.start('rm -rf /') ?? '', /ありません/);
    // package.json に載っていても、ここに無ければ回さない。
    assert.match(r2.start('bundle') ?? '', /ありません/);
  });

  test('検査だけは走らせ役を通す', () => {
    // 環境ごとの差（殻の glob 展開、型剥がしの要否）をそこへ閉じ込めてある。
    const { runner, calls } = make();
    runner.start('test');
    assert.match(calls[0]!.args[1]!, /scripts\/run-tests\.mjs$/);

    const { runner: r2, calls: c2 } = make();
    r2.start('doctor');
    assert.match(c2[0]!.args[1]!, /src\/cli\/doctor\.ts$/);
  });

  test('一度に一つだけ', () => {
    const said: TaskEvent[] = [];
    const { runner } = make(said);
    runner.start('doctor');
    assert.equal(runner.running, 'doctor');
    assert.match(runner.start('test') ?? '', /doctor を回しています/);
  });

  test('出てきたものを流し、終わりを言う', () => {
    const said: TaskEvent[] = [];
    const { runner, children } = make(said);
    runner.start('doctor');
    children[0]!.stdout.emit('data', Buffer.from('\x1b[32m ok \x1b[0m Node\n'));
    children[0]!.emit('close', 0);

    // 端末むけの色は落として渡す。画面に [32m が並ぶと読めない。
    assert.ok(said.some((e) => e.text === ' ok  Node\n'), JSON.stringify(said));
    assert.deepEqual(said.at(-1), { name: 'doctor', code: 0 });
    assert.equal(runner.running, undefined, '終わったのに回しているままになっている');
  });

  test('終了コードを、そのまま伝える', () => {
    const said: TaskEvent[] = [];
    const { runner, children } = make(said);
    runner.start('test');
    children[0]!.emit('close', 3);
    assert.deepEqual(said.at(-1), { name: 'test', code: 3 });
  });

  test('止めたときは、止めたものの名前を返す', () => {
    const { runner } = make();
    runner.start('doctor');
    assert.equal(runner.stop(), 'doctor');
    // 回していなければ、何もしない。
    const { runner: r2 } = make();
    assert.equal(r2.stop(), undefined);
  });

  test('一覧は、名前と見出しの組で出す', () => {
    const list = TaskRunner.list();
    assert.deepEqual(list.map((t) => t.id), Object.keys(TASKS));
    assert.ok(list.every((t) => t.name.length > 0), '見出しの無いものがある');
  });

  test('色指定だけを落とす', () => {
    assert.equal(stripAnsi('\x1b[36mA\x1b[0m — b'), 'A — b');
    assert.equal(stripAnsi('日本語はそのまま'), '日本語はそのまま');
  });
});
