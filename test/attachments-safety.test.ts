/**
 * 画面へ渡したファイル（添付）の預かりで、受け取れない・取り違える・黙って落とす形を止める。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { tempDir } from './tmp.ts';
import { Attachments, safeName, detectKind } from '../src/ui/attachments.ts';
import { decodeText } from '../src/core/text.ts';

describe('添付の預かり', () => {
  test('**全角の長い名前でも受け取れる（Linux・macOS の 255 バイトの上限）**', async () => {
    const a = new Attachments(await tempDir('aas-att-'));
    const item = await a.add(`${'あ'.repeat(100)}.txt`, Buffer.from('中身'));
    assert.equal(item.kind, 'text');
    assert.ok(Buffer.byteLength(item.name) <= 200, `名前が長すぎる: ${Buffer.byteLength(item.name)} バイト`);
  });

  test('**長い名前を切っても、拡張子を落とさない（絵を読めない形式と取り違えない）**', () => {
    const name = safeName(`${'screenshot_'.repeat(30)}.webp`);
    assert.ok(name.endsWith('.webp'), name);
    assert.equal(detectKind(name, Buffer.from('RIFF....WEBP')), 'image');
  });

  test('名前を切るとき、絵文字を半分に割らない', () => {
    // 一字ずらして、UTF-16 の単位で切ると割れる長さにする。
    const name = safeName(`a${'😀'.repeat(80)}.txt`);
    assert.doesNotMatch(name, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, name);
  });

  test('Windows で落ちる末尾の点と空白を外す', () => {
    assert.equal(safeName('a.txt. '), 'a.txt');
  });

  test('**預けたファイルが消えていたら、空の中身で渡さずに読めないと言う**', async () => {
    const a = new Attachments(await tempDir('aas-att-'));
    const item = await a.add('memo.txt', Buffer.from('メモ'));
    await rm(item.path);
    const text = await a.describe([item.id]);
    assert.match(text, /消えていて読めません/, text);
  });

  test('**UTF-16（メモ帳の Unicode・PowerShell 5.1 の出力）は、その文字コードで読む**', async () => {
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('こんにちは\r\n', 'utf16le')]);
    assert.equal(decodeText(le).text, 'こんにちは\r\n');
    assert.equal(decodeText(le).lossy, false);
    assert.equal(detectKind('noext', le), 'text', '拡張子の無い UTF-16 を二進と取り違えた');
    const a = new Attachments(await tempDir('aas-att-'));
    const item = await a.add('memo.txt', le);
    assert.match(await a.describe([item.id]), /こんにちは/);
  });

});

describe('添付の預かり（読み直しで挙がった形）', () => {
  test('ASCII の長い名前も 120 字で止める（Windows の道の長さ 260 字に当たりにくくする）', () => {
    const name = safeName(`${'a'.repeat(300)}.txt`);
    assert.ok(Array.from(name).length <= 120, `${Array.from(name).length} 字`);
    assert.ok(name.endsWith('.txt'));
  });

  test('切ったあとの末尾にも、点と空白を残さない', () => {
    const name = safeName('abc '.repeat(60));
    assert.doesNotMatch(name, /[. ]$/, JSON.stringify(name));
  });

  test('二重の拡張子（.tar.gz）は切っても残す', () => {
    assert.ok(safeName(`${'b'.repeat(300)}.tar.gz`).endsWith('.tar.gz'));
  });

  test('UTF-16BE も、その文字コードで読む', async () => {
    const be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('こんにちは', 'utf16le').swap16()]);
    assert.equal(decodeText(be).text, 'こんにちは');
    assert.equal(detectKind('noext', be), 'text');
  });

  test('UTF-16 として読めない（長さが奇数）なら、化けたと言う', () => {
    assert.equal(decodeText(Buffer.from([0xff, 0xfe, 0x41])).lossy, true);
  });

  test('FF FE で始まる二進（UTF-32LE・音声）を、文字ものと取り違えない', () => {
    const utf32 = Buffer.from([0xff, 0xfe, 0x00, 0x00, 0x41, 0x00, 0x00, 0x00, 0x42, 0x00, 0x00, 0x00]);
    assert.equal(detectKind('noext', utf32), 'binary');
  });

  test('**片づけで、消せなかったファイルを空けた量に数えず、一覧にも残す**', async () => {
    const dir = await tempDir('aas-att-');
    const a = new Attachments(dir, { remove: () => Promise.reject(Object.assign(new Error('busy'), { code: 'EBUSY' })) });
    const item = await a.add('memo.txt', Buffer.from('メモ'));
    const freed = await a.sweep(0, Date.now() + 1000);
    assert.equal(freed, 0, '消せなかった分を数えた');
    assert.ok(a.get(item.id), '消せなかったのに一覧から外した');
  });

  test('読めない理由が「無い」でなければ、消えたとは言わない', async () => {
    const dir = await tempDir('aas-att-');
    const a = new Attachments(dir, { read: () => Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' })) });
    const item = await a.add('memo.txt', Buffer.from('メモ'));
    const text = await a.describe([item.id]);
    assert.doesNotMatch(text, /消えて/, text);
    assert.match(text, /読めません（EACCES）/, text);
  });
});

describe('シェルの出力は UTF-16 として読まない', () => {
  test('stdout が UTF-16 の BOM で始まっても、後ろの utf8 の stderr を化けさせない', async () => {
    const { decodeOutput } = await import('../src/agent/shell-exec.ts');
    const raw = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('out\r\n', 'utf16le'), Buffer.from('エラー: 見つかりません')]);
    assert.match(decodeOutput(raw), /エラー: 見つかりません/);
  });
});
