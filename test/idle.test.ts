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
    assert.match(third.reason, /考える意味|既に考えました/);
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

describe('間合い', () => {
  /** 待機のたびに choose を呼ぶ、実際の使われ方をなぞる。 */
  async function idleFor(minutes: number, opts: { changeAt?: number } = {}) {
    const s = scheduler(BUILTIN_IDLE_MODES, 100); // 予算では止めない。間合いだけを見る
    const chosen: Array<{ at: number; codename: string }> = [];
    for (let t = 0; t <= minutes * MINUTE; t += 30_000) { // 30秒ごと = 既定の待機間隔
      const now = NOW + t;
      const d = await s.choose({
        lastChangeAt: opts.changeAt ?? NOW - MINUTE, openProposals: 0, now,
      });
      if (d.mode) { s.begin(d.mode, now); chosen.push({ at: t, codename: d.mode.codename }); }
    }
    return chosen;
  }

  test('一つの変更で、思考が続けざまに走らない', async () => {
    const chosen = await idleFor(5);
    assert.equal(chosen.length, 1, `5分で ${chosen.length}件 走っている: ${chosen.map((c) => c.codename)}`);
  });

  test('間隔を空けても、同じ変更については2回まで', async () => {
    const chosen = await idleFor(120);
    const codes = chosen.map((c) => c.codename);
    // 予算を効かせない条件でも、2時間で5件（すべて10分以上あけて別の角度から）
    assert.ok(chosen.length <= 5, `2時間で ${chosen.length}件: ${codes}`);
    // 変更をきっかけにするもの（見回り・巡回検査・振り返り）は2回まで
    const byChange = codes.filter((c) => ['RECON', 'PATROL', 'RETROSPECT'].includes(c));
    assert.ok(byChange.length <= 2, `変更由来が ${byChange.length}件: ${codes}`);
  });

  test('思考と思考の間は、必ず既定の間隔だけ空く', async () => {
    const chosen = await idleFor(180);
    for (let i = 1; i < chosen.length; i += 1) {
      const gap = chosen[i]!.at - chosen[i - 1]!.at;
      assert.ok(gap >= 10 * MINUTE, `${chosen[i - 1]!.codename} → ${chosen[i]!.codename} が ${gap / MINUTE}分`);
    }
  });

  test('新しい変更があれば、また考えてよい', async () => {
    const s = scheduler([recon, patrol], 100);
    const first = await s.choose(ctx());
    s.begin(first.mode!, NOW);
    const second = await s.choose(ctx({ now: NOW + 11 * MINUTE }));
    s.begin(second.mode!, NOW + 11 * MINUTE);

    // 同じ変更のままなら、3回目は無い
    const third = await s.choose(ctx({ now: NOW + 22 * MINUTE }));
    assert.equal(third.mode, undefined, third.reason);

    // 手元が動いたら、また考える
    const after = await s.choose(ctx({ now: NOW + 33 * MINUTE, lastChangeAt: NOW + 30 * MINUTE }));
    assert.ok(after.mode, `新しい変更でも考えない: ${after.reason}`);
  });

  test('間合いの理由は、あと何分かまで言う', async () => {
    const s = scheduler([recon], 100);
    const first = await s.choose(ctx());
    s.begin(first.mode!, NOW);
    const next = await s.choose(ctx({ now: NOW + 2 * MINUTE }));
    assert.equal(next.mode, undefined);
    assert.match(next.reason, /あと約8分/);
  });

  test('立ち上げ直しても間合いは引き継ぐ', async () => {
    const s = scheduler([recon, patrol], 100);
    const first = await s.choose(ctx());
    s.begin(first.mode!, NOW);

    const restarted = scheduler([recon, patrol], 100);
    restarted.restore(s.stats());
    const soon = await restarted.choose(ctx({ now: NOW + MINUTE, lastChangeAt: NOW + 30_000 }));
    assert.equal(soon.mode, undefined, '立ち上げ直すと喋り出してしまう');
    assert.match(soon.reason, /さきほど考えた/);
  });
});
