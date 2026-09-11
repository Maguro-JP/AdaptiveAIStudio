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
    assert.match(calls[0]!.args[1]!, /scripts[\\/]run-tests\.mjs$/);

    const { runner: r2, calls: c2 } = make();
    r2.start('doctor');
    assert.match(c2[0]!.args[1]!, /src[\\/]cli[\\/]doctor\.ts$/);
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

  test('**出力をファイルに残す**（画面は捨てるし、閉じれば消える）', async () => {
    const { tempDir } = await import('./tmp.ts');
    const { readFile, readdir } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const dir = await tempDir('aas-reports-');
    const said: TaskEvent[] = [];
    const { spawnFn, children } = fakeSpawn();
    const runner = new TaskRunner({ root: '/app', onEvent: (e) => said.push(e), spawnFn, reportsDir: dir });
    runner.start('test');
    children[0]!.stdout.emit('data', Buffer.from('ok 1 - a\n'));
    children[0]!.stderr.emit('data', Buffer.from('not ok 2 - b\n'));
    children[0]!.emit('close', 1);
    const { until } = await import('./until.ts');
    await until(() => said.some((e) => e.code !== undefined), '終わる', { timeoutMs: 5000 });
    const files = (await readdir(dir)).filter((f) => f.startsWith('test-'));
    assert.equal(files.length, 1, `残っていない: ${JSON.stringify(files)}`);
    const body = await readFile(join(dir, files[0]!), 'utf8');
    assert.ok(body.includes('ok 1 - a') && body.includes('not ok 2 - b'), body);
    assert.ok(body.includes('終了コード 1'), body);
    // どこへ置いたかを、流れにも言う。
    assert.ok(said.some((e) => e.text?.includes('残しました:')), JSON.stringify(said));
    // 終わりの合図は、置いた後。
    const doneAt = said.findIndex((e) => e.code !== undefined);
    const toldAt = said.findIndex((e) => e.text?.includes('残しました:'));
    assert.ok(toldAt < doneAt, '置く前に終わったと言っている');
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

describe('旗が要る Node では、旗を付けて起こす', () => {
  test('22.6 なら --experimental-strip-types を付ける', () => {
    const { spawnFn, calls } = fakeSpawn();
    const runner = new TaskRunner({ root: '/app', onEvent: () => {}, spawnFn, nodeVersion: 'v22.6.0' });
    assert.equal(runner.start('doctor'), undefined);
    assert.ok(calls[0]!.args.includes('--experimental-strip-types'), calls[0]!.args.join(' '));
  });
  test('24 なら付けない（対）', () => {
    const { spawnFn, calls } = fakeSpawn();
    const runner = new TaskRunner({ root: '/app', onEvent: () => {}, spawnFn, nodeVersion: 'v24.18.0' });
    assert.equal(runner.start('doctor'), undefined);
    assert.ok(!calls[0]!.args.includes('--experimental-strip-types'));
  });
});

describe('点検の子は CPU を譲る', () => {
  test('下げた優先度が、子の側から見える', async () => {
    const { lowerPriority } = await import('../src/ui/tasks.ts');
    const { spawn } = await import('node:child_process');
    // 合図が来るまで待ってから、自分の優先度を言う子。
    // 待たせないと、下げる前に言い終えることがある。
    const child = spawn(process.execPath, ['-e',
      "process.stdin.once('data', () => { console.log(require('node:os').getPriority()); process.exit(0); })"]);
    let out = '';
    child.stdout.on('data', (b: Buffer) => { out += b.toString(); });
    const done = new Promise<void>((r) => child.on('close', () => r()));
    const lowered = lowerPriority(child.pid);
    child.stdin.write('go\n');
    await done;
    if (!lowered) {
      // 下げられない環境（権限）。点検は回るが、譲れてはいない。
      assert.notEqual(out.trim(), '10');
      return;
    }
    assert.equal(out.trim(), '10', `子から見た優先度: ${out.trim()}`);
  });

  test('pid が無ければ、下げたと言わない（対）', async () => {
    const { lowerPriority } = await import('../src/ui/tasks.ts');
    assert.equal(lowerPriority(undefined), false);
  });
});
