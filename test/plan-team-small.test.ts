/** 小さいもの。それぞれ既存のファイルに足す想定（行頭の注に足し先）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropWriteIfOutbound } from '../src/roles/registry.ts';
import { BUILTIN_ROLES } from '../src/roles/builtin.ts';
import { parseTasks } from '../src/core/team-setup.ts';

// test/role-outbound.test.ts へ（05）
test('外へ出る道があれば、execute も落とす（run_command で書ける）', () => {
  assert.deepEqual(dropWriteIfOutbound(['read', 'execute', 'network']), { access: ['read', 'network'], dropped: true });
  assert.deepEqual(dropWriteIfOutbound(['read', 'execute']), { access: ['read', 'execute'], dropped: false });
});
test('組み込みの役職も、外へ出る道と execute を両方は持たない', () => {
  const bad = BUILTIN_ROLES.filter((r) => (r.access.includes('network') || r.access.includes('mcp'))
    && (r.access.includes('write') || r.access.includes('execute'))).map((r) => r.id);
  assert.deepEqual(bad, []);
});

// test/team-tasks.test.ts へ（06）
test('同じ id が二つある作業指示書は断る（後の方が黙って走らない）', () => {
  const text = JSON.stringify([
    { id: 't1', instruction: 'a', laneId: 'default' },
    { id: 't1', instruction: 'b', laneId: 'default' },
  ]);
  assert.throws(() => parseTasks(text, ['default']), /t1/);
});
test('知らない役職は断る（全部のツールで働かせない）', () => {
  const text = JSON.stringify([{ id: 't1', instruction: 'a', laneId: 'default', roleId: 'Scout' }]);
  assert.throws(() => parseTasks(text, ['default'], (id) => id === 'scout'), /Scout/);
  assert.doesNotThrow(() => parseTasks(text.replace('Scout', 'scout'), ['default'], (id) => id === 'scout'));
});

/*
 * test/team.test.ts へ（04）: Team は assign() が返した request を、担当のツールの ctx.request に届ける。
 * runTeam と同じ偽モデル（write_file を一回呼ぶ）を使い、write_file の偽物で ctx.request を拾って、
 * 担当ごとに別の入れ物（assign で作ったもの）であることを見る:
 *
 *   const seen = new Map<string, unknown>();
 *   const scopes = new Map<string, RequestScope>();
 *   const probe: Tool = { schema: writeFileTool.schema, run: async (args, ctx) => { seen.set((args as { path: string }).path, ctx.request); return { content: 'ok' }; } };
 *   assign: (roleId, item) => { const s = { instruction: () => 'x', history: [], forum: new Forum(), metricsKey: () => '' }; scopes.set(item.id, s); return { system: 's', tools: [probe], request: s }; }
 *   items: [{ id: 't1', roleId: 'worker', ... writes: ['a.txt'] }, { id: 't2', roleId: 'worker', ... writes: ['b.txt'] }]
 *   assert.equal(seen.get('a.txt'), scopes.get('t1')); assert.equal(seen.get('b.txt'), scopes.get('t2'));
 */
