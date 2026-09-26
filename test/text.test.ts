/**
 * 塊を文字に直すところ、行に切るところ。
 *
 * 塊の切れ目は、文字の切れ目でも行の切れ目でもない。
 * 日本語は1文字3バイトなので、途中で切れると化ける。
 * 行も同じで、そのまま split すると一行が二行に割れる。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { chunkReader, lineReader, decodeText } from '../src/core/text.ts';

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

describe('ファイルの中身を文字にする', () => {
  // 「あいう」を CP932 で書いたもの。Excel の CSV やメモ帳がこれで来る。
  const CP932 = Buffer.from([0x82, 0xa0, 0x82, 0xa2, 0x82, 0xa4]);

  test('UTF-8 はそのまま', () => {
    const r = decodeText(Buffer.from('あいう', 'utf8'));
    assert.deepEqual(r, { text: 'あいう', encoding: 'utf-8', lossy: false });
  });

  test('CP932 は CP932 として読み、そう分かる', () => {
    const r = decodeText(CP932);
    assert.equal(r.text, 'あいう');
    assert.equal(r.encoding, 'shift_jis');
    assert.equal(r.lossy, false);
  });

  test('UTF-8 と決めつけると化ける（比べる相手）', () => {
    // 元の姿を残す。これが「読めない形式」と誤って弾かれていた。
    assert.match(CP932.toString('utf8'), /�/);
  });

  test('どちらでもないものは、化けを許して UTF-8 で読み、そう分かる', () => {
    // FF FE で始めると UTF-16LE の BOM になり、UTF-16 として読める。どちらでも読めないバイトにする。
    const r = decodeText(Buffer.from([0x80, 0xff, 0x41]));
    assert.equal(r.lossy, true);
  });

  test('先頭の BOM は落とす', () => {
    const r = decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a', 'utf8')]));
    assert.equal(r.text, 'a');
  });
});
