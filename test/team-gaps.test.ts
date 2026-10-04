/**
 * 複数の担当で進める仕組みの抜け（16 回目の調査）。
 *
 * - レーンの parallel・maxTotalParallel の書き忘れ・0 を設定で断り、数でなければ 1 に倒す（永久に待ち、■ も効かなかった）
 * - 端末の `aas team` でも、書ける数の上限を依頼全体で数える（担当の数だけ増えていた）
 * - 役職を別の id で extends したとき、名前の履歴と引き継ぎを受け継がない
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { hideAasEnv } from './env.ts';
import { loadConfig, ConfigBroken, DEFAULT_CONFIG } from '../src/config.ts';
import { Scheduler } from '../src/core/scheduler.ts';
import { RoleRegistry } from '../src/roles/registry.ts';
import { wireTeam } from '../src/core/team-setup.ts';
import type { WorkItem } from '../src/agent/team.ts';

async function configWith(agent: Record<string, unknown>): Promise<string> {
  const dir = await tempDir('aas-team-cfg-');
  await writeFile(join(dir, 'aas.config.json'), JSON.stringify({
    providers: [{ id: 'local', kind: 'openai-compatible', locality: 'local', baseUrl: 'http://127.0.0.1:9/v1', enabled: true }],
    agent,
  }), 'utf8');
  return dir;
}

describe('並べる数の書き忘れ', () => {
  test('parallel の無いレーンを、設定で断る', async () => {
    const restore = hideAasEnv();
    try {
      const dir = await configWith({ lanes: [{ id: 'a', candidates: ['local:m'] }] });
      assert.throws(() => loadConfig(dir), (e: unknown) => e instanceof ConfigBroken && /parallel/.test(e.message));
    } finally { restore(); }
  });
  test('maxTotalParallel の 0 を、設定で断る', async () => {
    const restore = hideAasEnv();
    try {
      const dir = await configWith({ maxTotalParallel: 0 });
      assert.throws(() => loadConfig(dir), (e: unknown) => e instanceof ConfigBroken && /maxTotalParallel/.test(e.message));
    } finally { restore(); }
  });
  test('数でない parallel のレーンでも、走って終わる（1 に倒す）', async () => {
    const scheduler = new Scheduler([{ id: 'l', candidates: ['m'], parallel: undefined as never }]);
    const gen = scheduler.run([{ id: 't', laneId: 'l', run: async () => 'ok' }], new AbortController().signal);
    const done = (async () => { let n = await gen.next(); while (!n.done) n = await gen.next(); return n.value; })();
    const got = await Promise.race([done, new Promise((r) => setTimeout(() => r('timeout'), 3000))]);
    assert.notEqual(got, 'timeout', '待ったまま終わらない');
  });
});

describe('端末の team の書ける数の上限', () => {
  test('担当が違っても、依頼全体で数える', async () => {
    process.env.AAS_STATE_DIR = await tempDir('aas-team-gaps-state-');
    const root = await tempDir('aas-team-gaps-root-');
    try {
      const wired = await wireTeam({ ...DEFAULT_CONFIG, harness: { ...(DEFAULT_CONFIG.harness ?? {}), maxFilesPerTask: 1, readBeforeWrite: false } }, root);
      const item = (id: string): WorkItem => ({ id, laneId: 'coder', instruction: 'x' });
      const ctx = { root, signal: new AbortController().signal, approve: async () => true };
      const w1 = wired.toolsFor(item('t1')).find((t) => t.schema.name === 'write_file')!;
      const w2 = wired.toolsFor(item('t2')).find((t) => t.schema.name === 'write_file')!;
      assert.ok(!(await w1.run({ path: 'a.txt', content: 'a' }, ctx)).isError);
      assert.match((await w2.run({ path: 'b.txt', content: 'b' }, ctx)).content, /BLOCKED by blast-radius/);
      await wired.finish().catch(() => undefined);
    } finally {
      delete process.env.AAS_STATE_DIR;
    }
  });
});

describe('役職の extends', () => {
  test('別の id で extends した役職は、元の旧名と引き継ぎを受け継がない', () => {
    const roles = new RoleRegistry([
      { id: 'a', name: 'A', responsibility: 'r', disposition: 'd', access: ['read'], formerly: ['old'] },
      { id: 'b', extends: 'a' },
    ] as never);
    assert.equal(roles.get('old')?.id, 'a');
    assert.equal(roles.get('b')?.id, 'b');
  });
  test('引き継ぎ済みの役職を extends しても、作った役職は引き継ぎ済みにならない', () => {
    const roles = new RoleRegistry([
      { id: 'a', name: 'A', responsibility: 'r', disposition: 'd', access: ['read'], retired: true, succeededBy: 'c' },
      { id: 'c', name: 'C', responsibility: 'r', disposition: 'd', access: ['read'] },
      { id: 'b', extends: 'a' },
    ] as never);
    // 現役の一覧に入る（引き継ぎ済みを受け継ぐと外れ、作った役職に一度も割り当てが行かなかった）
    assert.ok(roles.active().some((r) => r.id === 'b'), JSON.stringify(roles.active().map((r) => r.id)));
  });
});
