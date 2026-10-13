import { test } from 'node:test';
import assert from 'node:assert/strict';
import { symbolsIn } from '../src/agent/code-index.ts';

test('注釈の中の語は宣言として拾わない', () => {
  assert.deepEqual(symbolsIn('// このfunction parseConfig は b.ts に移した'), []);
  assert.deepEqual(symbolsIn(' * class Widget の説明'), []);
  assert.deepEqual(symbolsIn('# def old_name は消した'), []);
});

test('文字列の中の語は宣言として拾わない', () => {
  assert.deepEqual(symbolsIn('const msg = "class Widget is deprecated";'), ['msg']);
});

test('本物の宣言は今までどおり拾う（行末の注釈や私的なメソッドも）', () => {
  assert.deepEqual(symbolsIn('export function parseConfig(a: string) { // 読む'), ['parseConfig']);
  assert.ok(symbolsIn('  #drain(): void {').length > 0);
  assert.deepEqual(symbolsIn('def load(path):'), ['load']);
});
