/**
 * 役職とコアの不具合（28 回目の調査）。
 *
 * - 日課の期は、選んだ時刻で決める（終えた時刻で決めると、日付をまたいだ回が翌日の分を済ませたことになる）
 * - 設定の役職の形が違っても、起動ごと落ちない
 * - 改名と同時に変えた権限も知らせる
 * - 実績の保存で、設定で絞ったモードの外の実績を消さない
 * - 補完の囲いを外すとき、先頭行の字下げを残す
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { tempDir } from './tmp.ts';
import { startFakeServer } from './fake-server.ts';
import { RoleRegistry } from '../src/roles/registry.ts';
import { RoleLedger } from '../src/roles/ledger.ts';
import { buildSystemPrompt, type Role } from '../src/roles/role.ts';
import { IdleScheduler } from '../src/harness/idle.ts';
import { BUILTIN_IDLE_MODES } from '../src/harness/idle-modes.ts';
import { BUILTIN_DUTIES } from '../src/harness/builtin-duties.ts';
import { periodKey } from '../src/harness/duties.ts';
import { cleanCompletion } from '../src/core/completion.ts';

const home = await tempDir('aas-roles-core-');
process.env.AAS_HOME = home;
process.env.AAS_STATE_DIR = join(home, 'state');
process.env.AAS_CONFIG = join(home, 'config.json');
const { Session } = await import('../src/core/session.ts');
type ThinkEvent = import('../src/core/session.ts').ThinkEvent;
const { DEFAULT_CONFIG } = await import('../src/config.ts');

describe('日課の期', () => {
  test('**日付をまたいで答え終えた回も、選んだ日の分を済ませたと記録する**', async () => {
    // 機械の時間帯の 23:58 に選び、答えている間に 0:03 になる
    const realNow = Date.now;
    const start = new Date(2026, 9, 4, 23, 58, 0).getTime();
    let offset = start - realNow();
    Date.now = () => realNow() + offset;
    // 時計のモックと偽の相手は、作る途中で投げても必ず戻す（同じファイルの残りの試験を、ずれた時計で走らせない）
    let fake: Awaited<ReturnType<typeof startFakeServer>> | undefined;
    let session: Awaited<ReturnType<typeof Session.create>> | undefined;
    try {
      fake = await startFakeServer({ kind: 'echo', delayFor: () => { offset += 5 * 60_000; return 0; } });
      const work = join(home, 'duty');
      await mkdir(work, { recursive: true });
      process.env.AAS_STATE_DIR = join(home, 'state-duty');
      const config = {
        ...DEFAULT_CONFIG,
        providers: [{ id: 'p', kind: 'openai-compatible', baseUrl: fake.baseUrl, locality: 'local', models: ['m'] }],
        candidates: ['p:m'], runtime: { kind: 'ollama' }, agent: { root: work, approval: 'auto' },
      } as typeof DEFAULT_CONFIG;
      session = await Session.create(config, { approve: () => Promise.resolve(true) });
      const seen: ThinkEvent[] = [];
      for await (const e of session!.think()) seen.push(e);
      const chose = seen.find((e) => e.type === 'chose') as { codename: string; isDuty: boolean } | undefined;
      assert.ok(chose?.isDuty, `日課を選んでいない（この試験の前提が崩れた）: ${JSON.stringify(seen)}`);
      assert.ok(offset > start - realNow(), '答えている間に時計が進んでいない（この試験の前提が崩れた）');
      // 済ませた日課（選んだのはモードの名前なので、記録の側から探す）
      const done = session!.duties.records().filter((r) => r.completions > 0);
      assert.equal(done.length, 1, `済ませた日課が一つでない: ${JSON.stringify(done)}`);
      const duty = BUILTIN_DUTIES.find((d) => d.id === done[0]!.dutyId)!;
      assert.equal(done[0]!.lastPeriod, periodKey(duty.cadence, start), `終えた時刻の期で記録した: ${JSON.stringify(done[0])}`);
    } finally {
      Date.now = realNow;
      await session?.close();
      await fake?.close();
    }
  });
});

describe('設定の役職の形', () => {
  test('**roles が並びでない・null の一件・id の無い一件で、起動ごと落ちない**', () => {
    const logs: string[] = [];
    assert.doesNotThrow(() => new RoleRegistry({ x: 1 } as never, (s) => logs.push(s)));
    assert.doesNotThrow(() => new RoleRegistry([null, {}, { name: 'x' }] as never, (s) => logs.push(s)));
    assert.ok(logs.some((l) => /並びではない/.test(l)), logs.join(' / '));
    assert.ok(logs.some((l) => /id の無い/.test(l)), logs.join(' / '));
  });
  test('**instructions・formerly が文字列でも、その役職を使うときに落ちない**（項目だけを外して言う）', () => {
    const logs: string[] = [];
    const reg = new RoleRegistry([{ id: 'x', extends: 'scout', instructions: 'a', formerly: 'scout' }] as never, (s) => logs.push(s));
    const x = reg.get('x');
    assert.ok(x, '役職ごと捨てた');
    assert.doesNotThrow(() => buildSystemPrompt(x!));
    assert.doesNotThrow(() => new RoleLedger().sync(reg.all()));
    assert.ok(logs.some((l) => /instructions/.test(l)) && logs.some((l) => /formerly/.test(l)), logs.join(' / '));
    assert.equal(reg.get('s'), undefined, 'formerly の一字ずつを別名にした');
  });
  test('**prefers の知らない値は外して言う。extends も項目も無い一件は、捨てた理由を言う**', () => {
    const logs: string[] = [];
    const reg = new RoleRegistry([{ id: 'x', extends: 'scout', prefers: 'turbo' }, { id: 'lonely', name: 'n' }] as never, (s) => logs.push(s));
    assert.equal(reg.get('x')?.prefers, reg.get('scout')?.prefers, '知らない値を通した');
    assert.ok(logs.some((l) => /prefers/.test(l)), logs.join(' / '));
    assert.ok(logs.some((l) => /lonely/.test(l)), `黙って捨てた: ${logs.join(' / ')}`);
  });
});

describe('名簿の改名', () => {
  const role = (over: Partial<Role> & { id: string }): Role => ({
    codename: over.id.toUpperCase(), name: '担当', responsibility: '責務', disposition: '姿勢',
    access: ['read'], instructions: ['a'], ...over,
  });
  test('**改名と同時に変えた権限も知らせる**', () => {
    const l = new RoleLedger();
    l.sync([role({ id: 'scout' })]);
    const changes = l.sync([role({ id: 'pathfinder', formerly: ['scout'], access: ['read', 'network'] })]);
    assert.ok(changes.some((c) => c.kind === 'renamed'), JSON.stringify(changes));
    assert.ok(changes.some((c) => c.kind === 'authorized'), `権限の変更を言っていない: ${JSON.stringify(changes)}`);
  });
  test('**formerly に今も名簿に居る役職を書いても、改名とは言わない**（居る役職との差分を変更として知らせない）', () => {
    const l = new RoleLedger();
    l.sync([role({ id: 'a' })]);
    const changes = l.sync([role({ id: 'a' }), role({ id: 'b', formerly: ['a'], access: ['read', 'network'] })]);
    assert.deepEqual(changes.map((c) => c.kind), ['joined'], JSON.stringify(changes));
  });
  test('改名だけなら、改名だけを言う（対）。次の起動では何も言わない', () => {
    const l = new RoleLedger();
    l.sync([role({ id: 'scout', codename: 'S' })]);
    const changes = l.sync([role({ id: 'pathfinder', codename: 'S', formerly: ['scout'] })]);
    assert.deepEqual(changes.map((c) => c.kind), ['renamed']);
    assert.deepEqual(l.sync([role({ id: 'pathfinder', codename: 'S', formerly: ['scout'] })]), []);
  });
});

describe('実績の保存', () => {
  test('**モードを絞っても、ほかのモードの実績を保存から落とさない**', () => {
    const two = new IdleScheduler(BUILTIN_IDLE_MODES.filter((m) => ['recon', 'patrol'].includes(m.id)), { perHour: 12 } as never);
    two.recordVerdict('patrol', 'accepted');
    two.recordVerdict('recon', 'rejected');
    const saved = JSON.parse(JSON.stringify(two.records()));
    const one = new IdleScheduler(BUILTIN_IDLE_MODES.filter((m) => m.id === 'recon'), { perHour: 12 } as never);
    one.restore(saved);
    const modes = one.records().map((s) => s.mode).sort();
    assert.deepEqual(modes, ['patrol', 'recon'], `保存から落とした: ${modes.join(',')}`);
    assert.deepEqual(one.stats().map((s) => s.mode), ['recon'], '表示は使っているモードだけ（対）');
  });
});

describe('補完の囲い', () => {
  test('**囲いを外しても、先頭行の字下げを残す**', () => {
    assert.equal(cleanCompletion('def f():\n', '```python\n    return 1\n```'), '    return 1');
  });
});
