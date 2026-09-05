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

/**
 * 字下げと行末の空白が違っても当てる。
 *
 * **小さいモデルは、空白を一つ外す。**タブと空白を取り違える、字下げの段を
 * 一つ間違える、行末の空白を落とす。中身は合っているのに完全一致では通らず、
 * 「見つかりません」と返すとモデルは同じことを何度も試す。往復だけ増えて
 * 何も直らない。**道具が脆いだけなのに、モデルが馬鹿に見える。**
 *
 * ただし**緩めるのは行の外側だけ。**行の並びと中身そのものは一致を求める。
 * ここを緩めると、似た別の場所を書き換える。
 */
describe('空白が違っても当てる', () => {
  test('字下げの段が違っても当たる', () => {
    // 渡された方が**深い**ときは、完全一致では通らない（浅いときは、
    // find が部分文字列になるので元から通る）。深い側がこの穴。
    const before = 'function f() {\n  const a = 1;\n  return a;\n}\n';
    const got = applyEdit(before, '    const a = 1;', '    const a = 2;', false);
    assert.equal(got.hits, 1);
    assert.equal(got.loose, true, 'ゆるく当てたことを言っていない');
    // **ファイルの側の字下げに合わせる。**渡された 4 段で書かない。
    assert.equal(got.text, 'function f() {\n  const a = 2;\n  return a;\n}\n');
  });

  test('タブと空白が違っても当たる', () => {
    const before = 'if (x) {\n\treturn 1;\n}\n';
    const got = applyEdit(before, '    return 1;', '    return 2;', false);
    assert.equal(got.hits, 1);
    assert.equal(got.text, 'if (x) {\n\treturn 2;\n}\n', 'ファイルのタブに合わせていない');
  });

  test('行末の空白が違っても当たる', () => {
    // 渡された方に余分な行末の空白が付いているとき。ファイル側に付いて
    // いるだけなら、find が部分文字列になるので元から通る。
    const before = 'const a = 1;\nconst b = 2;\n';
    const got = applyEdit(before, 'const a = 1;   ', 'const a = 9;', false);
    assert.equal(got.hits, 1);
    assert.equal(got.loose, true, 'ゆるく当てたことを言っていない');
    assert.equal(got.text, 'const a = 9;\nconst b = 2;\n');
  });

  test('何行にもわたっても、相対の段は壊さない', () => {
    const before = 'class A {\n  run() {\n    step1();\n    step2();\n  }\n}\n';
    const got = applyEdit(
      before,
      'step1();\nstep2();',
      'step1();\nif (ok) {\n  step2();\n}',
      false,
    );
    assert.equal(got.hits, 1);
    assert.equal(
      got.text,
      'class A {\n  run() {\n    step1();\n    if (ok) {\n      step2();\n    }\n  }\n}\n',
    );
  });

  test('**完全一致が在るときは、そちらが勝つ**', () => {
    // 元からの動きを変えない。ゆるい当て方は、完全一致が無いときだけ。
    const before = '  const a = 1;\nconst a = 1;\n';
    const got = applyEdit(before, 'const a = 1;\n', 'X\n', false);
    assert.equal(got.loose, undefined, 'ゆるい方へ落ちている');
  });

  test('**中身が違えば当てない**', () => {
    const before = 'const a = 1;\n';
    assert.equal(applyEdit(before, 'const a = 2;', 'X', false).hits, 0);
    // 行の数が違うものも当てない。
    assert.equal(applyEdit(before, 'const a = 1;\nconst b = 2;', 'X', false).hits, 0);
  });

  test('ゆるくても、何箇所にも当たるなら止める', () => {
    const before = '  same();\n\tsame();\n';
    const got = applyEdit(before, 'same();', 'other();', false);
    assert.equal(got.hits, 2);
    assert.equal(got.text, before, '決まらないのに書き換えている');
  });

  test('ゆるくても、all なら全部当てる（対）', () => {
    const before = '  same();\n\tsame();\n';
    const got = applyEdit(before, 'same();', 'other();', true);
    assert.equal(got.hits, 2);
    assert.equal(got.text, '  other();\n\tother();\n', 'それぞれの字下げに合わせていない');
  });

  test('道具として使っても当たり、**黙って当てない**', async () => {
    const { root, path } = await fixture('function f() {\n  const a = 1;\n}\n');
    const r = await editFileTool.run(
      { path, find: '    const a = 1;', replace: '    const a = 2;' }, await ctxAt(root),
    );
    assert.equal(r.isError, undefined, r.content);
    assert.equal(await readFile(join(root, path), 'utf8'), 'function f() {\n  const a = 2;\n}\n');
    assert.ok(r.content.includes('合わせて当てました'), `黙って当てている: ${r.content}`);
  });

  test('ゆるく当てた後の姿も、守りに渡る', async () => {
    // 道具と検問所が別々に当てると、守りは違うものを見て素通りさせる。
    const { root, path } = await fixture('function f() {\n  const a = 1;\n}\n');
    const planned = await plannedContent(
      'edit_file', { path, find: '    const a = 1;', replace: '    const a = 2;' }, root,
    );
    assert.equal(planned, 'function f() {\n  const a = 2;\n}\n');
  });
});

