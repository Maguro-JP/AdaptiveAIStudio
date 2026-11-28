/**
 * アイデアの拡張機能の確かめ（scripts/check-ideas.mjs）は足すだけ（CLAUDE.md「ユーザーの決めたこと」）。
 * 一度載せた id（checks/ideas.ids）が消えた・飛ばす口が出来た、を止める。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const src = readFileSync(join(root, 'scripts', 'check-ideas.mjs'), 'utf8');
const ids = readFileSync(join(root, 'checks', 'ideas.ids'), 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const now = [...src.matchAll(/^\s+id: '([^']+)'/gm)].map((m) => m[1]!);

test('一度載せた id は、全部いまの確かめにある', () => {
  assert.deepEqual(ids.filter((id) => !now.includes(id)), []);
});
test('確かめの id は全部 checks/ideas.ids に記録してある', () => {
  assert.deepEqual(now.filter((id) => !ids.includes(id)), []);
});
test('確かめは 14 件以上あり、id は重なっていない', () => {
  assert.ok(now.length >= 14, String(now.length));
  assert.equal(new Set(now).size, now.length);
});
test('絞る・飛ばす口が無い', () => {
  for (const flag of ['--only', '--skip', '--exclude', 'skip:', 'todo:']) assert.equal(src.includes(flag), false, flag);
});
test('CI の ideas が check-ideas を回す（入力 ideas のときだけ動くジョブ）', () => {
  const ci = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(ci, /scripts\/check-ideas\.mjs/);
  assert.match(ci, /^ {6}ideas:\n/m, '入力 ideas が無い');
  assert.match(ci, /^ {2}ideas:\n(?: {4}.*\n)*? {4}if: inputs\.ideas\n/m, 'ジョブ ideas が、入力 ideas で動く形になっていない');
});
test('ほかの入力で回すとき・ほかの入力が無いときの切り分けに、ideas が入っている', () => {
  const ci = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  // 普段の試験と bundle は、ideas だけを回すときには動かさない（large と同じ扱い）
  const guards = ci.split('\n').filter((l) => l.includes('!inputs.large'));
  assert.ok(guards.length >= 3, String(guards.length));
  assert.deepEqual(guards.filter((l) => !l.includes('!inputs.ideas')), []);
  assert.match(ci, /inputs\.ideas && 'ideas'/, '同時に回す組（concurrency）に ideas が無い');
});
