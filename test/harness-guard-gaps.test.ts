/**
 * 守りと戻し方の不具合（69 回目の調査）。
 *
 * - 外のツール（MCP）へ渡す引数を JSON のまま検問にかけ、行の頭で当てる型（設定ファイルの中身）が一度も当たらなかった
 * - 書けなかった書き込みの手前に取った記録が残り、その後に人が直した分を、後で書いて打ち切ったときの巻き戻しが消した
 * - MCP の検問所とinspector の組み立てが、協議の要る一覧に無かった
 *
 * 大文字小文字の見分けを作業場の中の名前で確かめるようにした件は、Linux では親と中の区別が揃っていて見分けられないので、試験を書いて
 * いない（Windows・macOS の実機では確かめていない）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { wrapTool } from '../src/mcp/tools.ts';
import type { McpClient } from '../src/mcp/client.ts';
import type { ToolContext } from '../src/agent/tools/types.ts';
import { Checkpoint } from '../src/harness/checkpoint.ts';
import { isGuarded } from '../src/harness/deliberation.ts';

const ctx: ToolContext = { root: process.cwd(), signal: new AbortController().signal, approve: async () => true };

describe('外のツールへ渡す引数', () => {
  test('**文字列の中の設定の行も、検問で止める**', async () => {
    let called = false;
    const fake = { name: 'srv', call: async () => { called = true; return { text: 'ok', isError: false }; } } as unknown as McpClient;
    const r = await wrapTool(fake, { name: 'post' }).run(
      { text: 'メモ\naws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n' }, ctx,
    );
    assert.equal(r.isError, true, `外へ出した: ${r.content}`);
    assert.equal(called, false, '外のツールを呼んだ');
  });
});

describe('打ち切ったときの巻き戻し', () => {
  test('**書けなかった道の記録を捨てると、後で書いた時点の中身へ戻す**', async () => {
    const root = await tempDir('aas-checkpoint-forget-');
    await writeFile(join(root, 'a.ts'), 'A0');
    const cp = new Checkpoint(root);
    await cp.capture('a.ts');          // 書く手前（この書き込みは断られた）
    cp.forget('a.ts');
    await writeFile(join(root, 'a.ts'), 'A1');   // 人が直した
    await cp.capture('a.ts');          // 二度目の書く手前
    await writeFile(join(root, 'a.ts'), 'A2');   // 書いた
    await cp.restoreAll(['a.ts']);
    assert.equal(await readFile(join(root, 'a.ts'), 'utf8'), 'A1', '人の直しを、回の初めの中身で消した');
  });
});

describe('協議の要る一覧', () => {
  test('**MCP の検問所とinspector の組み立ても守る**', () => {
    assert.equal(isGuarded('src/mcp/tools.ts'), true);
    assert.equal(isGuarded('src/core/inspector-setup.ts'), true);
  });
});
