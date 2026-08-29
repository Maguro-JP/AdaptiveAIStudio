/**
 * IDLE SCHEDULER — 暇なときに何を考えるかを決める。
 *
 * 「暇なら考えて」は簡単だが、放っておくと無駄に考え続ける。
 * 計算が無料でも、成果の出ない思考は雑音を生み、利用者の時間を奪う。
 * 無料なのは電気代であって、**読む側の集中力ではない**。
 *
 * そこで、考える前に必ず3つを問う。
 *
 *   1. 前提: そもそも考える意味があるか（何か変わったか）
 *   2. 予算: 今日はもう考えすぎていないか
 *   3. 実績: この考え方は今まで役に立ったか
 *
 * 役に立った考え方には多く時間を配り、
 * 出しても無視され続ける考え方は自然に減らす。
 */

export type IdleModeId = string;

export interface IdleMode {
  id: IdleModeId;
  /** 英名。何をしている時間なのかが一目で分かるように。 */
  codename: string;
  name: string;
  /** 何を考える時間か */
  purpose: string;
  /**
   * 考える意味があるか。
   * 「変わっていないのに考え直す」を止める最初の関門。
   */
  precondition(ctx: IdleContext): Promise<boolean> | boolean;
  /** 最短の実行間隔(ms)。同じことを立て続けに考えない。 */
  cooldownMs: number;
  /** 1回あたりの想定コスト。予算配分に使う。 */
  cost: number;
  /** 実績が無いうちの優先度 */
  basePriority: number;
  /**
   * 日課からのみ起動する。
   *
   * 「前回分の確認」や「段取りの見直し」は、時間で起きるべきもので、
   * 気が向いたときに勝手に始めるものではない。
   * これを区別しないと、日課専用のモードが常時発火して予算を食う。
   */
  dutyOnly?: boolean;
}

export interface IdleContext {
  /** 最後に何かが変わった時刻（ファイル変更・作業完了など） */
  lastChangeAt: number;
  /** このモードを最後に実行した時刻 */
  lastRunAt?: number;
  /** 未処理の提案の数。溜まっていたら新しく考えない。 */
  openProposals: number;
  now: number;
}

export interface ModeStat {
  mode: IdleModeId;
  runs: number;
  /** 提案を出した回数 */
  produced: number;
  /** その提案が採用された回数 */
  accepted: number;
  /** 却下された回数 */
  rejected: number;
  lastRunAt?: number;
  spent: number;
}

export interface IdleBudget {
  /** 1時間あたりに使ってよい総コスト */
  perHour: number;
}

export interface Decision {
  mode?: IdleMode;
  /** 日課として選ばれた場合、そのID */
  dutyId?: string;
  /** 選ばなかった場合の理由。黙って何もしないと、壊れているのか休んでいるのか分からない。 */
  reason: string;
}

const HOUR = 3_600_000;

export class IdleScheduler {
  readonly #modes: IdleMode[];
  readonly #budget: IdleBudget;
  #stats = new Map<IdleModeId, ModeStat>();
  /** 直近1時間に使ったコストの記録 */
  #spending: Array<{ at: number; cost: number }> = [];

  constructor(modes: IdleMode[], budget: IdleBudget) {
    this.#modes = modes;
    this.#budget = budget;
  }

  stats(): ModeStat[] {
    return this.#modes.map((m) => this.#stat(m.id));
  }

  restore(stats: ModeStat[]): void {
    for (const s of stats) this.#stats.set(s.mode, s);
  }

  /** 今どれだけ使ったか。予算の残りを見せるため。 */
  spentThisHour(now: number): number {
    this.#spending = this.#spending.filter((s) => now - s.at < HOUR);
    return this.#spending.reduce((n, s) => n + s.cost, 0);
  }

