/** CLI の `/system` などの引数を、打ったとおりに渡す（DECISIONS 10-10、98 回目の調査）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitSlash } from '../src/cli/slash.ts';

test('続いた空白とタブを詰めずに渡す', () => {
  assert.deepEqual(splitSlash('/system 答えは  "A  B"\tの形で'), { cmd: '/system', arg: '答えは  "A  B"\tの形で' });
});

test('引数が無ければ空', () => {
  assert.deepEqual(splitSlash('/help'), { cmd: '/help', arg: '' });
  assert.deepEqual(splitSlash('/model   p:m  '), { cmd: '/model', arg: 'p:m' });
});
