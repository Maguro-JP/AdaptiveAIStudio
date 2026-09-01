/**
 * 渡されたファイルの預かり。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { Attachments, detectKind, safeName, MAX_BYTES } from '../src/ui/attachments.ts';

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe('種類の見分け', () => {
  test('拡張子で分かるものは、それで分ける', () => {
    assert.equal(detectKind('a.ts', Buffer.from('const x = 1')), 'text');
    assert.equal(detectKind('a.png', Buffer.from('なんでも')), 'image');
  });

  test('拡張子が無くても、中身で分かる', () => {
    // 拡張子の無いファイルは多い。名前だけに頼らない。
    assert.equal(detectKind('Makefile', Buffer.from('all:\n\techo hi')), 'text');
    assert.equal(detectKind('noname', png), 'image');
  });

  test('0 バイトが混ざっていれば、文字ものではない', () => {
    assert.equal(detectKind('x', Buffer.from([0x41, 0x00, 0x42])), 'binary');
  });
});

describe('名前の始末', () => {
  test('渡された名前を、そのまま置き場所に使わない', () => {
    assert.equal(safeName('../../etc/passwd'), 'passwd');
    assert.equal(safeName('C:\\Windows\\evil.txt'), 'evil.txt');
    assert.equal(safeName('a<b>c:d'), 'a_b_c_d');
    assert.equal(safeName(''), 'file');
    assert.equal(safeName('...'), 'file');
  });

  test('長すぎる名前は切る', () => {
    assert.ok(safeName('あ'.repeat(500)).length <= 120);
  });
});

describe('預かる', () => {
  const store = async () => new Attachments(join(await tempDir('aas-attach-'), 'files'));

  test('置いて、引ける', async () => {
    const s = await store();
    const item = await s.add('note.md', Buffer.from('# みだし'));
    assert.equal(item.kind, 'text');
    assert.equal(s.get(item.id)?.name, 'note.md');
    assert.equal(s.list().length, 1);
  });

  test('空のものは受け取らない', async () => {
    const s = await store();
    await assert.rejects(s.add('x.txt', Buffer.alloc(0)), /空/);
  });

  test('大きすぎるものは受け取らない', async () => {
    const s = await store();
    // 実体は作らない（試験で数十MBを書くと、それだけで遅くなる）
    const big = Buffer.alloc(0);
    Object.defineProperty(big, 'length', { value: MAX_BYTES + 1 });
    await assert.rejects(s.add('big.bin', big), /大きすぎ/);
  });

  test('外せる', async () => {
    const s = await store();
    const item = await s.add('a.txt', Buffer.from('x'));
    assert.equal(await s.drop(item.id), true);
    assert.equal(s.get(item.id), undefined);
    assert.equal(await s.drop(item.id), false);
  });
});

describe('依頼に添える形', () => {
  const store = async () => new Attachments(join(await tempDir('aas-attach-'), 'files'));

  test('文字ものは中身をそのまま入れる', async () => {
    const s = await store();
    const item = await s.add('main.ts', Buffer.from('const answer = 42;'));
    const text = await s.describe([item.id]);
    assert.match(text, /main\.ts/);
    assert.match(text, /const answer = 42;/);
  });

  test('長すぎる中身は切る。切ったことを言う', async () => {
    const s = await store();
    const item = await s.add('big.log', Buffer.from('あ'.repeat(50_000)));
    const text = await s.describe([item.id]);
    assert.match(text, /省略/);
  });

  test('画像は、読めないなら読めないと言う', async () => {
    const s = await store();
    const item = await s.add('shot.png', png);
    const text = await s.describe([item.id]);
    assert.match(text, /画像を読めません/);
    assert.match(text, /置き場所/);
  });

  test('画像を読めるモデルなら、場所だけ渡す', async () => {
    const s = await store();
    const item = await s.add('shot.png', png);
    const text = await s.describe([item.id], { canSeeImages: true });
    assert.equal(/読めません/.test(text), false);
  });

  test('読めない形式の中身は渡さない。場所を食うだけなので', async () => {
    const s = await store();
    const item = await s.add('a.bin', Buffer.from([0x41, 0x00, 0x42, 0x00]));
    const text = await s.describe([item.id]);
    assert.match(text, /中身を読めない形式/);
    assert.equal(text.includes('AB'), false);
  });

  test('知らない id は黙って飛ばす', async () => {
    const s = await store();
    assert.equal(await s.describe(['そんなものはない']), '');
  });
});

describe('溜めない', () => {
  test('古いものは片づける。渡したものは、その依頼が終われば要らない', async () => {
    const s = new Attachments(join(await tempDir('aas-attach-'), 'files'));
    const item = await s.add('a.txt', Buffer.from('xxxx'));
    // 1日経ったことにする
    const freed = await s.sweep(1, Date.now() + 2);
    assert.ok(freed > 0, '片づいていない');
    assert.equal(s.get(item.id), undefined);
  });

  test('新しいものは残す', async () => {
    const s = new Attachments(join(await tempDir('aas-attach-'), 'files'));
    const item = await s.add('a.txt', Buffer.from('xxxx'));
    assert.equal(await s.sweep(60_000), 0);
    assert.ok(s.get(item.id));
  });
});

describe('CP932 のファイルを、読めないと言わない', () => {
  // Excel が書いた CSV の形。見出しと一行、CP932。
  const csv = Buffer.from([
    0x96, 0xbc, 0x91, 0x4f, 0x2c, 0x92, 0x6c, 0x0d, 0x0a, // 名前,値\r\n
    0x82, 0xa0, 0x2c, 0x31, 0x0d, 0x0a,                    // あ,1\r\n
  ]);

  test('拡張子が無くても、文字ものと見る', () => {
    assert.equal(detectKind('メモ', csv), 'text');
  });

  test('依頼に差し込むとき、化けずに入り、CP932 だったと分かる', async () => {
    const box = new Attachments(await tempDir('aas-att-'));
    const item = await box.add('list.csv', csv);
    assert.equal(item.encoding, 'shift_jis');
    const text = await box.describe([item.id]);
    assert.match(text, /名前,値/);
    assert.match(text, /あ,1/);
    assert.match(text, /CP932 として読みました/);
    assert.doesNotMatch(text, /�/);
  });

  test('UTF-8 のときは、余計な但し書きを付けない（対）', async () => {
    const box = new Attachments(await tempDir('aas-att-'));
    const item = await box.add('list.csv', Buffer.from('名前,値\nあ,1\n', 'utf8'));
    assert.equal(item.encoding, 'utf-8');
    assert.doesNotMatch(await box.describe([item.id]), /CP932/);
  });
});