/**
 * 打ち切ったことを、黙らない。
 *
 * `search_text` は 100 件で止めていて、**何も言っていなかった**。
 * 呼び出し元を全部直したいときに、モデルは 100 件で全部だと思う。
 * **残りは直されないまま残る。**直したつもりで壊れているのが、いちばん
 * 見つけにくい。索引で同じ形を見つけたので、ここも見た。
 */
describe('探す側も、打ち切りを黙らない', () => {
  async function many(count: number, perFile = 1): Promise<string> {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const root = await tempDir('aas-cap-search-');
    for (let i = 0; i < count; i += 1) {
      const sub = join(root, `p${Math.floor(i / 20)}`);
      await mkdir(sub, { recursive: true });
      await writeFile(
        join(sub, `f${i}.ts`),
        Array.from({ length: perFile }, (_, k) => `const 目印${i}_${k} = 1;`).join('\n') + '\n',
      );
    }
    return root;
  }

  test('**100 件で打ち切ったら、そう言う**', async () => {
    const { searchTextTool } = await import('../src/agent/tools/fs.ts');
    const root = await many(150);
    const got = await searchTextTool.run({ query: '目印' }, await ctxAt(root));
    assert.ok(got.content.includes('打ち切りました'), `黙って切っている: ${got.content.slice(-200)}`);
    assert.ok(got.content.includes('全部ではありません'), '全部だと読める言い方になっている');
  });

  test('全部入るときは、何も言わない（対）', async () => {
    const { searchTextTool } = await import('../src/agent/tools/fs.ts');
    const root = await many(5);
    const got = await searchTextTool.run({ query: '目印' }, await ctxAt(root));
    assert.ok(!got.content.includes('打ち切り'), `切っていないのに言っている: ${got.content}`);
  });

  test('一つのファイルの中で打ち切っても、そう言う', async () => {
    // 当たりが一つのファイルに固まっている形。ファイル数では切れない。
    const { searchTextTool } = await import('../src/agent/tools/fs.ts');
    const root = await many(1, 150);
    const got = await searchTextTool.run({ query: '目印' }, await ctxAt(root));
    assert.ok(got.content.includes('打ち切りました'), `黙って切っている: ${got.content.slice(-200)}`);
  });

  test('大きすぎて見ていないものも言う', async () => {
    const { searchTextTool } = await import('../src/agent/tools/fs.ts');
    const { writeFile } = await import('node:fs/promises');
    const root = await tempDir('aas-cap-big-');
    await writeFile(join(root, 'small.ts'), 'const 目印 = 1;\n');
    // MAX_READ_BYTES を超える大きさ。
    await writeFile(join(root, 'huge.ts'), `const 目印 = 1;\n${'x'.repeat(600_000)}`);
    const got = await searchTextTool.run({ query: '目印' }, await ctxAt(root));
    assert.ok(got.content.includes('small.ts'), '見えるものが出ていない');
    assert.ok(
      got.content.includes('大きすぎて見ていない'),
      `見ていないファイルを黙っている: ${got.content.slice(-200)}`,
    );
  });
});
