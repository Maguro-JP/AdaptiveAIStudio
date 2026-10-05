/**
 * ファイルを扱うツールの不具合（37 回目の調査）。
 *
 * - 長いファイルの一行の直しを、承認の差分で「全部消して全部足す」に見せない
 * - FIFO へ書くツールが、書き手を待って止まらない
 * - utf8 でないバッチファイルを書き直すとき、BOM を付ける（無いと cmd.exe が CP932 として読む）
 * - 画面へ送っただけの書き換えを「書き換えました」と言わない
 * - 深さの上限で見るのをやめたことを言う
 * - 緩い当て・両端の当てで、重なった当たりを二度当てない
 * - 終わりの改行の後ろに、無い行を数えない
 * - 長い行の当たりを、見せる 200 字の外へ落とさない
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir, open } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { unifiedDiff, diffStat } from '../src/agent/diff.ts';
import { applyEdit } from '../src/agent/tools/write-kind.ts';
import { readPrior } from '../src/harness/put-back.ts';
import { writeFileTool, editFileTool, readFileTool, listFilesTool, searchText, searchTextTool } from '../src/agent/tools/fs.ts';
import { createReplaceSelectionTool } from '../src/agent/tools/patch.ts';
import type { ToolContext } from '../src/agent/tools/types.ts';

function ctx(root: string): ToolContext {
  return { root, signal: new AbortController().signal, approve: async () => true };
}

describe('長いファイルの差分', () => {
  test('**2,100 行のうち一行だけ直したら、差分も一行の出入りになる**', () => {
    const before = Array.from({ length: 2100 }, (_, i) => `line ${i}`).join('\n') + '\n';
    const after = before.replace('line 1000\n', 'line 1000 changed\n');
    const diff = unifiedDiff('big.txt', before, after);
    assert.deepEqual(diffStat(diff), { added: 1, removed: 1 });
    assert.match(diff, /@@ -998,7 \+998,7 @@/);
  });

  test('前後の同じ行を外しても、真ん中が大きすぎるときは全部の入れ替えとして出す', () => {
    const before = Array.from({ length: 2100 }, (_, i) => `a ${i}`).join('\n');
    const after = Array.from({ length: 2100 }, (_, i) => `b ${i}`).join('\n');
    assert.deepEqual(diffStat(unifiedDiff('big.txt', before, after)), { added: 2100, removed: 2100 });
  });
});

describe('FIFO', { skip: process.platform === 'win32' ? 'Windows には mkfifo が無い' : false }, () => {
  /** 待ちで止まったときだけ、読み手を放す（書き手として開いて閉じる）。止まっていないときに開くと、こちらが読み手を待つ。 */
  async function release(path: string): Promise<void> {
    const h = await open(path, 'w'); await h.close();
  }

  async function within<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
    let timer: NodeJS.Timeout | undefined;
    const t = new Promise<'timeout'>((r) => { timer = setTimeout(() => r('timeout'), ms); });
    try { return await Promise.race([p, t]); } finally { clearTimeout(timer); }
  }

  for (const [name, call] of [
    ['edit_file', (root: string) => editFileTool.run({ path: 'x', find: 'a', replace: 'b' }, ctx(root))],
    ['write_file', (root: string) => writeFileTool.run({ path: 'x', content: 'b' }, ctx(root))],
  ] as const) {
    test(`**${name} は FIFO で書き手を待たずに断る**`, async () => {
      const root = await tempDir('aas-ftg-fifo-');
      execFileSync('mkfifo', [join(root, 'x')]);
      const got = await within(call(root), 2000);
      if (got === 'timeout') await release(join(root, 'x'));
      assert.notEqual(got, 'timeout', 'FIFO の書き手を待って止まった');
      if (got === 'timeout') return;
      assert.equal(got.isError, true, got.content);
      assert.match(got.content, /普通のファイルではありません/);
    });
  }

  test('readPrior は普通のファイルでないものを読まずに投げる（無いときだけ undefined）', async () => {
    const root = await tempDir('aas-ftg-prior-');
    execFileSync('mkfifo', [join(root, 'x')]);
    await mkdir(join(root, 'd'));
    await assert.rejects(readPrior(join(root, 'x')), { code: 'ENOTFILE' });
    await assert.rejects(readPrior(join(root, 'd')), { code: 'ENOTFILE' });
    assert.equal(await readPrior(join(root, 'none')), undefined);
  });
});

