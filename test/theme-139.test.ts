import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSafeValue, repairTheme } from '../src/ui/theme.ts';

test('画面を潰す大きさ・改行・注釈の開きは通さない', () => {
  for (const v of ['99999px', '1e9', '0 0 0 100000px red', 'red\nblue', 'red /* x']) assert.equal(isSafeValue(v), false, v);
});

test('普通の色と寸法は通す', () => {
  for (const v of ['#1c2029', '14px', '1.55', 'rgb(255 0 0)', 'oklch(0.7 0.1 250)', 'calc(var(--radius) - 3px)', '0 8px 24px rgba(0,0,0,.4)']) {
    assert.equal(isSafeValue(v), true, v);
  }
});

test('効果の指定が配列でないときは、黙らずに言う', () => {
  const { repairs } = repairTheme({ id: 'slate', effects: 'nope' });
  assert.ok(repairs.some((r) => /効果の指定が読めない/.test(r.detail)));
});

test('名前は 80 字までにする', () => {
  const { theme } = repairTheme({ id: 'x'.repeat(5000) });
  assert.equal(theme.id.length, 80);
});
