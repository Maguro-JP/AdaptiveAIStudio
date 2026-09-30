/**
 * 作業指示書を読んで確かめる所（`parseTasks`）。入口はモデルを起こす前にこれを呼ぶ。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseTasks } from '../src/core/team-setup.ts';

describe('作業指示書を読む', () => {
  test('揃っていれば、そのまま返す', () => {
    const items = parseTasks(JSON.stringify([{ id: 't1', laneId: 'default', instruction: 'x' }]), ['default']);
    assert.deepEqual(items.map((i) => i.id), ['t1']);
  });

  test('読めない・並びでない・欠けている・知らないレーンは、理由を言って投げる', () => {
    assert.throws(() => parseTasks('[{', ['default']), /JSON として読めません/);
    assert.throws(() => parseTasks('{}', ['default']), /並び/);
    assert.throws(() => parseTasks(JSON.stringify([{ id: 't1' }]), ['default']), /揃っていません/);
    assert.throws(() => parseTasks(JSON.stringify([{ id: 't1', laneId: 'x', instruction: 'y' }]), ['default']), /レーン "x"/);
  });
});
