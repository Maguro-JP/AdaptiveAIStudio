/**
 * utf8 で読めないファイルを read_file で読ませたとき。
 *
 * 化けた字（U+FFFD）のまま渡すと、モデルはそれを中身だと思って直しにかかる。読めないものは
 * 「読めない」と言う（CLAUDE.md の「渡す」と同じ線）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { readFileTool, writeFileTool, searchTextTool } from '../src/agent/tools/fs.ts';
import { Harness } from '../src/harness/harness.ts';
import { readBeforeWrite } from '../src/harness/builtin-rules.ts';
import { readMentions } from '../src/agent/mention.ts';
import { shiftJisSupported } from '../src/agent/tools/decode.ts';
import type { ToolContext } from '../src/agent/tools/types.ts';

const ctx = (root: string): ToolContext => ({
  root, signal: new AbortController().signal, approve: () => Promise.resolve(true as const),
});

describe('utf8 で読めないファイルを読む', () => {
  test('二進（NUL を含む）は中身を渡さず、読めないと言う', async () => {
    const root = await tempDir('aas-read-bin-');
    // 先頭が utf8 として正しい字だけでも、NUL があれば二進として断る。
    await writeFile(join(root, 'a.bin'), Buffer.from('a\0b\n'));
    const r = await readFileTool.run({ path: 'a.bin' }, ctx(root));
    assert.equal(r.isError, true, `読めたことにした: ${r.content}`);
    assert.match(r.content, /二進/);
    assert.match(r.content, /4 バイト/, '大きさを言っていない');
  });

  test('Shift_JIS は Shift_JIS として読み、そう読んだことと直し方を添える', async () => {
    const root = await tempDir('aas-read-sjis-');
    // 「あいうえお」を Shift_JIS で。
    await writeFile(join(root, 'sjis.txt'), Buffer.from([0x82, 0xa0, 0x82, 0xa2, 0x82, 0xa4, 0x82, 0xa6, 0x82, 0xa8, 0x0a]));
    const r = await readFileTool.run({ path: 'sjis.txt' }, ctx(root));
    assert.equal(r.isError, undefined, r.content);
    assert.match(r.content, /1\tあいうえお/, `Shift_JIS として読んでいない: ${r.content}`);
    assert.match(r.content, /Shift_JIS として読みました/);
    assert.match(r.content, /write_file で utf8 の全文に書き直して/, '直し方を添えていない');
    assert.doesNotMatch(r.content, /\uFFFD/, '化けた字を渡した');
  });

  test('UTF-16LE（BOM つき）は、その文字コードで読む', async () => {
    const root = await tempDir('aas-read-u16-');
    await writeFile(join(root, 'out.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hello\nあ\n', 'utf16le')]));
    const r = await readFileTool.run({ path: 'out.txt' }, ctx(root));
    assert.equal(r.isError, undefined, r.content);
    // BOM は読むときに落とす（書き直すときは utf8 になるので、見せる意味が無い）。
    assert.match(r.content, /1\thello\n2\tあ/, `UTF-16 として読んでいない: ${r.content}`);
    assert.match(r.content, /UTF-16LE として読みました/);
  });

  test('読めないバイトが一か所だけなら、Shift_JIS として読めてしまう形でも utf8 として読む', async () => {
    const root = await tempDir('aas-read-latin1-sjis-');
    // Latin-1 の é（0xE9）の後ろに英字が続くと、Shift_JIS としても（別の漢字として）読めてしまう。
    await writeFile(join(root, 'conf.ini'), Buffer.concat([Buffer.from('name=caf'), Buffer.from([0xe9]), Buffer.from('s\nport=80\n')]));
    const r = await readFileTool.run({ path: 'conf.ini' }, ctx(root));
    assert.equal(r.isError, undefined, r.content);
    assert.doesNotMatch(r.content, /Shift_JIS/, `一か所の傷で Shift_JIS と取り違えた: ${r.content}`);
    assert.match(r.content, /読めないバイトが 1 か所/);
    assert.match(r.content, /2\tport=80/);
  });

  test('読めないバイトが一か所だけのファイルは、残りを utf8 として読む（Latin-1 の字が一つ）', async () => {
    const root = await tempDir('aas-read-latin1-');
    await writeFile(join(root, 'conf.txt'), Buffer.concat([Buffer.from('name=caf'), Buffer.from([0xe9]), Buffer.from('\nあいう\n')]));
    const r = await readFileTool.run({ path: 'conf.txt' }, ctx(root));
    assert.equal(r.isError, undefined, r.content);
    assert.match(r.content, /2\tあいう/, `残りが読めていない: ${r.content}`);
    assert.match(r.content, /読めないバイトが 1 か所/);
  });

  test('末尾で字が途中で切れた utf8 も、Shift_JIS と取り違えずに utf8 として読む', async () => {
    const root = await tempDir('aas-read-cut-');
    await writeFile(join(root, 'log.txt'), Buffer.concat([Buffer.from('記録を書いています\nあ'), Buffer.from([0xe3, 0x81])]));
    const r = await readFileTool.run({ path: 'log.txt' }, ctx(root));
    assert.equal(r.isError, undefined, r.content);
    assert.match(r.content, /1\t記録を書いています/, `utf8 として読んでいない: ${r.content}`);
  });

  test('utf8 の文字（BOM つきも）は、これまでどおり行番号つきで、添え書きなしに読める', async () => {
    const root = await tempDir('aas-read-utf8-');
    await writeFile(join(root, 'a.txt'), '\uFEFFあ\nい\n');
    const r = await readFileTool.run({ path: 'a.txt' }, ctx(root));
    assert.equal(r.isError, undefined, r.content);
    // 終わりの改行の後ろに行は無い（無い 3 行目を数えていた。DECISIONS 37 回目）
    assert.equal(r.content, '1\t\uFEFFあ\n2\tい');
  });

  test('二進と言われたあとも、読んでから書く規則は全文の置き換えを止めない', async () => {
    const root = await tempDir('aas-read-then-write-');
    await writeFile(join(root, 'a.bin'), Buffer.from('a\0b'));
    const harness = new Harness({ rules: [readBeforeWrite] });
    const [read, write] = harness.wrapAll([readFileTool, writeFileTool], () => '');
    assert.equal((await read!.run({ path: 'a.bin' }, ctx(root))).isError, true, '前提: 読めてしまった');
    const w = await write!.run({ path: 'a.bin', content: 'text\n' }, ctx(root));
    assert.doesNotMatch(w.content, /BLOCKED/, `読んだのに止められた: ${w.content}`);
  });

  test('search_text は二進の中を探さず見ていない数を言い、Shift_JIS の中は探す', async () => {
    const root = await tempDir('aas-search-bin-');
    await writeFile(join(root, 'a.bin'), Buffer.concat([Buffer.from('needle '), Buffer.from([0, 0xff, 0xfe]), Buffer.from('\n')]));
    await writeFile(join(root, 'b.txt'), 'needle です\n');
    await writeFile(join(root, 'c.txt'), Buffer.concat([Buffer.from('needle '), Buffer.from([0x82, 0xa0, 0x82, 0xa2, 0x82, 0xa4, 0x0a])]));
    const r = await searchTextTool.run({ query: 'needle' }, ctx(root));
    assert.doesNotMatch(r.content, /\uFFFD/, '化けた字を渡した');
    assert.doesNotMatch(r.content, /a\.bin:/, '二進の中を当たりとして返した');
    assert.match(r.content, /b\.txt:1: needle です/, 'utf8 のファイルの当たりが消えた');
    assert.match(r.content, /c\.txt:1: needle あいう/, 'Shift_JIS のファイルの中を探していない');
    assert.match(r.content, /二進のため見ていないファイルが 1 個/, '見ていないことを言っていない');
  });
});

describe('@ の指名も read_file と同じ読み方', () => {
  test('Shift_JIS は Shift_JIS として読み、二進は中身を入れずに読めないと言う', async () => {
    const root = await tempDir('aas-mention-enc-');
    await writeFile(join(root, 'sjis.txt'), Buffer.from([0x82, 0xa0, 0x82, 0xa2, 0x82, 0xa4, 0x0a]));
    await writeFile(join(root, 'a.bin'), Buffer.from('a\0b'));
    const reads = await readMentions('@sjis.txt と @a.bin を見て', root);
    const sjis = reads.find((r) => r.path === 'sjis.txt');
    assert.ok(sjis?.ok, `読めていない: ${JSON.stringify(reads)}`);
    assert.match(sjis!.body, /あいう/);
    assert.match(sjis!.body, /Shift_JIS として読みました/);
    const bin = reads.find((r) => r.path === 'a.bin');
    assert.equal(bin?.ok, false, `二進を読んだことにした: ${JSON.stringify(bin)}`);
    assert.match(bin!.body, /二進/);
  });
});

describe('Shift_JIS を読めるか（doctor が言う）', () => {
  test('この Node では読める。作れない Node（small-icu）では読めないと返す', () => {
    assert.equal(shiftJisSupported(), true, 'この機械の Node で読めないことになった');
    const noIcu = (label: string): { decode(bytes: Uint8Array): string } => { throw new RangeError(`The "${label}" encoding is not supported`); };
    assert.equal(shiftJisSupported(noIcu), false);
  });
});

describe('大きいファイルを一部ずつ読む', () => {
  test('丸ごとは断るが、範囲を付ければ読める（行番号はファイルの中の本当の番号）', async () => {
    const root = await tempDir('aas-read-big-');
    const lines = Array.from({ length: 60_000 }, (_, i) => `line ${i + 1} ${'x'.repeat(10)}`);
    await writeFile(join(root, 'big.log'), `${lines.join('\n')}\n`);
    const whole = await readFileTool.run({ path: 'big.log' }, ctx(root));
    assert.equal(whole.isError, true);
    assert.match(whole.content, /ファイルが大きすぎます.*offset と limit/);
    const part = await readFileTool.run({ path: 'big.log', offset: 50_000, limit: 2 }, ctx(root));
    assert.equal(part.isError, undefined, part.content);
    assert.match(part.content, /^50000\tline 50000 /m);
    assert.match(part.content, /^50001\tline 50001 /m);
  });
});
