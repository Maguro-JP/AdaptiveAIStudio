/**
 * DUTIES — 日課。
 *
 * これまでの思考モードは「何かが変わったら考える」だった。
 * だが人の仕事にはもう一種類ある。**変わっていなくてもやること**。
 *
 *   今日まだ全部の検査を回していない
 *   今朝のニュースをまだ見ていない
 *   昨日の分を確認し損ねている
 *   この後の予定を組み直しておきたい
 *
 * これらは変化ではなく**時間**で起きる。
 * 「やることが決まっていて、やったかどうかが分かる」だけで、
 * 暇な時間が急に有効になる。
 *
 * 設計上の要点は、溜め込まないこと。
 * 逃した分を全部やり直そうとすると、朝から晩まで過去の埋め合わせになる。
 */

export type Cadence =
  /** 毎日。atHour を過ぎたら、その日の分が発生する。 */
  | { kind: 'daily'; atHour?: number }
  /** N時間ごと */
  | { kind: 'everyHours'; hours: number }
  /** 毎週。weekday は 0=日曜 */
  | { kind: 'weekly'; weekday: number; atHour?: number };

/**
 * いつ起きるかを、人が読む形にする。
 *
 * 画面には記録（いつ回ったか）しか出していなかったので、**まだ一度も回って
 * いないと何も出ず、何が仕込まれているのかも分からなかった。**いつ起きるかは
 * 日課の側が持っているので、ここで言葉にする。
 */
export function describeCadence(cadence: Cadence): string {
  const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
  if (cadence.kind === 'everyHours') return `${cadence.hours} 時間ごと`;
  const at = `${cadence.atHour ?? 0} 時`;
  if (cadence.kind === 'weekly') return `毎週${WEEK[cadence.weekday] ?? '?'}曜 ${at}`;
  return `毎日 ${at}`;
}

export interface Duty {
  id: string;
  codename: string;
  name: string;
  /** 何のための日課か */
  purpose: string;
  cadence: Cadence;
  /** 実行に使う思考モード */
  modeId: string;
  /** 重要度。溜まっているものの中での優先順位。 */
  importance: number;
  /**
   * 逃した分を後から埋めるか。
   * 埋めるのは**直近の1回だけ**。それ以上は流す。
   * 「昨日の分」は意味があるが、「先週の月曜の分」はもう意味がない。
   */
  catchUp: boolean;
}

export interface DutyRecord {
  dutyId: string;
  /** 最後に完了した期 */
  lastPeriod?: string;
  lastAt?: number;
  /** 完了した回数 */
  completions: number;
  /** 逃したまま流した回数 */
  missed: number;
}

export interface DutyStatus {
  duty: Duty;
  /** 今期の分が済んでいるか */
  doneThisPeriod: boolean;
  /** 今やるべきか */
  due: boolean;
  /** 逃した分の埋め合わせか */
  isCatchUp: boolean;
  /** 現在の期 */
  period: string;
  /** 次に発生する時刻 */
  nextAt: number;
  record: DutyRecord;
}

/** 期の識別子。同じ期に二度やらないための鍵。 */
export function periodKey(cadence: Cadence, at: number): string {
  const d = new Date(at);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');

  switch (cadence.kind) {
    case 'daily':
      return `${y}-${m}-${day}`;
    case 'everyHours': {
      // 何時間ごとかで区切る。0時起点で数える。
      const hoursSinceEpoch = Math.floor(at / 3_600_000);
      return `h${Math.floor(hoursSinceEpoch / cadence.hours)}`;
    }
    case 'weekly': {
      // その週の該当曜日を鍵にする
      const target = new Date(at);
      const diff = (d.getDay() - cadence.weekday + 7) % 7;
      target.setDate(d.getDate() - diff);
      return `w${target.getFullYear()}-${target.getMonth() + 1}-${target.getDate()}`;
    }
  }
}

/** その期の発生時刻。これを過ぎるまでは「まだ」。 */
function periodStart(cadence: Cadence, at: number): number {
  const d = new Date(at);
  switch (cadence.kind) {
    case 'daily': {
      const start = new Date(d);
      start.setHours(cadence.atHour ?? 0, 0, 0, 0);
      return start.getTime();
    }
    case 'everyHours': {
      const size = cadence.hours * 3_600_000;
      return Math.floor(at / size) * size;
    }
    case 'weekly': {
      const start = new Date(d);
      const diff = (d.getDay() - cadence.weekday + 7) % 7;
      start.setDate(d.getDate() - diff);
      start.setHours(cadence.atHour ?? 0, 0, 0, 0);
      return start.getTime();
    }
  }
}

