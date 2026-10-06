/**
 * 84 回目の不具合調査（ツールの残り）の分。
 *
 * - toText は実体参照を一度だけ解く（`&amp;lt;` は `&lt;` のまま）
 * - show_file は、無いファイル・フォルダを「開きました」と言わない
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { toText } from '../src/agent/tools/network.ts';
import { createShowFileTool } from '../src/agent/tools/show.ts';

describe('toText', () => {
  test('**実体参照を二度解かない**', () => {
    assert.equal(toText('<p>&amp;lt;div&amp;gt;</p>', 'text/html'), '&lt;div&gt;');
  });
  test('一度だけのものは、これまでどおり解く（対）', () => {
    assert.equal(toText('<p>&lt;div&gt; &amp; x</p>', 'text/html'), '<div> & x');
  });
});

describe('show_file', () => {
  test('**無いファイル・フォルダは開いたと言わず、画面へも送らない**', async () => {
    const root = await tempDir('aas-show-gaps-');
    await mkdir(join(root, 'dir'));
    const shown: string[] = [];
    const tool = createShowFileTool((at) => { shown.push(at.path); });
    const ctx = { root, signal: new AbortController().signal, approve: () => Promise.resolve(true) } as never;
    for (const path of ['nope.ts', 'dir']) {
      const r = await tool.run({ path }, ctx);
      assert.equal(r.isError, true, `${path} を開いたと言った: ${r.content}`);
    }
    assert.deepEqual(shown, []);
  });
  test('在るファイルは開く（対）', async () => {
    const root = await tempDir('aas-show-gaps-');
    await writeFile(join(root, 'a.ts'), 'x\n');
    const shown: string[] = [];
    const r = await createShowFileTool((at) => { shown.push(at.path); }).run({ path: 'a.ts' },
      { root, signal: new AbortController().signal, approve: () => Promise.resolve(true) } as never);
    assert.equal(r.isError, undefined, r.content);
    assert.deepEqual(shown, ['a.ts']);
  });
});
