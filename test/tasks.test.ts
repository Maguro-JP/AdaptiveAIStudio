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
      // 本物は kill のあと close を出す（信号で終わると code は null）。
      // ここで出さないと、止めたのに「まだ回している」ままに見える。
      kill() { this.killed = true; (this as unknown as EventEmitter).emit('close', null); },
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

  test('継いだ名前（constructor など）は点検の名前ではない', () => {
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const { runner, calls } = make();
      assert.match(runner.start(name) ?? '', /ありません/, `${name} を受け取っている`);
      assert.equal(calls.length, 0, `${name} で起こしている`);
    }
  });

  test('検査だけは走らせ役を通す', () => {
    // 環境ごとの差（殻の glob 展開、型剥がしの要否）をそこへ閉じ込めてある。
    // 旗の有無で位置が動くので、何番目かでは見ない。並びの中に在るかで見る。
    const { runner, calls } = make();
    runner.start('test');
    assert.ok(calls[0]!.args.some((a) => /scripts[\\/]run-tests\.mjs$/.test(a)), JSON.stringify(calls[0]!.args));

    const { runner: r2, calls: c2 } = make();
    r2.start('doctor');
    assert.ok(c2[0]!.args.some((a) => /src[\\/]cli[\\/]doctor\.ts$/.test(a)), JSON.stringify(c2[0]!.args));
  });

  test('同じものは二重に回さない。別のものは並べて回す', () => {
    // ここまでは「一度に一つだけ」で、doctor を回している間は test も回せなかった。
    // 診断は CPU を分け合うが、片方が終わるまで待たされないほうがよい。
    // 同じ名前は二重に回さない（出力が混ざるだけ）。別の名前は並べる。
    const said: TaskEvent[] = [];
    const { runner } = make(said);
    assert.equal(runner.start('doctor'), undefined);
    assert.deepEqual(runner.running, ['doctor']);
    // 同じものは断る。
    assert.match(runner.start('doctor') ?? '', /既に回しています/);
    // 別のものは並ぶ。
    assert.equal(runner.start('test'), undefined, '別の点検を並べられない');
    assert.deepEqual(runner.running.sort(), ['doctor', 'test']);
    assert.equal(runner.isRunning('test'), true);
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
    assert.deepEqual(runner.running, [], '終わったのに回しているままになっている');
  });

  test('片方が終わっても、もう片方は回り続ける', () => {
    // 並べたとき、一本の終わりで他を巻き込まない。
    const said: TaskEvent[] = [];
    const { runner, children } = make(said);
    runner.start('doctor');
    runner.start('test');
    // doctor（children[0]）だけ終わる。
    children[0]!.emit('close', 0);
    assert.deepEqual(runner.running, ['test'], 'doctor の終わりで test まで消えた');
    assert.equal(runner.isRunning('test'), true);
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
    runner.start('test');
    // 名前を渡せば、それだけ止める。
    assert.deepEqual(runner.stop('doctor'), ['doctor']);
    assert.deepEqual(runner.running, ['test'], 'doctor だけ止めるはずが test まで止まった');
    // 渡さなければ、残り全部。
    assert.deepEqual(runner.stop(), ['test']);
    // 回していなければ、何もしない。
    const { runner: r2 } = make();
    assert.deepEqual(r2.stop(), []);
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

  /**
   * 子が閉じてから報告を書き終えるまでの間も、動いていると答える。閉じた時点で外していたので、その間の「止める」は
   * 「動いていない」と答え、同じ名前の新しい回が始まると、古い回の終わりの知らせが新しい回を終わったことにした。
   */
  test('**報告を書いている間は、まだ動いていると答え、同じ名前を始めない**', async () => {
    const { tempDir } = await import('./tmp.ts');
    const dir = await tempDir('aas-reports-finishing-');
    const said: TaskEvent[] = [];
    const { spawnFn, children } = fakeSpawn();
    const runner = new TaskRunner({ root: '/app', onEvent: (e) => said.push(e), spawnFn, reportsDir: dir });
    runner.start('test');
    children[0]!.emit('close', 1); // 報告は非同期で書く。終わりの知らせはまだ
    assert.equal(said.some((e) => e.code !== undefined), false, '書き終える前に終わりを知らせた');
    assert.deepEqual(runner.running, ['test']);
    assert.equal(runner.isRunning('test'), true);
    assert.match(runner.start('test') ?? '', /既に回しています/);
    assert.equal(children.length, 1, '二本目を起こした');
    assert.deepEqual(runner.stop('test'), ['test']);
    assert.deepEqual(runner.stop(), ['test']);
    const { until } = await import('./until.ts');
    await until(() => said.some((e) => e.code !== undefined), '終わる', { timeoutMs: 5000 });
    assert.deepEqual(runner.running, []);
    assert.equal(runner.start('test'), undefined, '終わった後に始められない');
  });

  /**
   * 片づけるツールが、片づける対象を作っていた。
   *
   * 「片づけるものはありません。」の一行だけの回でも txt を置いていたので、
   * 押すたびに reports が増える。実機の画面に clean-20260915-1726.txt が残った。
   */
  test('**何も起きていない回は、残さない**', async () => {
    const { readdir } = await import('node:fs/promises');
    const { tempDir } = await import('./tmp.ts');
    const dir = await tempDir('aas-reports-none-');
    const said: TaskEvent[] = [];
    const { spawnFn, children } = fakeSpawn();
    const runner = new TaskRunner({ root: '/app', onEvent: (e) => said.push(e), spawnFn, reportsDir: dir });
    runner.start('clean');
    children[0]!.stdout.emit('data', Buffer.from('片づけるものはありません。\n'));
    children[0]!.emit('close', 0);
    const { until } = await import('./until.ts');
    await until(() => said.some((e) => e.code !== undefined), '終わる', { timeoutMs: 5000 });
    assert.deepEqual((await readdir(dir)).filter((f) => f.startsWith('clean-')), [],
      'ゴミを置いている');
    assert.ok(!said.some((e) => e.text?.includes('残しました:')), '置いたと言っている');
  });

  test('**うまくいかなかった回は、中身が短くても残す（対）**', async () => {
    const { readdir } = await import('node:fs/promises');
    const { tempDir } = await import('./tmp.ts');
    const dir = await tempDir('aas-reports-bad-');
    const said: TaskEvent[] = [];
    const { spawnFn, children } = fakeSpawn();
    const runner = new TaskRunner({ root: '/app', onEvent: (e) => said.push(e), spawnFn, reportsDir: dir });
    runner.start('clean');
    children[0]!.stdout.emit('data', Buffer.from('落ちました\n'));
    children[0]!.emit('close', 1);
    const { until } = await import('./until.ts');
    await until(() => said.some((e) => e.code !== undefined), '終わる', { timeoutMs: 5000 });
    assert.equal((await readdir(dir)).filter((f) => f.startsWith('clean-')).length, 1,
      '落ちた回まで捨てている');
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
