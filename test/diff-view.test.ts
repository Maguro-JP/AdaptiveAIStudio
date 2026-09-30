import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
// 画面側の素の JS をそのまま読む。画面で動くものと、試すものを同じにする。
import { parseDiff, collapse, splitHunkTexts } from '../src/ui/web/diff.js';

const diff = [
  '--- a/greet.js',
  '+++ b/greet.js',
  '@@ -1,5 +1,6 @@',
  ' export function greet(name) {',
  '-  return `Hello, ${name}`;',
  '+  // 名前を受け取って挨拶を返す',
  '+  return `こんにちは、${name}さん`;',
  ' }',
  ' ',
  '-export const VERSION = \'1.0.0\';',
  '+export const VERSION = \'2.0.0\';',
].join('\n');

describe('差分を解く', () => {
  test('ファイル名と増減が取れる', () => {
    const [file] = parseDiff(diff);
    assert.equal(file!.path, 'greet.js');
    assert.equal(file!.added, 3);
    assert.equal(file!.removed, 2);
  });

  test('行番号が左右で別々に進む', () => {
    const [file] = parseDiff(diff);
    const del = file!.lines.find((l) => l.kind === 'del')!;
    const add = file!.lines.find((l) => l.kind === 'add')!;
    assert.equal(del.oldNo, 2);
    assert.equal(add.newNo, 2);
    assert.equal(del.newNo, undefined, '消えた行に新しい行番号は無い');
    assert.equal(add.oldNo, undefined, '足した行に古い行番号は無い');
  });

  test('先頭の空白は削るが、中身の字下げは残す', () => {
    const [file] = parseDiff(diff);
    const add = file!.lines.filter((l) => l.kind === 'add')[1]!;
    assert.ok(add.text!.startsWith('  return'), `字下げが消えた: ${JSON.stringify(add.text)}`);
  });

  test('読めない中身でも投げない', () => {
    assert.deepEqual(parseDiff(''), []);
    assert.deepEqual(parseDiff(undefined), []);
    assert.deepEqual(parseDiff('ただの文章'), []);
  });

  test('複数ファイルを分けて取る', () => {
    const two = ['--- a/x', '+++ b/x', '@@ -1 +1 @@', '-a', '+b',
      '--- a/y', '+++ b/y', '@@ -1 +1 @@', '-c', '+d'].join('\n');
    assert.deepEqual(parseDiff(two).map((f) => f.path), ['x', 'y']);
  });
});

describe('変わっていないところを畳む', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ kind: 'same', text: `${i}` }));

  test('離れたところは畳む', () => {
    const lines = [...many(20), { kind: 'add', text: 'x' }, ...many(20)];
    const out = collapse(lines as never, 3);
    assert.ok(out.length < lines.length, '畳まれていない');
    assert.equal(out.filter((l) => l.kind === 'folded').length, 2);
  });

  test('変更の前後は残す。何の周りの変更か分からなくなるため', () => {
    const lines = [...many(10), { kind: 'del', text: 'x' }, ...many(10)];
    const out = collapse(lines as never, 3);
    const i = out.findIndex((l) => l.kind === 'del');
    assert.equal(out.slice(0, i).filter((l) => l.kind === 'same').length, 3);
    assert.equal(out.slice(i + 1).filter((l) => l.kind === 'same').length, 3);
  });

  test('畳んだ行数を数えて出す', () => {
    const lines = [...many(20), { kind: 'add', text: 'x' }];
    const out = collapse(lines as never, 3);
    const folded = out.find((l) => l.kind === 'folded')!;
    assert.equal(folded.count, 17);
  });

  test('変更が無ければ全部畳む', () => {
    const out = collapse(many(10) as never, 3);
    assert.deepEqual(out.map((l) => l.kind), ['folded']);
  });

  test('短い差分は畳まない', () => {
    const lines = [{ kind: 'same', text: 'a' }, { kind: 'add', text: 'b' }];
    assert.equal(collapse(lines as never, 3).some((l) => l.kind === 'folded'), false);
  });
});

describe('塊ごとに割る（採否を分けるため）', () => {
  const two = [
    '--- a/a.ts', '+++ b/a.ts',
    '@@ -1,3 +1,3 @@', ' a', '-b', '+B', ' c',
    '@@ -20,3 +20,3 @@', ' x', '-y', '+Y', ' z',
  ].join('\n');

  test('塊の数だけ返る', () => {
    assert.equal(splitHunkTexts(two).length, 2);
  });

  test('割ったものは、それぞれ単体の差分として読める', () => {
    const [first, second] = splitHunkTexts(two);
    assert.equal(parseDiff(first!.text)[0]?.path, 'a.ts');
    assert.equal(parseDiff(first!.text)[0]?.added, 1);
    assert.equal(parseDiff(second!.text)[0]?.lines.some((l) => l.text === 'Y'), true);
  });

  test('差分でなければ空', () => {
    assert.deepEqual(splitHunkTexts('ただの文'), []);
  });
});

describe('塊の中の --- と +++ は、見出しではなく中身', () => {
  /**
   * 中身が `-- `（SQL の注釈など）で始まる行を消すと `--- …` になる。見出しとして飛ばしていたので、承認の差分からその行が消え、
   * 以後の行の番号がずれて、行を押して戻すと別の組を戻し、`++` で始まる行を足すと偽のファイルの札が出ていた。
   */
  test('消した -- の行と足した ++ の行を行として読み、番号を本体の割り方と揃える', async () => {
    const { unifiedDiff } = await import('../src/agent/diff.ts');
    const { splitHunks } = await import('../src/agent/hunks.ts');
    const diff = unifiedDiff('q.sql', '-- old\nSELECT 1;\n', '++i;\nSELECT 1;\n');
    const files = parseDiff(diff);
    assert.equal(files.length, 1, `偽のファイルの札が出た: ${JSON.stringify(files.map((f) => f.path))}`);
    const file = files[0]!;
    const del = file.lines.find((l) => l.kind === 'del');
    const add = file.lines.find((l) => l.kind === 'add');
    assert.equal(del?.text, '-- old', '消した行が承認の差分から消えた');
    assert.equal(add?.text, '++i;');
    assert.equal(file.added, 1);
    assert.equal(file.removed, 1);
    // 番号（at）は本体の塊の行の並び（splitHunks）と同じ
    const body = splitHunks(diff)[0]!.lines;
    for (const l of file.lines.filter((x) => x.at !== undefined)) {
      const want = l.kind === 'add' ? `+${l.text}` : l.kind === 'del' ? `-${l.text}` : ` ${l.text}`;
      assert.equal(body[l.at!], want, `番号がずれた: ${l.at}`);
    }
  });

  test('塊に割っても、中身の --- を見出しとして前に積まない', async () => {
    const { unifiedDiff } = await import('../src/agent/diff.ts');
    const diff = unifiedDiff('q.sql', '-- old\nSELECT 1;\n', 'SELECT 1;\n');
    const one = splitHunkTexts(diff)[0]!;
    assert.equal(one.text.split('\n').filter((l) => l.startsWith('--- ')).length, 2, '見出しの --- と中身の --- の二つだけのはず');
    assert.equal(parseDiff(one.text)[0]!.removed, 1);
  });
});
