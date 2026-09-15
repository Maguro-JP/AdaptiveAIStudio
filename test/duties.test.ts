/**
 * 日課の検証。
 * 「今日まだやっていない」が分かること、
 * そして逃した分を溜め込まないことを確かめる。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DutyRoster, periodKey, formatDuties, type Duty } from '../src/harness/duties.ts';
import { BUILTIN_DUTIES } from '../src/harness/builtin-duties.ts';
import { IdleScheduler } from '../src/harness/idle.ts';
import { BUILTIN_IDLE_MODES } from '../src/harness/idle-modes.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** 2026-08-29(土) 10:00 を基準にする */
const at = (iso: string) => new Date(iso).getTime();
const SAT_10 = at('2026-08-29T10:00:00');

const daily: Duty = {
  id: 'sweep', codename: 'DAILY SWEEP', name: '全検査', purpose: 'x',
  cadence: { kind: 'daily', atHour: 0 }, modeId: 'patrol', importance: 9, catchUp: false,
};
const morning: Duty = {
  id: 'brief', codename: 'MORNING BRIEF', name: '朝の情報', purpose: 'x',
  cadence: { kind: 'daily', atHour: 7 }, modeId: 'briefing', importance: 6, catchUp: false,
};
const carry: Duty = {
  id: 'carry', codename: 'CARRY-OVER', name: '前回分', purpose: 'x',
  cadence: { kind: 'daily', atHour: 0 }, modeId: 'digest', importance: 8, catchUp: true,
};

describe('期の判定', () => {
  test('同じ日は同じ期', () => {
    const c = { kind: 'daily' as const };
    assert.equal(periodKey(c, at('2026-08-29T01:00:00')), periodKey(c, at('2026-08-29T23:00:00')));
  });

  test('日をまたげば別の期', () => {
    const c = { kind: 'daily' as const };
    assert.notEqual(periodKey(c, at('2026-08-29T23:00:00')), periodKey(c, at('2026-08-30T01:00:00')));
  });

  test('N時間ごとの期が区切られる', () => {
    const c = { kind: 'everyHours' as const, hours: 4 };
    assert.equal(periodKey(c, SAT_10), periodKey(c, SAT_10 + HOUR));
    assert.notEqual(periodKey(c, SAT_10), periodKey(c, SAT_10 + 5 * HOUR));
  });
});

describe('やっていないことが分かる', () => {
  test('今日まだやっていなければ発生する', () => {
    const r = new DutyRoster([daily]);
    const due = r.due(SAT_10);
    assert.equal(due.length, 1);
    assert.equal(due[0]!.duty.id, 'sweep');
  });

  test('今日やったなら発生しない', () => {
    const r = new DutyRoster([daily]);
    r.complete('sweep', SAT_10);
    assert.equal(r.due(SAT_10 + HOUR).length, 0);
  });

  test('翌日になればまた発生する', () => {
    const r = new DutyRoster([daily]);
    r.complete('sweep', SAT_10);
    assert.equal(r.due(SAT_10 + DAY).length, 1);
  });

  test('時刻が来るまでは発生しない', () => {
    const r = new DutyRoster([morning]); // 7時から
    const early = at('2026-08-29T05:00:00');
    assert.equal(r.due(early).length, 0, '時刻前なのに発生している');
    assert.equal(r.due(at('2026-08-29T08:00:00')).length, 1);
  });

  test('重要なものから順に並ぶ', () => {
    const r = new DutyRoster([morning, daily]); // importance 6, 9
    assert.equal(r.due(at('2026-08-29T10:00:00'))[0]!.duty.id, 'sweep');
  });
});

describe('逃した分の扱い', () => {
  test('前回分が抜けていれば、埋め合わせとして先に出る', () => {
    const r = new DutyRoster([carry, daily]);
    // 3日前に済ませたきり
    r.complete('carry', SAT_10 - 3 * DAY);
    r.complete('daily', SAT_10 - 3 * DAY);

    const due = r.due(SAT_10);
    assert.equal(due[0]!.duty.id, 'carry', '埋め合わせが後回しになっている');
    assert.equal(due[0]!.isCatchUp, true);
  });

  test('昨日やっていれば埋め合わせにはならない', () => {
    const r = new DutyRoster([carry]);
    r.complete('carry', SAT_10 - DAY);
    const due = r.due(SAT_10);
    assert.equal(due.length, 1);
    assert.equal(due[0]!.isCatchUp, false, '連続しているのに埋め合わせ扱いになっている');
  });

  test('埋め合わせしない日課は、逃しても普通の未了', () => {
    const r = new DutyRoster([daily]);
    r.complete('sweep', SAT_10 - 5 * DAY);
    assert.equal(r.due(SAT_10)[0]!.isCatchUp, false);
  });

  test('流したら、その期は終わったことにする', () => {
    const r = new DutyRoster([daily]);
    r.skip('sweep', SAT_10);
    assert.equal(r.due(SAT_10 + HOUR).length, 0, '流したのにまだ出てくる');
    assert.equal(r.records()[0]!.missed, 1);
  });
});

describe('状態の一覧', () => {
  test('済み・未了・待機が分かる', () => {
    const r = new DutyRoster([daily, morning]);
    r.complete('sweep', SAT_10);
    const text = formatDuties(r.status(SAT_10), SAT_10);
    assert.match(text, /DAILY SWEEP\s+済み/);
    assert.match(text, /MORNING BRIEF\s+未了/);
  });

  test('次回の時刻が出る', () => {
    const r = new DutyRoster([daily]);
    r.complete('sweep', SAT_10);
    assert.match(formatDuties(r.status(SAT_10), SAT_10), /時間後|日後/);
  });

  test('保存して読み直せる', () => {
    const r = new DutyRoster([daily]);
    r.complete('sweep', SAT_10);
    const restored = new DutyRoster([daily]);
    restored.restore(r.records());
    assert.equal(restored.due(SAT_10 + HOUR).length, 0);
  });
});

