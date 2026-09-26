/**
 * utf8 で読めないファイル（Shift_JIS の文書・二進）へ書くとき。
 *
 * 書くツールは中身を文字として読んでいた。Shift_JIS の文書に `edit_file` を当てると、
 * 直した一行のほかの日本語まで U+FFFD に化けて書き戻され、書く手前の記録も化けていたので
 * 「戻す」を押しても元に戻らなかった。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { editFileTool, writeFileTool } from '../src/agent/tools/fs.ts';
import { UndoStore } from '../src/core/undo.ts';
import type { ToolContext, ApprovalAnswer } from '../src/agent/tools/types.ts';

const sjis = Buffer.concat([Buffer.from('x = 1\n'), Buffer.from([0x82, 0xa0, 0x82, 0xa2, 0x0a])]);   // 「あい」
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80]);

async function place(): Promise<{ root: string; undo: UndoStore; ctx: (answer?: ApprovalAnswer) => ToolContext }> {
  const root = await tempDir('aas-write-non-utf8-');
  const undo = new UndoStore(root, join(await tempDir('aas-write-non-utf8-state-'), 'undo'));
  const ctx = (answer: ApprovalAnswer = true): ToolContext => ({
    root, signal: new AbortController().signal,
    approve: () => Promise.resolve(answer),
    beforeWrite: (path, previous) => undo.capture(path, previous),
  });
  return { root, undo, ctx };
}

describe('utf8 で読めないファイルへ書く', () => {
  test('edit_file は一部だけ書き換えず、何も書かずに断る（直していない行まで化けるため）', async () => {
    const { root, ctx } = await place();
    await writeFile(join(root, 'memo.txt'), sjis);
    const r = await editFileTool.run({ path: 'memo.txt', find: 'x = 1', replace: 'x = 2' }, ctx());
    assert.equal(r.isError, true, r.content);
    assert.match(r.content, /utf8 で読めない/);
    assert.deepEqual(await readFile(join(root, 'memo.txt')), sjis, '断ったのに書いている');
  });

  test('write_file で丸ごと置き換えたものは、「戻す」で元のバイト列に戻る', async () => {
    const { root, undo, ctx } = await place();
    await writeFile(join(root, 'memo.txt'), sjis);
    await writeFile(join(root, 'logo.png'), png);
    await undo.begin('置き換える');
    for (const path of ['memo.txt', 'logo.png']) {
      const r = await writeFileTool.run({ path, content: 'text\n' }, ctx());
      assert.equal(r.isError, undefined, r.content);
    }
    const point = await undo.end();
    assert.ok(point);
    await undo.restore(point.id);
    assert.deepEqual(await readFile(join(root, 'memo.txt')), sjis, 'Shift_JIS が化けて戻った');
    assert.deepEqual(await readFile(join(root, 'logo.png')), png, '二進が化けて戻った');
  });

  test('utf8 で読めないファイルは、塊を選んで一部だけ通すことはできない', async () => {
    const { root, ctx } = await place();
    await writeFile(join(root, 'logo.png'), png);
    const r = await writeFileTool.run({ path: 'logo.png', content: 'text\n' }, ctx({ hunks: [0] }));
    assert.equal(r.isError, true, r.content);
    assert.deepEqual(await readFile(join(root, 'logo.png')), png);
  });

  test('utf8 のファイルは今までどおり（記録は文字列、BOM も残る）', async () => {
    const { root, undo, ctx } = await place();
    const bom = '﻿@echo off\r\n';
    await writeFile(join(root, 'start.cmd'), bom, 'utf8');
    await undo.begin('直す');
    const r = await editFileTool.run({ path: 'start.cmd', find: '@echo off', replace: '@echo on' }, ctx());
    assert.equal(r.isError, undefined, r.content);
    assert.equal(await readFile(join(root, 'start.cmd'), 'utf8'), '﻿@echo on\r\n');
    const point = await undo.end();
    assert.ok(point);
    await undo.restore(point.id);
    assert.equal(await readFile(join(root, 'start.cmd'), 'utf8'), bom);
  });
});
