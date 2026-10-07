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
   * 何をきっかけに考えるか。
   *
   * change: 手元が変わったから考える（見回り・巡回検査・振り返り）
   * time:   時間が経ったから考える（外部情報・先読み・別案）
   *
   * 一つの変更で change のモードが総出になるのを抑えるために要る。
   * 既定は change。
   */
  triggeredBy?: 'change' | 'time';
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
  /**
   * 前の思考から、次の思考までに空ける最短の間隔(ms)。
   *
   * 予算だけでは「1時間ぶんを最初の数分で使い切る」を止められない。
   * 読む側にとっては、1時間に6回より、続けざまに6回の方がずっとうるさい。
   * 既定10分。
   */
  minGapMs?: number;
  /**
   * 同じ変更について、change のモードで考えてよい回数。
   *
   * 一つの変更は見回り・巡回検査・振り返りの前提を同時に満たす。
   * 全部を走らせても、見ているものはほぼ同じ。既定2回。
   */
  maxPerChange?: number;
  /** 未処理の提案がこの数に達したら、それ以上は考えない。既定 10（設定の `initiative.maxOpen`） */
  maxOpen?: number;
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
  /** 最後に何かを考えた時刻。モードを問わない。 */
  #lastThoughtAt?: number;
  /** いま数えている変更の時刻と、それについて考えた回数 */
  #changeStamp?: number;
  #thoughtsSinceChange = 0;

  constructor(modes: IdleMode[], budget: IdleBudget) {
    this.#modes = modes;
    this.#budget = budget;
  }

  stats(): ModeStat[] {
    return this.#modes.map((m) => this.#stat(m.id));
  }

  /**
   * 保存する実績。使っていないモードの分も含める（`stats()` は表示用で、設定で絞ったモードだけを並べる）。
   * `stats()` を保存していたので、モードを絞って一度保存すると、ほかのモードの採用・却下の実績がファイルから消えていた。
   */
  records(): ModeStat[] {
    const all = new Map(this.#stats);
    for (const m of this.#modes) all.set(m.id, this.#stat(m.id));
    return [...all.values()];
  }

  restore(stats: ModeStat[], now = Date.now()): void {
    // 形の違う一件（`null` 等）は、その一件だけ除く。そのまま入れると、途中で投げて残りを読まず、次の保存で消していた。
    if (!Array.isArray(stats)) return;
    const valid = stats.filter(isStat).map((s) => notAfter(s, now));
    for (const s of valid) this.#stats.set(s.mode, s);
    // 再起動しても間合いは引き継ぐ。立ち上げ直せば喋り出す、では意味がない。
    const last = valid.map((s) => s.lastRunAt ?? 0).reduce((a, b) => Math.max(a, b), 0);
    if (last > 0) this.#lastThoughtAt = Math.max(this.#lastThoughtAt ?? 0, last);
  }

  /**
   * 起動のときに読めなかった記録を、後から読めたときに足す。空で始めた間に数えた分は、その上に積む。
   * 置き換えると、その間の分か、それまでの実績のどちらかが消える。
   */
  absorb(stats: unknown, nowMs = Date.now()): void {
    this.rebase(stats, undefined, nowMs);
  }

  /**
   * ほかのプロセスが書いた記録を足す（`saveMerged`）。`seen` は、この実体が前に読んだ・書いた中身。
   * 足すのは、ファイルと `seen` の差（ほかが数えた分）だけ。`seen` が無ければファイルの分を全部足す（`absorb`）。
   * 丸ごと置き換えると、この実体が数えた分か、ほかが数えた分のどちらかが消える。
   */
  rebase(stats: unknown, seen: unknown, nowMs = Date.now()): void {
    if (!Array.isArray(stats)) return;
    const before = new Map((Array.isArray(seen) ? seen.filter(isStat) : []).map((s) => [s.mode, s]));
    for (const theirs of stats.filter(isStat).map((s) => notAfter(s, nowMs))) {
      const was = before.get(theirs.mode);
      const now = this.#stats.get(theirs.mode);
      if (!now) { this.#stats.set(theirs.mode, theirs); continue; }
      // 差が負（ほかが記録を消した・古い版で書き戻した）でも、この実体の数は 0 より下にしない
      const add = (k: 'runs' | 'produced' | 'accepted' | 'rejected' | 'spent') => {
        now[k] = Math.max(0, now[k] + theirs[k] - (was?.[k] ?? 0));
      };
      add('runs'); add('produced'); add('accepted'); add('rejected'); add('spent');
      const last = Math.max(now.lastRunAt ?? 0, theirs.lastRunAt ?? 0);
      if (last > 0) now.lastRunAt = last;
    }
    const last = [...this.#stats.values()].map((s) => s.lastRunAt ?? 0).reduce((a, b) => Math.max(a, b), 0);
    if (last > 0) this.#lastThoughtAt = Math.max(this.#lastThoughtAt ?? 0, last);
  }

  /** 次に考えてよくなる時刻。まだなら undefined。 */
  nextAllowedAt(): number | undefined {
    if (this.#lastThoughtAt === undefined) return undefined;
    return this.#lastThoughtAt + this.#minGap();
  }

  #minGap(): number {
    return this.#budget.minGapMs ?? 10 * 60_000;
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
  #clampToNow(now: number): void {
    if (this.#lastThoughtAt !== undefined && this.#lastThoughtAt > now) this.#lastThoughtAt = now;
    for (const stat of this.#stats.values()) if (stat.lastRunAt !== undefined && stat.lastRunAt > now) stat.lastRunAt = now;
    for (const s of this.#spending) if (s.at > now) s.at = now;
  }

  async choose(
    ctx: Omit<IdleContext, 'lastRunAt'>,
    /**
     * 今日まだやっていない日課。
     * 変化が無くてもやることがあるなら、そちらが先。
     * 「今日まだ全検査を回していない」は、コードが変わっていなくても有効な情報。
     */
    dueDuties: Array<{ dutyId: string; modeId: string; codename: string; isCatchUp: boolean }> = [],
  ): Promise<Decision> {
    /*
     * 時計が戻った（進んでいた時計を NTP が直した）とき、前の時刻が「今」より先に残る。差が負になると間合いも冷やしも明けず、
     * 時計が追いつくまで（何時間でも）考えも日課も止まっていた。読み込むときだけ揃えていたので、動いている間は効かなかった。
     * 「今」より先の時刻は、今に揃える
     */
    this.#clampToNow(ctx.now);
    const spent = this.spentThisHour(ctx.now);
    if (spent >= this.#budget.perHour) {
      return { reason: `この1時間の予算を使い切りました（${spent}/${this.#budget.perHour}）` };
    }

    // 間合い。予算が残っていても、続けざまには考えない。
    const gap = this.#minGap();
    if (this.#lastThoughtAt !== undefined && ctx.now - this.#lastThoughtAt < gap) {
      const left = Math.ceil((gap - (ctx.now - this.#lastThoughtAt)) / 60_000);
      return { reason: `さきほど考えたところです（あと約${left}分）` };
    }

    // 変更が変われば数え直す。同じ変更を何度も見に行かないため。
    if (this.#changeStamp !== ctx.lastChangeAt) {
      this.#changeStamp = ctx.lastChangeAt;
      this.#thoughtsSinceChange = 0;
    }
    const changeSpent = this.#thoughtsSinceChange >= (this.#budget.maxPerChange ?? 2);

    // 未処理が溜まっているのに考え続けるのは、利用者を置き去りにしている
    // 上限は設定から（前は 10 の決め打ちで、`initiative.maxOpen` を書いても効かなかった）
    if (ctx.openProposals >= Math.max(1, this.#budget.maxOpen ?? 10)) {
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
      // この変更については、もう十分に考えた
      if (changeSpent && (mode.triggeredBy ?? 'change') === 'change') continue;
      if (!(await mode.precondition(full))) continue;

      candidates.push({ mode, score: this.#score(mode, stat) });
    }

    if (candidates.length === 0) {
      return {
        reason: changeSpent
          ? 'この変更については既に考えました。次の変更を待ちます'
          : '今は考える意味のあることがありません',
      };
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
    this.#lastThoughtAt = now;
    if ((mode.triggeredBy ?? 'change') === 'change') this.#thoughtsSinceChange += 1;
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

/** 暇の実績の形。回数は有限で 0 以上、最後の時刻は数か無し。 */
function isStat(v: unknown): v is ModeStat {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  const count = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0;
  return typeof r.mode === 'string' && count(r.runs) && count(r.produced) && count(r.accepted)
    && count(r.rejected) && count(r.spent)
    && (r.lastRunAt === undefined || (typeof r.lastRunAt === 'number' && Number.isFinite(r.lastRunAt)));
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

/**
 * 記録の時刻が未来なら、いまに丸める。時計がずれていた間に書かれた記録（BIOS の時計を後で合わせた、など）が残ると、
 * その時刻を過ぎるまで「まだ間を置く」が続き、日課も含めて何も考えなくなっていた（「あと約 N 分」の N が巨大に出る）。
 */
function notAfter(s: ModeStat, now: number): ModeStat {
  return s.lastRunAt !== undefined && s.lastRunAt > now ? { ...s, lastRunAt: now } : s;
}
