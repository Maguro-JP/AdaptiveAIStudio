/**
 * 会話の頭が人の依頼でないときの刈り込み（95 回目の調査）。
 *
 * 頭に挨拶・要約などの assistant の発言があり全部が入るとき、最初の依頼を二度並べ、頭の発言を知らせも無く落としていた。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitToWindow } from '../src/agent/window.ts';

test('頭に依頼以外があっても、全部入るならそのまま渡す（最初の依頼を二度並べない）', () => {
  const history = [
    { role: 'assistant' as const, content: 'こんにちは' },
    { role: 'user' as const, content: '依頼A' },
    { role: 'assistant' as const, content: 'ok' },
  ];
  const r = fitToWindow(history, 1000);
  assert.equal(r.messages.filter((m) => m.content === '依頼A').length, 1, JSON.stringify(r.messages));
  assert.deepEqual(r.messages.map((m) => m.content), ['こんにちは', '依頼A', 'ok']);
  assert.equal(r.trimmed, false);
});
