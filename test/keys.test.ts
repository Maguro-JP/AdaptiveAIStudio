/**
 * 日本語入力の途中の Enter で、送らない。
 *
 * Enter を送信と読んでいたので、変換を確定した瞬間に途中の文が送られていた。
 * 日本語で書く人には毎回起きる。変換中の Enter は isComposing が立つ
 * （keyCode 229）。それを見る。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSendKey, isPlainEnter } from '../src/ui/web/keys.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('Enter で送るか', () => {
  test('素の Enter は送る', () => {
    assert.equal(isSendKey({ key: 'Enter' }), true);
  });
  test('**変換中の Enter は送らない**', () => {
    assert.equal(isSendKey({ key: 'Enter', isComposing: true }), false);
    assert.equal(isSendKey({ key: 'Enter', keyCode: 229 }), false);
    assert.equal(isPlainEnter({ key: 'Enter', isComposing: true }), false);
  });
  test('Shift+Enter は改行なので送らない', () => {
    assert.equal(isSendKey({ key: 'Enter', shiftKey: true }), false);
  });
  test('Enter でなければ送らない', () => {
    assert.equal(isSendKey({ key: 'a' }), false);
    assert.equal(isPlainEnter({ key: 'a' }), false);
  });
});

describe('画面の Enter は、全部ここを通る', () => {
  test("画面の JS に、isComposing を見ない e.key === 'Enter' が無い", () => {
    const bad: string[] = [];
    for (const f of ['app.js', 'panels.js']) {
      const src = readFileSync(join(root, 'src/ui/web', f), 'utf8');
      for (const [i, line] of src.split('\n').entries()) {
        if (line.includes("e.key === 'Enter'")) bad.push(`${f}:${i + 1}: ${line.trim()}`);
      }
    }
    assert.deepEqual(bad, [], `変換中の Enter を送ってしまう:\n${bad.join('\n')}`);
  });
});
