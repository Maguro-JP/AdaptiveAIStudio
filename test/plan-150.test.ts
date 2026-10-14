import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judge } from '../src/agent/acceptance.ts';
import { repairPlan } from '../src/agent/pm.ts';

const base = { verified: 'passed' as const };

test('書くと言ったファイルが変わっていなければ、受け取らずに挙げる', () => {
  const r = judge({ ...base, declared: ['a.ts', 'b.ts'], changed: ['a.ts'], members: [] } as never);
  assert.equal(r.verdict, 'needsHuman');
  assert.ok(r.concerns.some((c) => /書くと言ったファイルが変わっていません/.test(c.reason) && c.where?.includes('b.ts')));
});

test('フォルダで宣言したものは、その下が変わっていれば書いたと数える', () => {
  const r = judge({ ...base, declared: ['src/'], changed: ['src/a.ts'], members: [] } as never);
  assert.ok(!r.concerns.some((c) => /書くと言ったファイル/.test(c.reason)), JSON.stringify(r.concerns));
});

test('件数の上限で畳むとき、書く仕事は書ける役職の件へ畳む', () => {
  const plan = repairPlan({
    items: [
      { id: 't1', instruction: '調べる', roleId: 'coder', writes: [] },
      { id: 't2', instruction: '調べる2', roleId: 'researcher' },
      { id: 't3', instruction: 'src/x.ts を書き換える', roleId: 'coder', writes: ['src/x.ts'] },
    ],
  }, '依頼', {
    lanes: [], roleIds: ['researcher', 'coder'], maxItems: 2,
    access: { researcher: ['read', 'network'], coder: ['read', 'write'] },
  } as never);
  const holder = plan.items.find((t) => (t.writes ?? []).includes('src/x.ts'));
  assert.equal(holder?.roleId, 'coder', JSON.stringify(plan.items));
});
