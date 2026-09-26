/**
 * 画面へ渡したファイル（添付）の預かりで、受け取れない・取り違える・黙って落とす形を止める。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { rm, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
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

  test('**片づけで、消せなかった分を空けた量に数えない**', async () => {
    const dir = await tempDir('aas-att-');
    const a = new Attachments(dir);
    await mkdir(join(dir, 'sub'), { recursive: true });
    const freed = await a.sweep(0, Date.now() + 1000);
    assert.equal(freed, 0, '消せなかったフォルダを数えた');
    assert.ok((await readdir(dir)).includes('sub'));
  });
});
