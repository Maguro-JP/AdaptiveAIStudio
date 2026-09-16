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

  /**
   * **入るだけ読んで、続きから読めば、最後まで読める。**
   *
   * `read_file` はコンテキストウィンドウに入る分で切っていたが、切ったあとの
   * 案内は「search_text か find_code で絞ってください」だけだった。
   * **続きを読む道が無い。**既定の 8192 では 130 行ほどで切れるので、
   * それより下に在るものは一行も読めなかった（当たる言葉を知っていれば
   * search_text で覗けるが、知らないから読もうとしている）。
   *
   * ここで見るのは、案内に出た `offset` で**本当に続きが取れること**。
   * 番号が一つずれるだけで、行が消えるか二重になる。
   */
  describe('長いファイルを、続きから読む', () => {
    const lines = 400;
    const many = async (): Promise<string> => {
      const root = await tempDir('aas-long-');
      await writeFile(join(root, 'long.txt'),
        Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join('\n'));
      return root;
    };
    /** 狭いコンテキストウィンドウ。何度か読まないと最後まで行かない。 */
    const narrow = (root: string): ToolContext => ({ ...ctx(root), contextTokens: 2048 });

    test('**何度か読めば、一行も落とさずに最後まで読める**', async () => {
      const root = await many();
      const seen: string[] = [];
      let offset = 1;
      for (let round = 0; round < 20; round += 1) {
        const r = await readFileTool.run({ path: 'long.txt', offset }, narrow(root));
        assert.equal(r.isError, undefined, r.content);
        const body = r.content.split('\n').filter((l) => /^\d+\t/.test(l));
        for (const l of body) seen.push(l);
        const more = /続きは offset=(\d+) で読めます/.exec(r.content);
        if (!more) break;
        const next = Number(more[1]);
        assert.ok(next > offset, `進んでいません: ${offset} → ${next}`);
        offset = next;
      }
      assert.equal(seen.length, lines, `読めた行数が違います: ${seen.length}`);
      assert.equal(seen[0], '1\tline 1');
      assert.equal(seen[lines - 1], `${lines}\tline ${lines}`);
      // 番号は飛ばず、重ならない。
      for (let i = 0; i < lines; i += 1) {
        assert.equal(seen[i], `${i + 1}\tline ${i + 1}`, `${i + 1} 行目がずれています`);
      }
    });

    test('**番号は、切り出した中ではなくファイルの中の番号**', async () => {
      const root = await many();
      const r = await readFileTool.run({ path: 'long.txt', offset: 200, limit: 2 }, ctx(root));
      assert.equal(r.content.split('\n')[0], '200\tline 200');
      assert.match(r.content, /^201\tline 201$/m);
    });

    test('limit で行数を決められる', async () => {
      const root = await many();
      const r = await readFileTool.run({ path: 'long.txt', offset: 10, limit: 3 }, ctx(root));
      const body = r.content.split('\n').filter((l) => /^\d+\t/.test(l));
      assert.deepEqual(body, ['10\tline 10', '11\tline 11', '12\tline 12']);
      assert.match(r.content, /続きは offset=13 で読めます/);
    });

    test('数を文字列で渡されても効く（モデルはそう渡してくる）', async () => {
      const root = await many();
      const r = await readFileTool.run({ path: 'long.txt', offset: '10', limit: '1' }, ctx(root));
      const body = r.content.split('\n').filter((l) => /^\d+\t/.test(l));
      assert.deepEqual(body, ['10\tline 10']);
    });

    test('行の数を超えた offset は、そう言って断る', async () => {
      const root = await many();
      const r = await readFileTool.run({ path: 'long.txt', offset: lines + 5 }, ctx(root));
      assert.equal(r.isError, true);
      assert.match(r.content, new RegExp(`${lines} 行しかありません`));
    });

    test('渡さなければ、これまでどおり先頭から（対）', async () => {
      const root = await many();
      const r = await readFileTool.run({ path: 'long.txt' }, ctx(root));
      assert.match(r.content, /^1\tline 1$/m);
    });

    test('最後まで出したときは、続きの案内を出さない（対）', async () => {
      const root = await many();
      const r = await readFileTool.run({ path: 'long.txt', offset: lines }, ctx(root));
      assert.doesNotMatch(r.content, /続きは offset/);
    });
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

/**
 * 作業ディレクトリの外を、名前だけでも出さない。
 *
 * `read_file` はリンクの先まで見て断っていたが、`list_files` と `search_text` は
 * **文字の上でしか見ていなかった。**作業ディレクトリの中に外を指すリンクが一つ
 * あれば、そこを path に渡すだけで外のファイル名が並ぶ。中身は read_file が
 * 断るので、名前だけが漏れる形になっていた（実際に出した）。
 *
 * 木を降りるときは Dirent がリンクを「ファイルでもディレクトリでもない」として
 * 飛ばすので、**名指しで渡されたときだけ**漏れる。そこを見る。
 */
describe('リンクの先が外なら、一覧も検索も断る', () => {
  async function linked(): Promise<{ root: string; outside: string }> {
    const { symlink } = await import('node:fs/promises');
    const base = await tempDir('aas-link-');
    const root = join(base, 'work');
    const outside = join(base, 'secret');
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'notes.txt'), 'private\n');
    await symlink(outside, join(root, 'link'), 'dir');
    return { root, outside };
  }

  test('**list_files は、外を指すリンクを一覧しない**', async () => {
    const { root } = await linked();
    const got = await listFilesTool.run({ path: 'link' }, ctx(root));
    assert.equal(got.isError, true, `一覧してしまった: ${got.content}`);
    assert.doesNotMatch(got.content, /notes\.txt/, `外のファイル名が出ている: ${got.content}`);
  });

  test('**search_text も、外を指すリンクを探さない**', async () => {
    const { root } = await linked();
    const got = await searchTextTool.run({ query: 'private', path: 'link' }, ctx(root));
    assert.equal(got.isError, true, `探してしまった: ${got.content}`);
    assert.doesNotMatch(got.content, /notes\.txt/, `外のファイル名が出ている: ${got.content}`);
  });

  test('中のリンクなら、これまでどおり通る（対）', async () => {
    const { symlink } = await import('node:fs/promises');
    const root = await tempDir('aas-link-in-');
    await mkdir(join(root, 'real'), { recursive: true });
    await writeFile(join(root, 'real', 'a.ts'), 'const x = 1;\n');
    await symlink(join(root, 'real'), join(root, 'alias'), 'dir');
    const got = await listFilesTool.run({ path: 'alias' }, ctx(root));
    assert.equal(got.isError, undefined, `中のリンクを断っている: ${got.content}`);
    assert.match(got.content, /a\.ts/, `中身が出ていない: ${got.content}`);
  });
});

