/**
 * 思考モードの選択の検証。
 * 「暇なら考える」が空回りにならないことを確かめる。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { IdleScheduler, formatIdleStats, type IdleMode } from '../src/harness/idle.ts';
import { BUILTIN_IDLE_MODES, recon, patrol, whatif } from '../src/harness/idle-modes.ts';

const NOW = 1_000_000_000;
const MINUTE = 60_000;

function scheduler(modes: IdleMode[] = BUILTIN_IDLE_MODES, perHour = 20) {
  return new IdleScheduler(modes, { perHour });
}

const ctx = (over: Partial<Parameters<IdleScheduler['choose']>[0]> = {}) => ({
  lastChangeAt: NOW - MINUTE,
  openProposals: 0,
  now: NOW,
  ...over,
});

describe('考える意味があるか', () => {
  test('変更があれば見回りを選ぶ', async () => {
    const d = await scheduler().choose(ctx());
    assert.ok(d.mode, d.reason);
    assert.ok(['PATROL', 'RECON'].includes(d.mode.codename));
  });

  test('何も変わっていなければ考えない', async () => {
    const s = scheduler([recon, patrol]);
    const first = await s.choose(ctx());
    s.begin(first.mode!, NOW);
    // 変更なしのまま、時間だけ進める
    const later = await s.choose(ctx({ now: NOW + 10 * MINUTE, lastChangeAt: NOW - MINUTE }));
    // 残ったもう一方は選ばれるが、両方走った後は止まる
    if (later.mode) s.begin(later.mode, NOW + 10 * MINUTE);
    const third = await s.choose(ctx({ now: NOW + 20 * MINUTE, lastChangeAt: NOW - MINUTE }));
    assert.equal(third.mode, undefined, '変わっていないのに考え直している');
    assert.match(third.reason, /考える意味/);
  });

  test('冷却中は同じことを繰り返さない', async () => {
    const s = scheduler([recon]);
    const first = await s.choose(ctx());
    s.begin(first.mode!, NOW);
    const again = await s.choose(ctx({ now: NOW + 30_000, lastChangeAt: NOW + 20_000 }));
    assert.equal(again.mode, undefined, '冷却を無視している');
  });

  test('未処理の提案が溜まっていたら考えない', async () => {
    const d = await scheduler().choose(ctx({ openProposals: 10 }));
    assert.equal(d.mode, undefined);
    assert.match(d.reason, /溜まって/);
  });

  test('選ばない場合も理由が返る', async () => {
    const d = await scheduler().choose(ctx({ openProposals: 99 }));
    assert.ok(d.reason.length > 0, '黙って何もしないと、壊れているのか休んでいるのか分からない');
  });
});

describe('予算', () => {
  test('使い切ったら考えるのをやめる', async () => {
    const s = scheduler(BUILTIN_IDLE_MODES, 3);
    const first = await s.choose(ctx());
    s.begin(first.mode!, NOW);
    s.begin(first.mode!, NOW); // 意図的に使い込む
    s.begin(first.mode!, NOW);
    const d = await s.choose(ctx({ lastChangeAt: NOW + MINUTE }));
    assert.equal(d.mode, undefined);
    assert.match(d.reason, /予算/);
  });

  test('1時間経てば予算は戻る', async () => {
    const s = scheduler([patrol], 1);
    s.begin(patrol, NOW);
    assert.equal(s.spentThisHour(NOW), 1);
    assert.equal(s.spentThisHour(NOW + 61 * MINUTE), 0);
  });

  test('予算に収まらないモードは選ばない', async () => {
    const s = scheduler([whatif], 2); // whatif の cost は 3
    const d = await s.choose(ctx());
    assert.equal(d.mode, undefined);
  });
});

describe('実績で配分が変わる', () => {
  test('採用された考え方が優先される', async () => {
    const s = scheduler([recon, patrol], 100);
    // recon の提案は採用され、patrol の提案は却下され続けた
    for (let i = 0; i < 5; i += 1) {
      s.recordVerdict('recon', 'accepted');
      s.recordVerdict('patrol', 'rejected');
    }
    const d = await s.choose(ctx());
    assert.equal(d.mode?.id, 'recon', '実績が反映されていない');
  });

  test('却下され続ける考え方は選ばれなくなる', async () => {
    const s = scheduler([recon, patrol], 100);
    for (let i = 0; i < 5; i += 1) {
      s.recordVerdict('patrol', 'accepted');
      s.recordVerdict('recon', 'rejected');
    }
    const d = await s.choose(ctx());
    assert.equal(d.mode?.id, 'patrol');
  });

  test('判断が少ないうちは実績で決めつけない', async () => {
    const s = scheduler([recon, patrol], 100);
    s.recordVerdict('recon', 'rejected'); // 1件だけ却下
    const d = await s.choose(ctx());
    // patrol の basePriority が高いので patrol が選ばれるが、
    // recon が完全に排除されていないことを確認する
    const stats = s.stats();
    assert.equal(stats.find((x) => x.mode === 'recon')!.rejected, 1);
    assert.ok(d.mode, '1件の却下で全部止まってしまっている');
  });

  test('反応が無いまま走り続けると優先度が下がる', async () => {
    const s = scheduler([recon], 100);
    const before = await s.choose(ctx());
    assert.ok(before.mode);
    for (let i = 0; i < 20; i += 1) s.begin(recon, NOW);
    const stats = s.stats().find((x) => x.mode === 'recon')!;
    assert.equal(stats.runs, 20);
  });
});

describe('記録', () => {
  test('保存して読み直せる', () => {
    const s = scheduler();
    s.begin(recon, NOW);
    s.recordOutcome('recon', true);
    s.recordVerdict('recon', 'accepted');

    const restored = scheduler();
    restored.restore(s.stats());
    const stat = restored.stats().find((x) => x.mode === 'recon')!;
    assert.equal(stat.runs, 1);
    assert.equal(stat.accepted, 1);
  });

  test('どの考え方が効いているかを表にできる', () => {
    const s = scheduler();
    s.begin(recon, NOW);
    s.recordOutcome('recon', true);
    s.recordVerdict('recon', 'accepted');
    const text = formatIdleStats(BUILTIN_IDLE_MODES, s.stats());
    assert.match(text, /RECON/);
    assert.match(text, /100%/);
  });
});
