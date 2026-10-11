/**
 * 行入力の検証。
 * 起動処理を待っている間に届いた入力を捨てないこと。
 * これを落とすと `echo "依頼" | aas agent` が何もせず終了する。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable, PassThrough } from 'node:stream';
import { LineSource } from '../src/cli/input.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function sink() {
  const chunks: string[] = [];
  const w = new Writable({
    write(chunk, _enc, cb) { chunks.push(String(chunk)); cb(); },
  });
  return { w, text: () => chunks.join('') };
}

describe('行入力', () => {
  test('question を呼ぶ前に届いた行を捨てない', async () => {
    const input = Readable.from(['/context\n/exit\n']);
    const { w } = sink();
    const src = new LineSource(input, w);

    // 起動処理の模擬。この間に入力は流れ切ってしまう。
    await sleep(30);

    assert.equal(await src.question('> '), '/context');
    assert.equal(await src.question('> '), '/exit');
  });

  test('入力が尽きたら undefined を返す（例外を投げない）', async () => {
    const input = Readable.from(['only\n']);
    const { w } = sink();
    const src = new LineSource(input, w);
    await sleep(20);

    assert.equal(await src.question('> '), 'only');
    assert.equal(await src.question('> '), undefined);
    assert.equal(await src.question('> '), undefined, '2回目以降も落ちない');
  });

  test('対話的に後から届いた行も受け取れる', async () => {
    const input = new Readable({ read() {} });
    const { w } = sink();
    const src = new LineSource(input, w);

    const pending = src.question('> ');
    await sleep(10);
    input.push('later\n');

    assert.equal(await pending, 'later');
  });

  test('待っている最中に入力が閉じたら undefined', async () => {
    const input = new Readable({ read() {} });
    const { w } = sink();
    const src = new LineSource(input, w);

    const pending = src.question('> ');
    await sleep(10);
    input.push(null);

    assert.equal(await pending, undefined);
  });

  test('溜まっていた行も画面に出す（何が実行されたか分かるように）', async () => {
    const input = Readable.from(['queued\n']);
    const { w, text } = sink();
    const src = new LineSource(input, w);
    await sleep(20);

    await src.question('依頼> ');
    assert.match(text(), /依頼> queued/);
  });

  test('複数行が順番どおりに取り出される', async () => {
    const input = Readable.from(['a\nb\nc\n']);
    const { w } = sink();
    const src = new LineSource(input, w);
    await sleep(20);

    assert.deepEqual(
      [await src.question('> '), await src.question('> '), await src.question('> ')],
      ['a', 'b', 'c'],
    );
  });
});

describe('止めたときの、待っている問い', () => {
  test('cancelWaiting で、待っている問いが「答え無し」で返る（Enter を押すまで待たせない）', async () => {
    const input = new PassThrough();
    const src = new LineSource(input, new PassThrough());
    const asked = src.question('許可しますか？ ');
    src.cancelWaiting();
    assert.equal(await asked, undefined);
    src.close();
  });
});

describe('Ctrl-C（SIGINT）', () => {
  // Windows の kill('SIGINT') はシグナルを届けず強制終了するので、この形では確かめられない
  test('端末でない入力でも、止める処理に届く（プロセスごと落ちない）', { skip: process.platform === 'win32' && 'Windows では SIGINT を送れない' }, async () => {
    const { spawn } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const probe = fileURLToPath(new URL('./fixtures/sigint-probe.mts', import.meta.url));
    const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', probe], { stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    let sent = false;
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      // 一度だけ送る。READY と「> 」が別の塊で届くと、HANDLER の前に二度送って二度押しになり、ENDED の前に終わっていた
      if (out.includes('READY') && !sent) { sent = true; setTimeout(() => child.kill('SIGINT'), 100).unref(); }
    });
    // 終わらない形に戻っても、試験ごと止まらないように打ち切る
    const stuck = setTimeout(() => child.kill('SIGKILL'), 15_000);
    const exit = await new Promise<{ code: number | null; signal: string | null }>((ok) => child.on('close', (code, signal) => ok({ code, signal })));
    clearTimeout(stuck);
    assert.match(out, /HANDLER/, `止める処理に届かず落ちた: ${JSON.stringify({ out, ...exit })}`);
    // 止める処理の後、きれいに終わる（別の理由で落ちていない）
    assert.match(out, /ENDED/);
    assert.deepEqual(exit, { code: 0, signal: null });
  });

  test('止める処理が詰まっても、2 秒以内に二度押せば終わる', { skip: process.platform === 'win32' && 'Windows では SIGINT を送れない' }, async () => {
    const { spawn } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const probe = fileURLToPath(new URL('./fixtures/sigint-probe.mts', import.meta.url));
    const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', probe, 'stuck'], { stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    let sent = 0;
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      if (out.includes('READY') && sent === 0) { sent = 1; setTimeout(() => child.kill('SIGINT'), 100).unref(); }
      if (out.includes('HANDLER') && sent === 1) { sent = 2; setTimeout(() => child.kill('SIGINT'), 100).unref(); }
    });
    const stuck = setTimeout(() => child.kill('SIGKILL'), 15_000);
    const exit = await new Promise<{ code: number | null; signal: string | null }>((ok) => child.on('close', (code, signal) => ok({ code, signal })));
    clearTimeout(stuck);
    assert.deepEqual(exit, { code: 130, signal: null }, `二度押しで終わらなかった: ${JSON.stringify({ out, ...exit })}`);
  });
});

describe('承認の問いは、先に打ってある依頼を食べない', () => {
  /**
   * `question` は溜まっている行から先に取るので、作業の最中に次の依頼を打っておくと、承認の [y/N] がその依頼を答えとして
   * 食べていた（y でないので断られ、次の依頼も消える）。
   */
  test('askNow は溜まった行を残し、これから打たれる行で答える', async () => {
    const input = new PassThrough();
    const src = new LineSource(input, new PassThrough());
    input.write('依頼1\n次の依頼\n');
    await sleep(20);
    assert.equal(await src.question('> '), '依頼1');
    const asked = src.askNow('許可しますか？ ');
    input.write('y\n');
    assert.equal(await asked, 'y', '承認の答えに、先に打ってあった依頼を使った');
    assert.equal(await src.question('> '), '次の依頼', '先に打ってあった依頼が消えた');
    src.close();
  });

  test('入力が閉じていれば、askNow は答え無し（許可しない）で、溜まった行は残る', async () => {
    const src = new LineSource(Readable.from(['依頼1\n残る依頼\n']), new PassThrough());
    await sleep(30);
    assert.equal(await src.question('> '), '依頼1');
    assert.equal(await src.askNow('許可しますか？ '), undefined);
    assert.equal(await src.question('> '), '残る依頼');
  });
});

describe('入力を待っているか（DECISIONS 10-11、114 回目）', () => {
  test('question で待っている間だけ waiting が立ち、行が届くと倒れる', async () => {
    const input = new PassThrough();
    const { w } = sink();
    const src = new LineSource(input, w);
    assert.equal(src.waiting, false, '待つ前から立っている（命令の実行中の Ctrl-C で対話を閉じてしまう）');
    const asked = src.question('> ');
    assert.equal(src.waiting, true, '待っているのに立っていない（入力待ちの Ctrl-C で終われない）');
    input.write('hello\n');
    assert.equal(await asked, 'hello');
    assert.equal(src.waiting, false);
    src.close();
  });
});

test('端末の Ctrl-C は、入力を待っているときだけ対話を閉じる（書き方で止める）', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const f of ['src/cli/agent.ts', 'src/cli/main.ts']) {
    const text = (await readFile(new URL(`../${f}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
    const at = text.indexOf('rl.onSigint(');
    const body = text.slice(at, text.indexOf('});', at));
    assert.match(body, /rl\.waiting\) rl\.close\(\)/, `${f}: 入力を待っているかを見ずに閉じている`);
  }
});