describe('バッチファイルの BOM', () => {
  // Shift_JIS の「日本語」
  const sjis = Buffer.from([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]);

  test('**Shift_JIS の .bat を utf8 の全文で書き直すと、BOM が付く**', async () => {
    const root = await tempDir('aas-ftg-bat-');
    await writeFile(join(root, 'setup.bat'), Buffer.concat([Buffer.from('@echo off\r\necho '), sjis, Buffer.from('\r\n')]));
    const r = await writeFileTool.run({ path: 'setup.bat', content: '@echo off\necho 日本語\n' }, ctx(root));
    assert.notEqual(r.isError, true, r.content);
    const bytes = await readFile(join(root, 'setup.bat'));
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM が無いと cmd.exe が CP932 として読む');
    assert.equal(bytes.subarray(3).toString('utf8'), '@echo off\r\necho 日本語\r\n');
  });

  test('**新しく作る .cmd に日本語があれば BOM を付ける。ASCII だけなら付けない**', async () => {
    const root = await tempDir('aas-ftg-cmd-');
    await writeFileTool.run({ path: 'a.cmd', content: 'echo 日本語\n' }, ctx(root));
    await writeFileTool.run({ path: 'b.cmd', content: 'echo hi\n' }, ctx(root));
    assert.equal((await readFile(join(root, 'a.cmd'), 'utf8')).startsWith('﻿'), true);
    assert.equal((await readFile(join(root, 'b.cmd'), 'utf8')).startsWith('﻿'), false);
  });

  test('バッチファイルでないもの、元から BOM の無い utf8 のバッチファイルには付けない', async () => {
    const root = await tempDir('aas-ftg-txt-');
    await writeFile(join(root, 'a.txt'), Buffer.concat([sjis, Buffer.from('\n')]));
    await writeFile(join(root, 'c.bat'), 'echo 前から\n');
    await writeFileTool.run({ path: 'a.txt', content: '日本語\n' }, ctx(root));
    await writeFileTool.run({ path: 'c.bat', content: 'echo 日本語\n' }, ctx(root));
    assert.equal((await readFile(join(root, 'a.txt'), 'utf8')).startsWith('﻿'), false);
    assert.equal((await readFile(join(root, 'c.bat'), 'utf8')).startsWith('﻿'), false);
  });
});

describe('replace_selection', () => {
  test('**画面へ送っただけで「書き換えました」と言わない**', async () => {
    const root = await tempDir('aas-ftg-patch-');
    await writeFile(join(root, 'a.ts'), 'x\n');
    const tool = createReplaceSelectionTool(() => ({ path: 'a.ts', from: 1, to: 1, text: 'x' }), () => {});
    const r = await tool.run({ text: 'y' }, ctx(root));
    assert.notEqual(r.isError, true, r.content);
    assert.doesNotMatch(r.content, /書き換えました/);
    assert.match(r.content, /送りました/);
    assert.match(r.content, /当たったかは/);
  });
});

describe('深さの上限', () => {
  async function deep(): Promise<string> {
    const root = await tempDir('aas-ftg-deep-');
    const dir = join(root, ...Array.from({ length: 15 }, (_, i) => `d${i}`));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'bottom.txt'), 'needle\n');
    await writeFile(join(root, 'top.txt'), 'needle\n');
    return root;
  }

  test('**list_files は深すぎて見ていない所があると言う**', async () => {
    const root = await deep();
    const r = await listFilesTool.run({}, ctx(root));
    assert.match(r.content, /top\.txt/);
    assert.match(r.content, /深い所/);
  });

  test('**search_text も深すぎて見ていない所があると言う**', async () => {
    const root = await deep();
    const r = await searchTextTool.run({ query: 'needle' }, ctx(root));
    assert.match(r.content, /top\.txt/);
    assert.match(r.content, /深い所/);
  });
});

describe('重なった当たり', () => {
  test('**緩い当てで all のとき、重なった所を二度当てて行を消さない**', () => {
    const got = applyEdit('a\n}\n}\n}\n', ' }\n }', '}', true);
    assert.equal(got.text, 'a\n}\n}\n');
    assert.equal(got.hits, 1);
  });

  test('**両端の当てで all のとき、重なった所を二度当てない**', () => {
    const got = applyEdit('{\na\n{\nb\n}\n}', '{\na\nb\n}', 'R', true);
    assert.equal(got.text, 'R\n}');
  });

  test('all でないときは、重なった当たりも数えて「何箇所にも当たる」と返す（どこを指したか決めない）', () => {
    const got = applyEdit('a\n}\n}\n}\n', ' }\n }', '}', false);
    assert.equal(got.hits, 2);
    assert.equal(got.text, 'a\n}\n}\n}\n');
  });
});

describe('read_file の行の数え方', () => {
  test('**終わりの改行の後ろに、無い行を数えない**', async () => {
    const root = await tempDir('aas-ftg-lines-');
    await writeFile(join(root, 'a.txt'), 'a\nb\n');
    const r = await readFileTool.run({ path: 'a.txt' }, ctx(root));
    assert.doesNotMatch(r.content, /^3\t/m);
    const over = await readFileTool.run({ path: 'a.txt', offset: 3 }, ctx(root));
    assert.equal(over.isError, true, over.content);
    assert.match(over.content, /2 行しかありません/);
  });

  test('空のファイルと、改行だけのファイルは一行として読める', async () => {
    const root = await tempDir('aas-ftg-empty-');
    await writeFile(join(root, 'e.txt'), '');
    await writeFile(join(root, 'n.txt'), '\n');
    for (const p of ['e.txt', 'n.txt']) {
      const r = await readFileTool.run({ path: p }, ctx(root));
      assert.notEqual(r.isError, true, r.content);
      assert.match(r.content, /^1\t$/m);
    }
  });
});

describe('search_text の見せ方', () => {
  test('**200 字より後ろにある当たりも、見せる文に入る**', async () => {
    const root = await tempDir('aas-ftg-long-');
    await writeFile(join(root, 'min.js'), `${'x'.repeat(500)}needle${'y'.repeat(500)}\n`);
    const found = await searchText(root, 'needle', '.', new AbortController().signal);
    assert.equal(found.hits.length, 1);
    assert.match(found.hits[0]!.text, /needle/);
    assert.ok(found.hits[0]!.text.length <= 202, `長さ ${found.hits[0]!.text.length}`);
  });

  test('**. で始まる所を見ないことを、説明に書いておく**', () => {
    assert.match(searchTextTool.schema.description, /\. で始まる/);
    assert.match(listFilesTool.schema.description, /\. で始まる/);
  });
});
