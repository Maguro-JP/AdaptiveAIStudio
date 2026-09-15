/** 記録をファイルにも残す。順番を守り、大きくなったら一つ前へ回す。 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { tempDir } from './tmp.ts';
import { LogFile, jstStamp } from '../src/core/logfile.ts';

describe('記録のファイル', () => {
  test('足した順に残り、末尾が読める。改行は字下げして一行に見せる', async () => {
    const dir = await tempDir('aas-log-');
    const log = new LogFile(join(dir, 'logs', 'ui.log'));
    await log.append('一つ目');
    await log.append('二つ目\n続き');
    await log.append('三つ目');
    const text = await readFile(log.path, 'utf8');
    assert.match(text, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} 一つ目\n/);
    assert.ok(text.includes('二つ目\n    続き\n'), text);
    assert.equal(await log.tail(2), text.trimEnd().split('\n').slice(-2).join('\n'));
  });
  test('大きくなったら一つ前へ回す。育て続けない', async () => {
    const dir = await tempDir('aas-log2-');
    const log = new LogFile(join(dir, 'ui.log'), { maxBytes: 200 });
    for (let i = 0; i < 30; i++) await log.append(`line ${i} ${'x'.repeat(20)}`);
    const size = (await stat(log.path)).size;
    assert.ok(size < 400, `回していない: ${size}`);
    assert.ok(await stat(`${log.path}.1`).then(() => true).catch(() => false), '一つ前が無い');
  });
  test('書けない場所でも投げない（記録のために本体を止めない）', async () => {
    // ファイルの下にフォルダは作れない（ENOTDIR / ENOENT）。
    const dir = await tempDir('aas-log3-');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'file'), 'x');
    const log = new LogFile(join(dir, 'file', 'logs', 'ui.log'));
    await log.append('x'); // 投げなければよい
    assert.equal(await log.tail(5), '');
  });
  test('時刻は JST', () => {
    assert.equal(jstStamp(new Date('2026-09-10T15:00:00Z')), '2026-09-11 00:00:00');
  });
});
