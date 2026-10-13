import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeOutput } from '../src/agent/shell-exec.ts';

test('utf8 の行の後に CP932 の行が続く出力は、両方の行を読める', () => {
  const sjis = Buffer.from([0x83, 0x74, 0x83, 0x40, 0x83, 0x43, 0x83, 0x8b]); // 「ファイル」
  const raw = Buffer.concat([Buffer.from('日本語の見出し\n', 'utf8'), sjis, Buffer.from('\n')]);
  assert.equal(decodeOutput(raw), '日本語の見出し\nファイル\n');
});

test('全部が utf8 なら、そのまま読む（行ごとに分けても変わらない）', () => {
  assert.equal(decodeOutput(Buffer.from('a\nいろは\n', 'utf8')), 'a\nいろは\n');
});
