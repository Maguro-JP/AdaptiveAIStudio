/**
 * 人に見せる時刻は日本時間。機械の時間帯に寄らないこと。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { jstDate, jstDateTime } from '../src/core/clock.ts';

describe('日本時間で見せる', () => {
  test('UTC の夕方は、日本では翌日', () => {
    assert.equal(jstDate('2026-09-01T15:30:00Z'), '2026-09-02');
  });
  test('UTC の昼は、日本でも同じ日（対）', () => {
    assert.equal(jstDate('2026-09-01T02:00:00Z'), '2026-09-01');
  });
  test('UTC の日付をそのまま見せると、ずれる（比べる相手）', () => {
    assert.equal(new Date('2026-09-01T15:30:00Z').toISOString().slice(0, 10), '2026-09-01');
  });
  test('時刻まで出すときも JST で、区切りは固定', () => {
    assert.equal(jstDateTime('2026-09-01T15:30:05Z'), '2026-09-02 00:30:05');
  });
});
