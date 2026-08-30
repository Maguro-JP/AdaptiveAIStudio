/**
 * 行入力の検証。
 * 起動処理を待っている間に届いた入力を捨てないこと。
 * これを落とすと `echo "依頼" | aas agent` が何もせず終了する。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
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
