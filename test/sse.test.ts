/**
 * 返ってくるものを行で読むところ。
 *
 * **途中でやめたときに、繋ぎを切ること**を見る。切らないと、返す側は
 * 誰も読まない答えを作り続け、次の依頼をその後ろで待たせる。
 * 錠を外す（releaseLock）だけでは切れない。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readSseLines } from '../src/providers/sse.ts';

/** 好きなだけ出し続ける流れ。切られたら、切られたと覚える。 */
function endless(): { body: ReadableStream<Uint8Array>; state: { canceled: boolean } } {
  const state = { canceled: false };
  const enc = new TextEncoder();
  let n = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) { c.enqueue(enc.encode(`data: ${n++}\n`)); },
    cancel() { state.canceled = true; },
  });
  return { body, state };
}

/** 決まった中身を、境目を無視して細切れに流す。 */
function chopped(text: string, size: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let at = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (at >= bytes.length) { c.close(); return; }
      c.enqueue(bytes.slice(at, at + size));
      at += size;
    },
  });
}

describe('行で読む', () => {
  test('data: の行だけを拾い、注釈は捨てる', async () => {
    const got: string[] = [];
    for await (const d of readSseLines(chopped(': hi\ndata: あ\ndata: い\n', 3))) got.push(d);
    assert.deepEqual(got, ['あ', 'い']);
  });

  test('文字の途中で切れても壊さない', async () => {
    // 「あ」は3バイト。1バイトずつ流せば必ず途中で切れる。
    const got: string[] = [];
    for await (const d of readSseLines(chopped('data: あいうえお\n', 1))) got.push(d);
    assert.deepEqual(got, ['あいうえお']);
  });

  test('改行で終わらなくても、最後の行を落とさない', async () => {
    const got: string[] = [];
    for await (const d of readSseLines(chopped('data: [DONE]', 2))) got.push(d);
    assert.deepEqual(got, ['[DONE]']);
  });
});

describe('途中でやめたら、繋ぎを切る', () => {
  test('読む側が抜けたら切れる', async () => {
    const { body, state } = endless();
    for await (const _ of readSseLines(body)) break;
    assert.equal(state.canceled, true, '抜けたのに繋ぎが開いたまま');
  });

  test('読む側が落ちても切れる', async () => {
    const { body, state } = endless();
    await assert.rejects(async () => {
      for await (const _ of readSseLines(body)) throw new Error('落ちた');
    });
    assert.equal(state.canceled, true, '落ちたのに繋ぎが開いたまま');
  });

  test('最後まで読んだときは切らない（対）', async () => {
    // 上の二つは「常に切る」でも通る。切らない側を並べる。
    let canceled = false;
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(enc.encode('data: あ\n')); c.close(); },
      cancel() { canceled = true; },
    });
    const got: string[] = [];
    for await (const d of readSseLines(body)) got.push(d);
    assert.deepEqual(got, ['あ']);
    assert.equal(canceled, false, '読み切ったのに切っている');
  });
});

describe('知らせの区切り（90 回目の調査）', () => {
  const all = async (text: string, size = 4): Promise<string[]> => {
    const got: string[] = [];
    for await (const d of readSseLines(chopped(text, size))) got.push(d);
    return got;
  };

  test('複数の data: 行に分かれた JSON は、一つに繋いで渡す', async () => {
    const got = await all('data: {"a":\ndata: 1}\n\ndata: {"b":2}\n\n');
    assert.deepEqual(got, ['{"a":\n1}', '{"b":2}']);
    assert.deepEqual(JSON.parse(got[0]!), { a: 1 });
  });

  test('\\r だけで区切る相手でも、行ごとに読む', async () => {
    assert.deepEqual(await all('data: {"a":1}\rdata: {"b":2}\r\r'), ['{"a":1}', '{"b":2}']);
  });

  test('\\r\\n が塊の境目で分かれても、空の行を挟まない（対）', async () => {
    assert.deepEqual(await all('data: {"a":1}\r\n\r\ndata: {"b":2}\r\n\r\n', 1), ['{"a":1}', '{"b":2}']);
  });

  test('data: の後ろの空白は一つだけ落とす', async () => {
    assert.deepEqual(await all('data:  x \n\n'), [' x ']);
  });
});