function nextPeriodStart(cadence: Cadence, at: number): number {
  switch (cadence.kind) {
    case 'daily':
      return periodStart(cadence, at + 86_400_000);
    case 'everyHours':
      return periodStart(cadence, at) + cadence.hours * 3_600_000;
    case 'weekly':
      return periodStart(cadence, at + 7 * 86_400_000);
  }
}

export class DutyRoster {
  readonly #duties: Duty[];
  #records = new Map<string, DutyRecord>();

  constructor(duties: Duty[]) {
    this.#duties = duties;
  }

  duties(): Duty[] {
    return [...this.#duties];
  }

  records(): DutyRecord[] {
    return this.#duties.map((d) => this.#record(d.id));
  }

  restore(records: DutyRecord[]): void {
    for (const r of records) this.#records.set(r.dutyId, r);
  }

  /** 今の状況。何が済んでいて、何が残っているか。 */
  status(now: number): DutyStatus[] {
    return this.#duties.map((duty) => {
      const record = this.#record(duty.id);
      const period = periodKey(duty.cadence, now);
      const started = periodStart(duty.cadence, now);
      const doneThisPeriod = record.lastPeriod === period;

      // 今期が始まっていて、まだやっていないなら発生している
      const dueNow = now >= started && !doneThisPeriod;

      // 逃した分の埋め合わせ: 前回が今期でも前期でもない = 抜けている
      const previousPeriod = periodKey(duty.cadence, started - 1);
      const isCatchUp = duty.catchUp && !doneThisPeriod
        && record.lastPeriod !== undefined
        && record.lastPeriod !== previousPeriod
        && record.lastPeriod !== period;

      return {
        duty, record, period, doneThisPeriod,
        due: dueNow,
        isCatchUp,
        nextAt: doneThisPeriod ? nextPeriodStart(duty.cadence, now) : started,
      };
    });
  }

  /**
   * 今やるべき日課。重要なものから並べる。
   * 逃した分は、直近の1回だけ埋める。
   */
  due(now: number): DutyStatus[] {
    return this.status(now)
      .filter((s) => s.due)
      .sort((a, b) => {
        // 埋め合わせは通常分より先。「昨日の分」を残したまま今日を進めない。
        if (a.isCatchUp !== b.isCatchUp) return a.isCatchUp ? -1 : 1;
        return b.duty.importance - a.duty.importance;
      });
  }

  /** 完了を記録する。 */
  complete(dutyId: string, now: number): void {
    const duty = this.#duties.find((d) => d.id === dutyId);
    if (!duty) return;
    const record = this.#record(dutyId);
    record.lastPeriod = periodKey(duty.cadence, now);
    record.lastAt = now;
    record.completions += 1;
  }

  /**
   * 逃したまま流す。
   * 埋め合わせを諦めることも記録に残す。何度も流れているなら日課の設定が悪い。
   */
  skip(dutyId: string, now: number): void {
    const duty = this.#duties.find((d) => d.id === dutyId);
    if (!duty) return;
    const record = this.#record(dutyId);
    record.lastPeriod = periodKey(duty.cadence, now);
    record.missed += 1;
  }

  #record(dutyId: string): DutyRecord {
    const existing = this.#records.get(dutyId);
    if (existing) return existing;
    const created: DutyRecord = { dutyId, completions: 0, missed: 0 };
    this.#records.set(dutyId, created);
    return created;
  }
}

/** 人が読む形の一覧。「今日やったこと・やっていないこと」が分かるように。 */
export function formatDuties(statuses: DutyStatus[], now: number): string {
  const lines = ['日課                  状態        次回'];
  for (const s of statuses) {
    const state = s.doneThisPeriod ? '済み'
      : s.isCatchUp ? '未了（前回分）'
      : s.due ? '未了'
      : '待機';
    const next = s.doneThisPeriod || !s.due
      ? formatWhen(s.nextAt, now)
      : 'いま';
    lines.push(`${s.duty.codename.padEnd(20)}${state.padEnd(14)}${next}`);
  }
  return lines.join('\n');
}

function formatWhen(at: number, now: number): string {
  const diff = at - now;
  if (diff <= 0) return 'いま';
  const minutes = Math.round(diff / 60_000);
  if (minutes < 60) return `${minutes}分後`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}時間後`;
  return `${Math.round(hours / 24)}日後`;
}
