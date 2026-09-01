/**
 * 塊を文字に直すところ、行に切るところ。
 *
 * 塊の切れ目は、文字の切れ目でも行の切れ目でもない。
 * 日本語は1文字3バイトなので、途中で切れると化ける。
 * 行も同じで、そのまま split すると一行が二行に割れる。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { chunkReader, lineReader } from '../src/core/text.ts';

/** 1バイトずつに割る。日本語なら必ず文字の途中で切れる。 */
function bytes(text: string): Buffer[] {
  return [...Buffer.from(text, 'utf8')].map((b) => Buffer.from([b]));
}

describe('文字に直す', () => {
  test('1バイトずつ届いても化けない', () => {
    const read = chunkReader();
    let got = '';
    for (const b of bytes('あいうえお')) got += read(b);
    assert.equal(got, 'あいうえお');
  });

  test('塊ごとに toString() すると化ける（比べる相手）', () => {
    // この検査は「直っていること」ではなく、**元がどう壊れていたか**を残す。
    let broken = '';
    for (const b of bytes('あいうえお')) broken += b.toString();
    assert.notEqual(broken, 'あいうえお');
    assert.match(broken, /�/);
  });

  test('読み手は流れごとに作る。使い回すと混ざる', () => {
    const shared = chunkReader();
    const [a, b] = [bytes('あ'), bytes('い')];
    // 二つの流れが交互に届く形。持ち越しが相手のものと混ざる。
    let got = '';
    got += shared(a[0]!); got += shared(b[0]!);
    got += shared(a[1]!); got += shared(b[1]!);
    got += shared(a[2]!); got += shared(b[2]!);
    assert.notEqual(got, 'あい', '使い回しても平気なら、この決めごとは要らない');
  });

  test('文字列で届いたら、そのまま通す', () => {
    const read = chunkReader();
    assert.equal(read('あ'), 'あ');
  });
});

describe('行に切る', () => {
  test('行が揃うまで持ち越す', () => {
    const r = lineReader();
    assert.deepEqual(r.push('あい'), []);
    assert.deepEqual(r.push('うえ\nおか'), ['あいうえ']);
    assert.deepEqual(r.push('\n'), ['おか']);
    assert.deepEqual(r.flush(), []);
  });

  test('改行で終わらない残りは flush で取る', () => {
    const r = lineReader();
    assert.deepEqual(r.push('さいご'), []);
    assert.deepEqual(r.flush(), ['さいご']);
    assert.deepEqual(r.flush(), [], '二度取れてはいけない');
  });

  test('1バイトずつでも、行も文字も壊れない', () => {
    const r = lineReader();
    const got: string[] = [];
    for (const b of bytes('ひとつめ\nふたつめ\n')) got.push(...r.push(b));
    assert.deepEqual(got, ['ひとつめ', 'ふたつめ']);
  });
});