  /**
   * 次に何を考えるかを選ぶ。
   * 選ばない判断も結果のうちなので、必ず理由を返す。
   */
  async choose(
    ctx: Omit<IdleContext, 'lastRunAt'>,
    /**
     * 今日まだやっていない日課。
     * 変化が無くてもやることがあるなら、そちらが先。
     * 「今日まだ全検査を回していない」は、コードが変わっていなくても有効な情報。
     */
    dueDuties: Array<{ dutyId: string; modeId: string; codename: string; isCatchUp: boolean }> = [],
  ): Promise<Decision> {
    const spent = this.spentThisHour(ctx.now);
    if (spent >= this.#budget.perHour) {
      return { reason: `この1時間の予算を使い切りました（${spent}/${this.#budget.perHour}）` };
    }

    // 未処理が溜まっているのに考え続けるのは、利用者を置き去りにしている
    if (ctx.openProposals >= 10) {
      return { reason: '未処理の提案が溜まっています。先にそちらを見てください' };
    }

    // 日課が残っているなら、変化を待たずにそちらを進める
    for (const duty of dueDuties) {
      const mode = this.#modes.find((m) => m.id === duty.modeId);
      if (!mode) continue;
      if (spent + mode.cost > this.#budget.perHour) continue;
      const stat = this.#stat(mode.id);
      if (stat.lastRunAt !== undefined && ctx.now - stat.lastRunAt < mode.cooldownMs) continue;
      return {
        mode, dutyId: duty.dutyId,
        reason: duty.isCatchUp
          ? `${duty.codename} の前回分が残っています`
          : `本日分の ${duty.codename} がまだです`,
      };
    }

    const candidates: Array<{ mode: IdleMode; score: number }> = [];
    for (const mode of this.#modes) {
      if (mode.dutyOnly) continue; // 日課としてしか動かない
      const stat = this.#stat(mode.id);
      const full: IdleContext = { ...ctx, lastRunAt: stat.lastRunAt };

      if (stat.lastRunAt !== undefined && ctx.now - stat.lastRunAt < mode.cooldownMs) continue;
      if (spent + mode.cost > this.#budget.perHour) continue;
      if (!(await mode.precondition(full))) continue;

      candidates.push({ mode, score: this.#score(mode, stat) });
    }

    if (candidates.length === 0) {
      return { reason: '今は考える意味のあることがありません' };
    }

    candidates.sort((a, b) => b.score - a.score);
    return { mode: candidates[0]!.mode, reason: '選択しました' };
  }

  /** 実行したことを記録する。 */
  begin(mode: IdleMode, now: number): void {
    const stat = this.#stat(mode.id);
    stat.runs += 1;
    stat.lastRunAt = now;
    stat.spent += mode.cost;
    this.#spending.push({ at: now, cost: mode.cost });
  }

  /** 提案を出したかどうか。出さなかったことも記録に残す。 */
  recordOutcome(mode: IdleModeId, produced: boolean): void {
    if (produced) this.#stat(mode).produced += 1;
  }

  /**
   * 利用者の反応。ここが実績の本体。
   * 出した数ではなく、採用された数で価値を測る。
   */
  recordVerdict(mode: IdleModeId, verdict: 'accepted' | 'rejected'): void {
    const stat = this.#stat(mode);
    if (verdict === 'accepted') stat.accepted += 1;
    else stat.rejected += 1;
  }

  /**
   * 優先度。
   *
   * 「出した数」ではなく「採用された数」で測る。
   * たくさん喋る人が役に立つとは限らない。
   */
  #score(mode: IdleMode, stat: ModeStat): number {
    const judged = stat.accepted + stat.rejected;
    if (judged === 0) {
      // まだ判断材料が無い。試させるが、走らせるほど少しずつ下げる。
      // 出しても反応が無いものを延々と回さないため。
      return mode.basePriority - stat.runs * 0.1;
    }
    const hitRate = stat.accepted / judged;
    // 実績と初期値を混ぜる。少ない判断で極端に振れないように。
    const weight = Math.min(1, judged / 5);
    return mode.basePriority * (1 - weight) + hitRate * 10 * weight;
  }

  #stat(id: IdleModeId): ModeStat {
    const existing = this.#stats.get(id);
    if (existing) return existing;
    const created: ModeStat = { mode: id, runs: 0, produced: 0, accepted: 0, rejected: 0, spent: 0 };
    this.#stats.set(id, created);
    return created;
  }
}

/** 人が読む形の要約。どの考え方が効いているかを見るため。 */
export function formatIdleStats(modes: IdleMode[], stats: ModeStat[]): string {
  const byId = new Map(stats.map((s) => [s.mode, s]));
  const lines = ['思考モード            実行  提案  採用  却下  採用率'];
  for (const m of modes) {
    const s = byId.get(m.id) ?? { runs: 0, produced: 0, accepted: 0, rejected: 0 };
    const judged = s.accepted + s.rejected;
    const rate = judged > 0 ? `${Math.round((s.accepted / judged) * 100)}%` : '—';
    lines.push(
      `${m.codename.padEnd(20)}${String(s.runs).padStart(4)}${String(s.produced).padStart(6)}` +
      `${String(s.accepted).padStart(6)}${String(s.rejected).padStart(6)}${rate.padStart(8)}`,
    );
  }
  return lines.join('\n');
}
