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
import { editFileTool, readFileTool } from '../src/agent/tools/fs.ts';
import { isWriteTool, applyEdit, plannedContent, nearestTo } from '../src/agent/tools/write-kind.ts';
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
  /** 見たいのは中身と数。**どう当てたか（how）まで縛らない**（増えるたびに落ちる）。 */
  const got = (before: string, find: string, replace: string, all: boolean) => {
    const r = applyEdit(before, find, replace, all);
    return { text: r.text, hits: r.hits };
  };

  test('数を返す。返さないと、多重に当たったのを止められない', () => {
    assert.deepEqual(got('aXaXa', 'X', 'Y', false), { text: 'aXaXa', hits: 2 });
    assert.deepEqual(got('aXaXa', 'X', 'Y', true), { text: 'aYaYa', hits: 2 });
    assert.deepEqual(got('aXa', 'X', 'Y', false), { text: 'aYa', hits: 1 });
    assert.deepEqual(got('aaa', 'X', 'Y', false), { text: 'aaa', hits: 0 });
  });

  test('置き換える先に find と同じ文字が入っていても、増殖しない', () => {
    // `a` を `aa` にするような形。素朴に回すと無限に増える。
    assert.deepEqual(got('a b a', 'a', 'aa', true), { text: 'aa b aa', hits: 2 });
  });

  test('空の find は何もしない', () => {
    assert.deepEqual(got('abc', '', 'x', true), { text: 'abc', hits: 0 });
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
    // find が部分文字列になるので元から通る）。深い側がこの不具合。
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

describe('両端で当てる', () => {
  const FILE = [
    'export function add(a, b) {',
    '  // 足し算をする。',
    '  const sum = a + b;',
    '  return sum;',
    '}',
    '',
  ].join('\n');
  const REPLACE = 'export function add(a, b) {\n  return a + b;\n}';

  /**
   * **小さいモデルは、長い塊の真ん中を書き崩す。**注釈を落とす、空行を入れる、
   * 途中を省く。完全一致でも、字下げを見ない当て方でも通らない。
   * 「見つかりません」と返すと、同じことを何度も試して往復だけ増える。
   * Cline が同じところで同じ手（block anchor matching）を使っている。
   */
  test('**真ん中を書き崩されても、両端が合えば当たる**', () => {
    const got = applyEdit(FILE, 'export function add(a, b) {\n  const sum = a + b;\n  return sum;\n}', REPLACE, false);
    assert.equal(got.hits, 1);
    assert.equal(got.how, 'anchor');
    assert.match(got.text, /return a \+ b;/);
    assert.doesNotMatch(got.text, /const sum/, '古い中身が残っている');
  });

  test('**真ん中がでっち上げなら、当てない**', () => {
    // 両端だけ見て置き換えると、渡された塊に無い行まで消える。
    const got = applyEdit(FILE, 'export function add(a, b) {\n  const x = 1;\n  const y = 2;\n  return 9;\n}', REPLACE, false);
    assert.equal(got.hits, 0, '中身が違うのに当てている');
    assert.equal(got.text, FILE);
  });

  test('両端が違えば、当てない', () => {
    const got = applyEdit(FILE, 'function nothing() {\n  const a = 1;\n  return a;\n}', REPLACE, false);
    assert.equal(got.hits, 0);
  });

  test('短い塊には使わない（両端がほとんど中身そのもの）', () => {
    const got = applyEdit(FILE, 'const sum = a - b;\nreturn sum;', REPLACE, false);
    assert.equal(got.hits, 0);
  });

  test('完全に一致するときは、そちらを使う', () => {
    const got = applyEdit(FILE, '  const sum = a + b;', '  const sum = a - b;', false);
    assert.equal(got.how, 'exact');
  });

  test('**両端で当てたことを、黙らない**', async () => {
    const root = await tempDir('aas-anchor-');
    await writeFile(join(root, 'math.js'), FILE, 'utf8');
    const ctx = {
      root, signal: new AbortController().signal,
      approve: async () => true,
    } as unknown as Parameters<typeof editFileTool.run>[1];
    // **読んでから書く。**規則がその並びを求める。
    await readFileTool.run({ path: 'math.js' }, ctx);
    const got = await editFileTool.run({
      path: 'math.js',
      find: 'export function add(a, b) {\n  const sum = a + b;\n  return sum;\n}',
      replace: REPLACE,
    }, ctx);
    assert.ok(!got.isError, got.content);
    assert.match(got.content, /最初と最後の行だけが一致/,
      `どう当てたかを言っていない: ${got.content}`);
    assert.match(await readFile(join(root, 'math.js'), 'utf8'), /return a \+ b;/);
  });
});

describe('当たらなかったときに、いちばん近い場所を見せる', () => {
  const FILE = [
    'function add(a, b) {',
    '  const sum = a + b;',
    '  return sum;',
    '}',
  ].join('\n');

  /**
   * ここまでは「read_file で読み直してください」とだけ返していた。
   * 読み直しは**一往復まるごと**払ううえ、ファイル全体が窓に入る。
   * それでも次も外す（何が違うのか分からないまま書き直すので）。
   * Roo Code が、当たらなかった塊のいちばん近い場所を返している。同じ手を取る。
   */
  test('**近い場所を、行番号付きでその場で返す**', async () => {
    const root = await tempDir('aas-near-');
    await writeFile(join(root, 'math.js'), FILE, 'utf8');
    const ctx = {
      root, signal: new AbortController().signal, approve: async () => true,
    } as unknown as Parameters<typeof editFileTool.run>[1];
    await readFileTool.run({ path: 'math.js' }, ctx);

    const got = await editFileTool.run({
      path: 'math.js',
      find: 'function add(a, b) {\n  const total = a + b;\n  return total;\n}',
      replace: 'x',
    }, ctx);
    assert.ok(got.isError);
    assert.match(got.content, /いちばん近いのはここです/, got.content);
    assert.match(got.content, /const sum = a \+ b;/, `中身を見せていない: ${got.content}`);
    assert.match(got.content, /\s2:/, `行番号を付けていない: ${got.content}`);
  });

  test('**近いものが無ければ、でたらめを見せない**', () => {
    assert.equal(nearestTo(FILE, 'class Zebra {\n  fly() {}\n}'), undefined);
  });

  test('半分も重なっていなければ、近いとは言わない', () => {
    assert.equal(nearestTo(FILE, 'const sum = a + b;\nzzz1\nzzz2\nzzz3'), undefined);
  });
});

describe('当て方を足しても、正しい渡し方を壊さない', () => {
  /**
   * 当て方を二つ足した（字下げを見ない／両端で当てる）。**足した性質だけを
   * 見て終わると、元から在った性質を壊す。**
   *
   * 元から在ったのは「find がそのまま在るなら、素直に置き換えたのと同じ」。
   * 入力はこちらで選ばず、種を固定した無作為でぶつける。
   */
  test('**そのまま在る find は、素直な置き換えと同じ結果になる**', () => {
    let seed = 20260906;
    const rnd = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    const LINES = [
      'export function add(a, b) {', '  const sum = a + b;', '  return sum;', '}', '',
      'class Thing {', '  run() {', '    return 1;', '  }', '}',
      '// 注釈', '  // 中の注釈', 'const x = 1;', '\tconst y = 2;', '  ',
    ];

    let checked = 0;
    for (let i = 0; i < 1500; i += 1) {
      const n = 3 + Math.floor(rnd() * 12);
      const lines = Array.from({ length: n }, () => pick(LINES));
      const file = lines.join('\n');
      const from = Math.floor(rnd() * n);
      const len = 1 + Math.floor(rnd() * Math.min(4, n - from));
      const find = lines.slice(from, from + len).join('\n');
      if (find.trim().length === 0) continue;
      // 一意に在るものだけを見る（複数当たるのは、そもそも断る仕様）。
      if (file.indexOf(find) !== file.lastIndexOf(find)) continue;

      const got = applyEdit(file, find, 'REPLACED', false);
      assert.equal(got.hits, 1, `そのまま在るのに当たらない: ${JSON.stringify(find)}`);
      assert.equal(got.text, file.replace(find, 'REPLACED'),
        `素直な置き換えと違う: ${JSON.stringify({ find, how: got.how })}`);
      checked += 1;
    }
    // 数が少なすぎると「たまたま通った」になる。
    assert.ok(checked > 500, `試した数が少なすぎる: ${checked}`);
  });
});

/**
 * モデルの崩し方に、当て負けない。
 *
 * ここは `scripts/bench-edit.mjs` で測ったところ。git の履歴 400 commit の
 * hunk 2087 件に、実際に見た崩れ方（字下げ・行末・注釈落ち・空行・省略）を
 * 与えて、**利用者が実際に書いた結果と同じになるか**で見た。
 *
 *   崩し方      直す前    直した後
 *   そのまま     99.8%    100.0%
 *   字下げ        9.6%    100.0%
 *   行末         79.3%    100.0%
 *   注釈落ち      67.0%     79.2%
 *   空行入り      73.9%     93.3%
 *   省略         67.4%     88.9%
 *
 * 落ちていたのは三つ。ここではその三つを、いちばん小さい形で押さえる。
 */
describe('崩れた find でも、正しい所へ正しく当てる', () => {
  test('**行の途中から当てない**', () => {
    /*
     * 字下げを一つ落として渡されると、崩れた find が**本物の行の途中と
     * 完全一致する**（`  * b` は `   * b` の一部）。そこへ置き換えると、
     * 消し損ねた空白が頭に残って一段ずれる。しかも「完全に一致した」ので
     * 何も言わない。**モデルは直ったと思って先へ進む。**
     */
    const before = '   * a\n   * b\n   */\n';
    const got = applyEdit(before, '  * b\n   */', '   * B\n   */', false);
    assert.equal(got.hits, 1);
    assert.equal(got.text, '   * a\n   * B\n   */\n',
      `行の途中に当てて、字下げがずれている: ${JSON.stringify(got.text)}`);
  });

  test('一行だけなら、行の途中でよい（対）', () => {
    // 名前の付け替えは行の途中に当たる。そこまで断ると使えない。
    const before = 'const total = countOf(x) + countOf(y);\n';
    const got = applyEdit(before, 'countOf', 'sizeOf', true);
    assert.equal(got.hits, 2);
    assert.equal(got.text, 'const total = sizeOf(x) + sizeOf(y);\n');
  });

  test('**replace がファイルの字下げで書かれているなら、寄せ直さない**', () => {
    /*
     * モデルは find だけ書き崩して、replace はファイルの通りに書いてくる
     * ことがある（読んだものを写すので、そちらは合う）。それを
     * 「find と同じ枠で書かれている」と決めつけて寄せると、replace が
     * 丸ごと一段ずれる。履歴で測ると 928 件中 839 件がこれだった。
     */
    const before = 'class A {\n    run() {\n      go();\n    }\n}\n';
    // find の先頭行だけ字下げを崩す（2段）。replace はファイルどおり（4段）。
    const got = applyEdit(before, '  run() {\n      go();\n    }', '    run() {\n      stop();\n    }', false);
    assert.equal(got.hits, 1);
    assert.equal(got.text, 'class A {\n    run() {\n      stop();\n    }\n}\n',
      `replace を寄せ直して段がずれている: ${JSON.stringify(got.text)}`);
  });

  test('モデルの枠で書かれているなら、寄せる（対）', () => {
    // find も replace も同じ（間違った）字下げで書かれているとき。
    // ここは寄せないと、段のずれたコードが入る。
    const before = 'function f() {\n  const a = 1;\n}\n';
    const got = applyEdit(before, '    const a = 1;', '    const a = 2;', false);
    assert.equal(got.hits, 1);
    assert.equal(got.text, 'function f() {\n  const a = 2;\n}\n');
  });

  test('**端の空行を、二重に入れない**', () => {
    /*
     * find の前後の空行は「落として探す」ので、その空行はファイルに残る。
     * なのに replace は落とさずに流し込んでいたので、空行が二重になった。
     */
    const before = 'a();\n\n  b();\n\nc();\n';
    // 行末の空白を混ぜて、完全一致では通らない形にする（緩い当てに落とす）。
    const got = applyEdit(before, '\n  b();  \n', '\n  B();\n', false);
    assert.equal(got.hits, 1);
    assert.equal(got.text, 'a();\n\n  B();\n\nc();\n',
      `空行が増えている: ${JSON.stringify(got.text)}`);
  });

  test('空行を足したい編集は、壊さない（対）', () => {
    // find に端の空行が無ければ、こちらからは何も削らない。
    const before = 'a();\nb();\n';
    const got = applyEdit(before, 'a();', 'a();\n', false);
    assert.equal(got.hits, 1);
    assert.equal(got.text, 'a();\n\nb();\n');
  });

  test('置き換える側の $ を、置換の指定として読まない', () => {
    // String.replace は $& や $1 を特別扱いする。正規表現を書き換えるとき、
    // これが混ざる。切って繋ぐ形にしたので、そのまま入る。
    const before = 'const re = /x/;\n';
    const got = applyEdit(before, '/x/', "/y/.source + '$&'", false);
    assert.equal(got.text, "const re = /y/.source + '$&';\n");
  });
});

describe('両端で当てるとき、いちばん合う終わりを選ぶ', () => {
  /**
   * 終わりの行は `}` や `);` のような、どこにでもある行になりやすい。
   * 最初に当たったところで打ち切ると、**本当の終わりより手前**で止まり、
   * 残りの行が置き去りになる。しかも当たったことになるので何も言わない。
   *
   * 履歴 400 commit で測ると、真ん中に空行を入れた形・数行を省いた形の
   * 失敗は**全部これ**だった（別物になったのが 43 件・53 件）。
   */
  test('**手前の `}` で打ち切らない**', () => {
    const before = [
      'function f() {',
      '  if (a) {',
      '    one();',
      '  }',
      '  two();',
      '  three();',
      '}',
      '',
    ].join('\n');
    // 真ん中を一行省いて渡す（`two();` を落とす）。行数は本物より 1 少ない。
    const find = ['function f() {', '  if (a) {', '    one();', '  }', '  three();', '}'].join('\n');
    const got = applyEdit(before, find, 'function f() {\n  done();\n}', false);
    assert.equal(got.hits, 1);
    assert.equal(got.how, 'anchor');
    assert.equal(got.text, 'function f() {\n  done();\n}\n',
      `手前の } で打ち切って、置き去りが出ている: ${JSON.stringify(got.text)}`);
  });

  test('真ん中が合わない所へは、当てない（対）', () => {
    // 緩めた分だけ、よその場所へ当たりやすくなる。半分の決まりは残す。
    const before = 'function f() {\n  aaa();\n  bbb();\n  ccc();\n}\n';
    const got = applyEdit(before, 'function f() {\n  xxx();\n  yyy();\n  zzz();\n}', 'X', false);
    assert.equal(got.hits, 0, '中身が違うのに当てている');
  });
});
