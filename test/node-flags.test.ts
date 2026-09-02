/**
 * 旗が要る Node と要らない Node を、境目で見る。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { needsStripFlag } from '../src/core/node-flags.ts';

describe('型剥がしの旗', () => {
  test('要る版', () => {
    for (const v of ['v22.6.0', 'v22.17.9', 'v23.5.0', 'v20.0.0']) assert.equal(needsStripFlag(v), true, v);
  });
  test('要らない版（対）', () => {
    for (const v of ['v22.18.0', 'v23.6.0', 'v24.18.0', 'v25.0.0']) assert.equal(needsStripFlag(v), false, v);
  });
});
