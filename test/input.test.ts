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
  test('端末でない入力でも、止める処理に届く（プロセスごと落ちない）', async () => {
    const { spawn } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const probe = fileURLToPath(new URL('./fixtures/sigint-probe.mts', import.meta.url));
    const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', probe], { stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      if (out.includes('READY') && !out.includes('HANDLER')) setTimeout(() => child.kill('SIGINT'), 100).unref();
    });
    const exit = await new Promise<{ code: number | null; signal: string | null }>((ok) => child.on('exit', (code, signal) => ok({ code, signal })));
    assert.match(out, /HANDLER/, `止める処理に届かず落ちた: ${JSON.stringify({ out, ...exit })}`);
    assert.equal(exit.signal, null);
  });
});
