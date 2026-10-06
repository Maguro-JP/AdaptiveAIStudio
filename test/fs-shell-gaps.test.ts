/**
 * ファイルのツールとコマンドの出力の不具合（68 回目の調査）。
 *
 * - 頭を落としたコマンドの出力が、字の途中から始まると丸ごと Shift_JIS として化けた
 * - 出力の末尾を切るとき、対になる文字の下半分を頭に残した
 * - UTF-16 で CRLF のファイルを write_file で書き直すと、LF になった
 * - 止めた・時間切れの検索を、全部見た結果として返した
 * - 絶対の道で渡すと、途中の .gitignore が効かなかった
 *
 * 読めないファイル・中を見られないフォルダの数え方は、root で走らせると権限が効かず、走らせる場所で結果が変わるので試験を書いていない
 * （確かめていない）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { decodeOutput, tailOf } from '../src/agent/shell-exec.ts';
import { writeFileTool, listFilesTool, searchText } from '../src/agent/tools/fs.ts';
import type { ToolContext } from '../src/agent/tools/types.ts';

const ctxOf = (root: string): ToolContext => ({
  root, signal: new AbortController().signal, approve: async () => true, beforeWrite: () => undefined,
});

describe('コマンドの出力', () => {
  test('**頭を落とした出力が字の途中から始まっても、utf8 として読む**', () => {
    const whole = '├─ src/a.ts\n'.repeat(10);
    const got = decodeOutput(Buffer.from(whole).subarray(1));
    assert.ok(whole.endsWith(got.slice(1)), `化けた: ${got.slice(0, 30)}`);
    assert.match(got, /src\/a\.ts/);
  });

  test('**末尾を切るとき、対になる文字の下半分を頭に残さない**', () => {
    const s = 'x'.repeat(10) + '😀' + 'y'.repeat(9);
    const got = tailOf(s, 10);
    assert.doesNotMatch(got, /[\uDC00-\uDFFF]/, '片割れが残った');
  });
});

describe('ファイルのツール', () => {
  test('**UTF-16 で CRLF のファイルを書き直しても、CRLF のまま**', async () => {
    const root = await tempDir('aas-fs-utf16-');
    const bom = Buffer.from([0xff, 0xfe]);
    await writeFile(join(root, 'a.ps1'), Buffer.concat([bom, Buffer.from('a\r\nb\r\n', 'utf16le')]));
    const r = await writeFileTool.run({ path: 'a.ps1', content: 'x\ny\n' }, ctxOf(root));
    assert.ok(!r.isError, r.content);
    const written = await readFile(join(root, 'a.ps1'));
    assert.ok(written.includes(Buffer.from('\r\n')), `LF で書いた: ${JSON.stringify(written.toString('latin1'))}`);
  });

  test('**止めた検索は、途中までだと言う**', async () => {
    const root = await tempDir('aas-fs-abort-');
    await writeFile(join(root, 'a.txt'), 'needle\n');
    const got = await searchText(root, 'needle', '.', AbortSignal.abort());
    assert.equal(got.aborted, true, '止めたのに、全部見た結果として返した');
  });

  test('**絶対の道で渡しても、途中の .gitignore を効かせる**', async () => {
    const root = await tempDir('aas-fs-ignore-');
    await mkdir(join(root, 'sub'), { recursive: true });
    await writeFile(join(root, 'sub', '.gitignore'), 'secret.txt\n');
    await writeFile(join(root, 'sub', 'secret.txt'), 'x');
    await writeFile(join(root, 'sub', 'open.txt'), 'x');
    const r = await listFilesTool.run({ path: join(root, 'sub') }, ctxOf(root));
    assert.match(r.content, /open\.txt/, r.content);
    assert.doesNotMatch(r.content, /secret\.txt/, '無視するファイルを並べた');
  });
});
