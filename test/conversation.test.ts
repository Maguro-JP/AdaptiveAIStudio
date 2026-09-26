/**
 * 一つの会話が持つもの（`src/core/conversation.ts`）。
 *
 * 画面で二つの会話を同時に動かすため、`Session` から会話ごとの状態を分けた。
 * 二つの `Conversation` が互いの履歴・差分を持たないことと、積み直しで前の会話が残らないことを見る。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Conversation } from '../src/core/conversation.ts';

describe('一つの会話が持つもの', () => {
  test('二つの会話は、履歴も差分も分かれている', () => {
    const a = new Conversation();
    const b = new Conversation();
    a.history.push({ role: 'user', content: 'A' });
    a.diffs.set('x.ts', { diff: 'd', created: false });
    assert.deepEqual(b.history, []);
    assert.equal(b.diffs.size, 0);
  });

  test('積み直すと前のやりとりは残らず、切ると空になる', () => {
    const c = new Conversation();
    c.history.push({ role: 'user', content: '前の会話' });
    c.restore([{ role: 'user', content: '続き' }]);
    assert.deepEqual(c.history.map((m) => m.content), ['続き']);
    c.reset();
    assert.deepEqual(c.history, []);
  });

  test('走っているかは、止める手を持っているかで決まる', () => {
    const c = new Conversation();
    assert.equal(c.busy, false);
    c.running = new AbortController();
    assert.equal(c.busy, true);
  });
});
