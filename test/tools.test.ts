import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { tempDir } from './tmp.ts';
import { join, resolve } from 'node:path';
import { readFileTool, listFilesTool, searchTextTool, writeFileTool, matchLineEndings } from '../src/agent/tools/fs.ts';
import { createRunCommandTool } from '../src/agent/tools/shell.ts';
import { safeResolve } from '../src/agent/tools/paths.ts';
import type { ToolContext } from '../src/agent/tools/types.ts';

async function workspace(): Promise<string> {
  const root = await tempDir('aas-');
  await writeFile(join(root, 'app.ts'), 'export const answer = 41;\nconsole.log(answer);\n');
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await writeFile(join(root, 'node_modules', 'junk.js'), 'noise');
  return root;
}

function ctx(root: string, approve: ToolContext['approve'] = async () => true): ToolContext {
  return { root, signal: new AbortController().signal, approve };
}

describe('パス封じ込め', () => {
  test('作業ディレクトリの外は解決できない', () => {
    assert.equal(safeResolve('/work', '../etc/passwd'), undefined);
    assert.equal(safeResolve('/work', 'a/../../b'), undefined);
    assert.equal(safeResolve('/work', '/etc/passwd'), undefined);
  });
  test('内側は解決できる', () => {
    // 期待値を '/work/src/a.ts' と直書きすると Windows で落ちる。
    // resolve が返すのは 'C:\\work\\src\\a.ts' で、区切り文字も接頭辞も環境のものになる。
    // 確かめたいのは「根の下に繋がること」なので、期待値も環境の作法で組み立てる。
    const root = resolve('/work');
    assert.equal(safeResolve(root, 'src/a.ts'), join(root, 'src', 'a.ts'));
  });
  test('read_file は外部パスを拒否する', async () => {
    const root = await workspace();
    const r = await readFileTool.run({ path: '../../etc/passwd' }, ctx(root));
    assert.equal(r.isError, true);
    assert.match(r.content, /作業ディレクトリの外/);
  });
});

describe('ファイルツール', () => {
  test('read_file は行番号つきで返す', async () => {
    const root = await workspace();
    const r = await readFileTool.run({ path: 'app.ts' }, ctx(root));
    assert.match(r.content, /^1\texport const answer = 41;/);
  });

  test('list_files は node_modules を除外する', async () => {
    const root = await workspace();
    const r = await listFilesTool.run({}, ctx(root));
    assert.match(r.content, /app\.ts/);
    assert.doesNotMatch(r.content, /junk\.js/);
  });

  test('search_text は該当行を位置つきで返す', async () => {
    const root = await workspace();
    const r = await searchTextTool.run({ query: 'answer' }, ctx(root));
    assert.match(r.content, /app\.ts:1:/);
  });

  test('write_file は承認されれば書き込む', async () => {
    const root = await workspace();
    const r = await writeFileTool.run(
      { path: 'app.ts', content: 'export const answer = 42;\n' }, ctx(root));
    assert.equal(r.isError, undefined);
    assert.equal(await readFile(join(root, 'app.ts'), 'utf8'), 'export const answer = 42;\n');
  });

  test('write_file は拒否されれば書き込まない', async () => {
    const root = await workspace();
    const before = await readFile(join(root, 'app.ts'), 'utf8');
    const r = await writeFileTool.run(
      { path: 'app.ts', content: 'destroyed' }, ctx(root, async () => false));
    assert.equal(r.isError, true);
    assert.equal(await readFile(join(root, 'app.ts'), 'utf8'), before);
  });

  test('write_file の承認要求には差分が含まれる', async () => {
    const root = await workspace();
    let seen = '';
    await writeFileTool.run({ path: 'app.ts', content: 'export const answer = 42;\n' },
      ctx(root, async (req) => { if (req.kind === 'write') seen = req.diff; return false; }));
    assert.match(seen, /-export const answer = 41;/);
    assert.match(seen, /\+export const answer = 42;/);
  });

  test('内容が同じなら承認を求めない', async () => {
    const root = await workspace();
    let asked = false;
    const r = await writeFileTool.run(
      { path: 'app.ts', content: 'export const answer = 41;\nconsole.log(answer);\n' },
      ctx(root, async () => { asked = true; return true; }));
    assert.equal(asked, false);
    assert.match(r.content, /変更なし/);
  });
});