describe('スケジューラとの連携', () => {
  test('変化が無くても、日課が残っていれば動く', async () => {
    // 変化で起きるモードだけに絞る
    const changeDriven = BUILTIN_IDLE_MODES.filter((m) => ['patrol', 'recon'].includes(m.id));
    const s = new IdleScheduler([...changeDriven,
      ...BUILTIN_IDLE_MODES.filter((m) => m.dutyOnly)], { perHour: 20 });
    const ctx = { lastChangeAt: SAT_10 - 10 * DAY, openProposals: 0, now: SAT_10 };

    // 初回は基準を取るために一度ずつ走る。それを消化しておく。
    for (const m of changeDriven) s.begin(m, SAT_10 - HOUR);

    // 日課なし: 変化が無いので、もう考えない
    const idleOnly = await s.choose(ctx);
    assert.equal(idleOnly.mode, undefined, `変化が無いのに ${idleOnly.mode?.codename} を始めている`);

    // 日課あり: 変化が無くても動く
    const withDuty = await s.choose({ ...ctx, now: SAT_10 + 10 * HOUR }, [
      { dutyId: 'sweep', modeId: 'patrol', codename: 'DAILY SWEEP', isCatchUp: false },
    ]);
    assert.equal(withDuty.mode?.id, 'patrol');
    assert.equal(withDuty.dutyId, 'sweep');
    assert.match(withDuty.reason, /本日分の DAILY SWEEP がまだです/);
  });

  test('埋め合わせは理由が変わる', async () => {
    const s = new IdleScheduler(BUILTIN_IDLE_MODES, { perHour: 20 });
    const d = await s.choose(
      { lastChangeAt: SAT_10, openProposals: 0, now: SAT_10 },
      [{ dutyId: 'carry', modeId: 'digest', codename: 'CARRY-OVER', isCatchUp: true }],
    );
    assert.match(d.reason, /前回分が残って/);
  });

  test('日課でも予算は超えない', async () => {
    const s = new IdleScheduler(BUILTIN_IDLE_MODES, { perHour: 1 });
    const patrol = BUILTIN_IDLE_MODES.find((m) => m.id === 'patrol')!;
    s.begin(patrol, SAT_10);
    const d = await s.choose(
      { lastChangeAt: SAT_10, openProposals: 0, now: SAT_10 },
      [{ dutyId: 'sweep', modeId: 'patrol', codename: 'DAILY SWEEP', isCatchUp: false }],
    );
    assert.equal(d.mode, undefined, '日課だからと予算を無視している');
  });

  test('未処理が溜まっていれば日課より先に止める', async () => {
    const s = new IdleScheduler(BUILTIN_IDLE_MODES, { perHour: 20 });
    const d = await s.choose(
      { lastChangeAt: SAT_10, openProposals: 10, now: SAT_10 },
      [{ dutyId: 'sweep', modeId: 'patrol', codename: 'DAILY SWEEP', isCatchUp: false }],
    );
    assert.equal(d.mode, undefined);
    assert.match(d.reason, /溜まって/);
  });
});

describe('日課専用のモード', () => {
  test('日課でしか動かないモードは、単独では発火しない', async () => {
    const s = new IdleScheduler(BUILTIN_IDLE_MODES, { perHour: 100 });
    // 何度選んでも、日課専用のモードは出てこない
    for (let i = 0; i < 6; i += 1) {
      const d = await s.choose({ lastChangeAt: SAT_10, openProposals: 0, now: SAT_10 + i * HOUR });
      if (d.mode) {
        assert.equal(d.mode.dutyOnly, undefined,
          `${d.mode.codename} は日課専用なのに勝手に動いている`);
        s.begin(d.mode, SAT_10 + i * HOUR);
      }
    }
  });

  test('日課からなら動く', async () => {
    const s = new IdleScheduler(BUILTIN_IDLE_MODES, { perHour: 100 });
    const d = await s.choose(
      { lastChangeAt: SAT_10, openProposals: 0, now: SAT_10 },
      [{ dutyId: 'carry', modeId: 'digest', codename: 'CARRY-OVER', isCatchUp: false }],
    );
    assert.equal(d.mode?.id, 'digest');
  });
});

describe('組み込みの日課', () => {
  test('用意されている', () => {
    const ids = BUILTIN_DUTIES.map((d) => d.id);
    for (const id of ['daily-sweep', 'carry-over', 'plan-ahead', 'morning-brief', 'weekly-review']) {
      assert.ok(ids.includes(id), `${id} が無い`);
    }
  });

  test('全ての日課に対応する思考モードがある', () => {
    const modes = new Set(BUILTIN_IDLE_MODES.map((m) => m.id));
    for (const d of BUILTIN_DUTIES) {
      assert.ok(modes.has(d.modeId), `${d.id} の modeId ${d.modeId} が存在しない`);
    }
  });

  test('埋め合わせるのは、後から見ても意味のあるものだけ', () => {
    // 全検査は今日回せば足りる。前回分の確認は日をまたぐと見つけにくくなる。
    assert.equal(BUILTIN_DUTIES.find((d) => d.id === 'daily-sweep')!.catchUp, false);
    assert.equal(BUILTIN_DUTIES.find((d) => d.id === 'carry-over')!.catchUp, true);
  });
});
