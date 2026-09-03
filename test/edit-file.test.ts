/**
 * ファイルの一部だけを差し替える。
 *
 * **これが無いと、ローカルの小さいモデルではコーディングが成り立たない。**
 * `write_file` は全文渡し。300行のファイルを1行直すために、300行を
 * そっくり書き戻させることになる。4B の窓（8192）では出力だけで溢れるし、
 * 溢れなくても途中で崩れて、**直していないところを壊す**。
 *
 * そして、**足すこと自体が危ない**。守りはどれも `name === 'write_file'`
 * と名前を直に見ていた（18箇所）。書き換える道具をもう一つ足した瞬間、
 * その全部をすり抜ける口になる。ここでは、すり抜けないことを見る。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { editFileTool } from '../src/agent/tools/fs.ts';
import { isWriteTool, applyEdit, plannedContent } from '../src/agent/tools/write-kind.ts';
import { protectedPaths, readBeforeWrite, testProtection } from '../src/harness/builtin-rules.ts';
import type { ToolContext } from '../src/agent/tools/types.ts';

async function ctxAt(root: string, approve = true): Promise<ToolContext> {
  return { root, signal: new AbortController().signal, approve: () => Promise.resolve(approve) };
}

async function fixture(body: string, name = 'a.ts'): Promise<{ root: string; path: string }> {
  const root = await tempDir('aas-edit-');
  await writeFile(join(root, name), body);
  return { root, path: name };
}

describe('一部だけ差し替える', () => {
  test('当たった一箇所だけ変わる。ほかは触らない', async () => {
    const { root, path } = await fixture('const a = 1;\nconst b = 2;\nconst c = 3;\n');
    const r = await editFileTool.run(
      { path, find: 'const b = 2;', replace: 'const b = 99;' }, await ctxAt(root),
    );
    assert.equal(r.isError, undefined, r.content);
    assert.equal(await readFile(join(root, path), 'utf8'), 'const a = 1;\nconst b = 99;\nconst c = 3;\n');
  });

  test('見つからないなら、そう言う。黙って何もしない、をしない', async () => {
    const { root, path } = await fixture('const a = 1;\n');
    const r = await editFileTool.run(
      { path, find: 'const z = 9;', replace: 'x' }, await ctxAt(root),
    );
    assert.equal(r.isError, true);
    assert.match(r.content, /見つかりません/);
    // 読み直せ、と言うところまで。言わないと、同じことを何度も試す。
    assert.match(r.content, /read_file/);
  });

  test('何箇所にも当てはまるなら、止めて数を言う', async () => {
    // 一箇所のつもりが十箇所変わっていた、が起きる。小さいモデルは
    // 短い断片を渡してくるので、これは実際に起きる形。
    const { root, path } = await fixture('a();\nb();\na();\n');
    const r = await editFileTool.run({ path, find: 'a();', replace: 'z();' }, await ctxAt(root));
    assert.equal(r.isError, true);
    assert.match(r.content, /2 箇所/);
    assert.equal(await readFile(join(root, path), 'utf8'), 'a();\nb();\na();\n', '止めたのに書いている');
  });

  test('全部でよいなら、all で通す（対）', async () => {
    const { root, path } = await fixture('a();\nb();\na();\n');
    const r = await editFileTool.run(
      { path, find: 'a();', replace: 'z();', all: true }, await ctxAt(root),
    );
    assert.equal(r.isError, undefined, r.content);
    assert.equal(await readFile(join(root, path), 'utf8'), 'z();\nb();\nz();\n');
  });

  test('CRLF のファイルでも一致する', async () => {
    // モデルは LF で書いてくる。中身が CRLF だと、そのままでは一致しない。
    // 「無い」と言われて、モデルは同じことを何度も試すことになる。
    const { root, path } = await fixture('const a = 1;\r\nconst b = 2;\r\n');
    const r = await editFileTool.run(
      { path, find: 'const b = 2;', replace: 'const b = 99;' }, await ctxAt(root),
    );
    assert.equal(r.isError, undefined, r.content);
    const after = await readFile(join(root, path), 'utf8');
    assert.ok(after.includes('const b = 99;'), after);
    // 元の改行のまま返すこと。潰すと1行も直していないのに全行が変更扱いになる。
    assert.ok(after.includes('\r\n'), '改行を潰している');
  });

  test('無いファイルには、作り方を教える', async () => {
    const root = await tempDir('aas-edit-none-');
    const r = await editFileTool.run({ path: 'x.ts', find: 'a', replace: 'b' }, await ctxAt(root));
    assert.equal(r.isError, true);
    assert.match(r.content, /write_file/);
  });

  test('作業場の外へは出さない', async () => {
    const { root } = await fixture('x');
    const r = await editFileTool.run({ path: '../外.ts', find: 'a', replace: 'b' }, await ctxAt(root));
    assert.equal(r.isError, true);
    assert.match(r.content, /作業ディレクトリの外/);
  });

  test('承認しなければ、書かない', async () => {
    const { root, path } = await fixture('const a = 1;\n');
    const r = await editFileTool.run(
      { path, find: 'const a = 1;', replace: 'const a = 2;' }, await ctxAt(root, false),
    );
    assert.equal(r.isError, true);
    assert.equal(await readFile(join(root, path), 'utf8'), 'const a = 1;\n');
  });
});

describe('守りをすり抜けさせない', () => {
  test('書き換える道具として数える', () => {
    assert.equal(isWriteTool('edit_file'), true);
    assert.equal(isWriteTool('write_file'), true);
    assert.equal(isWriteTool('read_file'), false);
  });

  test('守られた場所は、部分置換でも守る', async () => {
    const { root } = await fixture('SECRET=1\n', '.env');
    const rule = protectedPaths(['.env']);
    const r = await rule.pre!(
      { id: '1', name: 'edit_file', args: { path: '.env', find: 'SECRET=1', replace: 'SECRET=2' } },
      { root, history: [], instruction: '' } as never,
    );
    assert.equal(r.kind, 'deny', `.env を部分置換で書き換えられてしまう: ${JSON.stringify(r)}`);
  });

  test('読まずに書くのも、部分置換で止める', async () => {
    const { root, path } = await fixture('const a = 1;\n');
    const r = await readBeforeWrite.pre!(
      { id: '1', name: 'edit_file', args: { path, find: 'a', replace: 'b' } },
      { root, history: [], instruction: '' } as never,
    );
    assert.equal(r.kind, 'deny', `読まずに部分置換できてしまう: ${JSON.stringify(r)}`);
  });

  test('テストを消すのも、部分置換で止める', async () => {
    // **ここがいちばん危ない。**引数に「後の姿」が無いので、
    // 引数だけ見る守りは素通りさせる。当ててから見ること。
    const root = await tempDir('aas-edit-t-');
    await mkdir(join(root, 'test'), { recursive: true });
    const body = "test('あ', () => {});\ntest('い', () => {});\n";
    await writeFile(join(root, 'test', 'x.test.ts'), body);
    const r = await testProtection.pre!(
      {
        id: '1', name: 'edit_file',
        args: { path: 'test/x.test.ts', find: "test('い', () => {});\n", replace: '' },
      },
      { root, history: [], instruction: '' } as never,
    );
    assert.equal(r.kind, 'deny', `テストを部分置換で消せてしまう: ${JSON.stringify(r)}`);
  });

  test('当てた後の姿を、守りに渡せる', async () => {
    const { root, path } = await fixture('a\nb\n');
    const after = await plannedContent('edit_file', { path, find: 'b', replace: 'c' }, root);
    assert.equal(after, 'a\nc\n');
    // write_file はそのまま。
    assert.equal(await plannedContent('write_file', { path, content: 'x' }, root), 'x');
  });
});

describe('当てる部分だけを、単体で見る', () => {
  test('数を返す。返さないと、多重に当たったのを止められない', () => {
    assert.deepEqual(applyEdit('aXaXa', 'X', 'Y', false), { text: 'aXaXa', hits: 2 });
    assert.deepEqual(applyEdit('aXaXa', 'X', 'Y', true), { text: 'aYaYa', hits: 2 });
    assert.deepEqual(applyEdit('aXa', 'X', 'Y', false), { text: 'aYa', hits: 1 });
    assert.deepEqual(applyEdit('aaa', 'X', 'Y', false), { text: 'aaa', hits: 0 });
  });

  test('置き換える先に find と同じ文字が入っていても、増殖しない', () => {
    // `a` を `aa` にするような形。素朴に回すと無限に増える。
    assert.deepEqual(applyEdit('a b a', 'a', 'aa', true), { text: 'aa b aa', hits: 2 });
  });

  test('空の find は何もしない', () => {
    assert.deepEqual(applyEdit('abc', '', 'x', true), { text: 'abc', hits: 0 });
  });
});