/**
 * 探せなかったことを、「該当なし」と言わない。
 *
 * `search_text` は walk の失敗を握り潰していた。無い道を渡すと、探しにすら
 * 行っていないのに `該当なし` と返る。モデルは「そこには無い」と読んで、
 * 別の場所を探しに行かない。**打ち間違いが、事実として返ってくる。**
 */
describe('search_text は、探せなかったことを言う', () => {
  test('**無い道は、該当なしではなく失敗**', async () => {
    const root = await workspace();
    const got = await searchTextTool.run({ query: 'answer', path: 'nosuchdir' }, ctx(root));
    assert.equal(got.isError, true, `該当なしで済ませている: ${got.content}`);
    assert.doesNotMatch(got.content, /該当なし/, got.content);
  });

  test('ファイルを指されたら、その一つを探す', async () => {
    // モデルはよく渡してくる。readdir に落とすと「使い方の間違い」にしか見えない。
    const root = await workspace();
    const got = await searchTextTool.run({ query: 'answer', path: 'app.ts' }, ctx(root));
    assert.equal(got.isError, undefined, `ファイル指定で落ちている: ${got.content}`);
    assert.match(got.content, /app\.ts:1/, got.content);
  });

  test('本当に無いときは、これまでどおり該当なし（対）', async () => {
    const root = await workspace();
    const got = await searchTextTool.run({ query: 'このことばはどこにもない' }, ctx(root));
    assert.equal(got.isError, undefined, got.content);
    assert.match(got.content, /該当なし/, got.content);
  });
});