describe('コマンド実行', () => {
  const tool = createRunCommandTool({ allowed: ['echo', 'node'], timeoutMs: 10_000 });

  test('許可されたコマンドは実行できる', async () => {
    const root = await workspace();
    const r = await tool.run({ command: 'echo hello' }, ctx(root));
    assert.match(r.content, /hello/);
    assert.match(r.content, /終了コード: 0/);
  });

  test('許可外のコマンドは実行しない', async () => {
    const root = await workspace();
    const r = await tool.run({ command: 'curl http://example.com' }, ctx(root));
    assert.equal(r.isError, true);
    assert.match(r.content, /許可されていない/);
  });

  test('危険な形は許可リストを通っても弾く', async () => {
    const root = await workspace();
    const danger = createRunCommandTool({ allowed: ['rm'] });
    const r = await danger.run({ command: 'rm -rf /' }, ctx(root));
    assert.equal(r.isError, true);
    assert.match(r.content, /危険と判断/);
  });

  test('拒否されれば実行しない', async () => {
    const root = await workspace();
    const r = await tool.run({ command: 'echo nope' }, ctx(root, async () => false));
    assert.equal(r.isError, true);
    assert.doesNotMatch(r.content, /終了コード/);
  });

  test('失敗した終了コードは isError になる', async () => {
    const root = await workspace();
    const r = await tool.run({ command: 'node -e "process.exit(3)"' }, ctx(root));
    assert.equal(r.isError, true);
    assert.match(r.content, /終了コード: 3/);
  });
});

/**
 * 改行の引き継ぎ。
 *
 * Windows で取ってきた木は CRLF のことがある。
 * モデルは LF で書き戻すので、そのまま書くと
 * 1行も直していないのにファイル全体が変更扱いになる。
 * 差分を見て承認する仕組みなので、ここが崩れると承認の意味が消える。
 */
describe('改行の引き継ぎ', () => {
  test('元が CRLF なら CRLF で書き戻す', () => {
    const before = 'a\r\nb\r\nc\r\n';
    assert.equal(matchLineEndings('a\nB\nc\n', before), 'a\r\nB\r\nc\r\n');
  });

  test('元が LF なら LF のまま', () => {
    assert.equal(matchLineEndings('a\nB\n', 'a\nb\n'), 'a\nB\n');
  });

  test('新規のファイルは、渡されたまま', () => {
    assert.equal(matchLineEndings('a\nb\n', ''), 'a\nb\n');
  });

  test('混ざっていれば多い方に寄せる', () => {
    assert.equal(matchLineEndings('x\ny\n', 'a\r\nb\r\nc\n'), 'x\r\ny\r\n');
    assert.equal(matchLineEndings('x\ny\n', 'a\nb\nc\r\n'), 'x\ny\n');
  });

  test('CRLF を渡されても、二重にはしない', () => {
    assert.equal(matchLineEndings('a\r\nb\r\n', 'x\r\n'), 'a\r\nb\r\n');
  });

  test('CRLF のファイルに書いても「全行変更」にならない', async () => {
    const root = await tempDir('aas-crlf-');
    await writeFile(join(root, 'w.txt'), 'a\r\nb\r\nc\r\n');

    // 中身は同じで改行だけ LF にして渡す = 何も変えていないのと同じ
    const same = await writeFileTool.run(
      { path: 'w.txt', content: 'a\nb\nc\n' }, ctx(root));
    assert.match(same.content, /変更なし/, `全行変更として扱われている: ${same.content}`);

    // 1行だけ直したときは、その1行だけが変わる
    const one = await writeFileTool.run(
      { path: 'w.txt', content: 'a\nB\nc\n' }, ctx(root));
    assert.equal(one.isError, undefined, one.content);
    assert.equal(await readFile(join(root, 'w.txt'), 'utf8'), 'a\r\nB\r\nc\r\n',
      '改行が LF に置き換わっている');
    assert.match(one.content, /\+1/, `1行だけの変更になっていない: ${one.content}`);
  });
});
