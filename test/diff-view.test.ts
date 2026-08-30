import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
// 画面側の素の JS をそのまま読む。画面で動くものと、試すものを同じにする。
import { parseDiff, collapse } from '../src/ui/web/diff.js';

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
