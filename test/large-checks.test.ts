/**
 * 大きいモデルの確かめ（scripts/check-large.mjs）は足すだけ（CLAUDE.md「ユーザーの決めたこと」）。
 * 一度載せた id（checks/large.ids）が消えた・飛ばす口が出来た、を止める。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const src = readFileSync(join(root, 'scripts', 'check-large.mjs'), 'utf8');
const ids = readFileSync(join(root, 'checks', 'large.ids'), 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const now = [...src.matchAll(/^\s+id: '([^']+)'/gm)].map((m) => m[1]!);

test('一度載せた id は、全部いまの確かめにある', () => {
  assert.deepEqual(ids.filter((id) => !now.includes(id)), []);
});
test('確かめの id は全部 checks/large.ids に記録してある', () => {
  assert.deepEqual(now.filter((id) => !ids.includes(id)), []);
});
test('絞る・飛ばす口が無い', () => {
  for (const flag of ['--only', '--skip', '--exclude', 'skip:', 'todo:']) assert.equal(src.includes(flag), false, flag);
});
test('CI の large が check-large を回す', () => {
  const ci = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(ci, /scripts\/check-large\.mjs/);
});
