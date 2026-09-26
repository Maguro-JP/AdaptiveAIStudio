/**
 * utf8 で読めないファイルを read_file で読ませたとき。
 *
 * 化けた字（U+FFFD）のまま渡すと、モデルはそれを中身だと思って直しにかかる。読めないものは
 * 「読めない」と言う（CLAUDE.md の「渡す」と同じ線）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { readFileTool, writeFileTool } from '../src/agent/tools/fs.ts';
import { Harness } from '../src/harness/harness.ts';
import { readBeforeWrite } from '../src/harness/builtin-rules.ts';
import type { ToolContext } from '../src/agent/tools/types.ts';

const ctx = (root: string): ToolContext => ({
  root, signal: new AbortController().signal, approve: () => Promise.resolve(true as const),
});

describe('utf8 で読めないファイルを読む', () => {
  test('二進（NUL を含む）は中身を渡さず、読めないと言う', async () => {
    const root = await tempDir('aas-read-bin-');
    await writeFile(join(root, 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0x61]));
    const r = await readFileTool.run({ path: 'a.png' }, ctx(root));
    assert.equal(r.isError, true, `読めたことにした: ${r.content}`);
    assert.doesNotMatch(r.content, /�/, '化けた字を渡した');
    assert.match(r.content, /utf8 で読めません/);
    assert.match(r.content, /11 バイト/, '大きさを言っていない');
  });

  test('別の文字コード（Shift_JIS）も、化けた字で渡さない', async () => {
    const root = await tempDir('aas-read-sjis-');
    await writeFile(join(root, 'sjis.txt'), Buffer.from([0x82, 0xa0, 0x82, 0xa2, 0x0a]));
    const r = await readFileTool.run({ path: 'sjis.txt' }, ctx(root));
    assert.equal(r.isError, true, `読めたことにした: ${r.content}`);
    assert.doesNotMatch(r.content, /�/, '化けた字を渡した');
  });

  test('utf8 の文字（BOM つきも）は、これまでどおり行番号つきで読める', async () => {
    const root = await tempDir('aas-read-utf8-');
    await writeFile(join(root, 'a.txt'), '﻿あ\nい\n');
    const r = await readFileTool.run({ path: 'a.txt' }, ctx(root));
    assert.equal(r.isError, undefined, r.content);
    assert.equal(r.content, '1\t﻿あ\n2\tい\n3\t');
  });

  test('読めないと言われたあとも、読んでから書く規則は全文の置き換えを通す（Shift_JIS を utf8 に書き直す道）', async () => {
    const root = await tempDir('aas-read-then-write-');
    await writeFile(join(root, 'sjis.txt'), Buffer.from([0x82, 0xa0, 0x0a]));
    const harness = new Harness({ rules: [readBeforeWrite] });
    const [read, write] = harness.wrapAll([readFileTool, writeFileTool], () => '');
    assert.equal((await read!.run({ path: 'sjis.txt' }, ctx(root))).isError, true, '前提: 読めてしまった');
    const w = await write!.run({ path: 'sjis.txt', content: 'あ\n' }, ctx(root));
    assert.doesNotMatch(w.content, /BLOCKED/, `読んだのに止められた: ${w.content}`);
  });
});
