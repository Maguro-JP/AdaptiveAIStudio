/**
 * 組み込みの日課。
 *
 * 「変わっていないからやらない」で済まないものを、ここに置く。
 * 時間で起き、済んだかどうかが記録される。
 */
import type { Duty } from './duties.ts';

/** 一日の始めに全部の検査を回す。 */
export const dailySweep: Duty = {
  id: 'daily-sweep',
  codename: 'DAILY SWEEP',
  name: '本日の全検査',
  purpose: '今日まだ一度も全体の検査を回していないなら、回しておく。',
  cadence: { kind: 'daily', atHour: 0 },
  modeId: 'patrol',
  importance: 9,
  // 昨日回していなくても、今日回せば足りる
  catchUp: false,
};

/** 朝の情報収集。 */
export const morningBrief: Duty = {
  id: 'morning-brief',
  codename: 'MORNING BRIEF',
  name: '朝の外部情報',
  purpose: '依存の更新や既知の不具合など、外の動きを一日一度確認する。',
  cadence: { kind: 'daily', atHour: 7 },
  modeId: 'briefing',
  importance: 6,
  catchUp: false,
};

/**
 * 前回からの変更を通しで見る。
 * これは埋め合わせる価値がある。見落としは日をまたぐと見つけにくくなる。
 */
export const carryOver: Duty = {
  id: 'carry-over',
  codename: 'CARRY-OVER',
  name: '前回分の確認',
  purpose: '前回の確認以降に入った変更を、まとめて見直す。',
  cadence: { kind: 'daily', atHour: 0 },
  modeId: 'digest',
  importance: 8,
  catchUp: true,
};

/** この先の段取りを組み直す。 */
export const planAhead: Duty = {
  id: 'plan-ahead',
  codename: 'PLAN AHEAD',
  name: '段取りの見直し',
  purpose: '溜まっている提案と残作業を見て、次の順番を決め直す。',
  cadence: { kind: 'everyHours', hours: 4 },
  modeId: 'agenda',
  importance: 7,
  catchUp: false,
};

/** 週に一度、大きく振り返る。 */
export const weeklyReview: Duty = {
  id: 'weekly-review',
  codename: 'WEEKLY REVIEW',
  name: '週次の振り返り',
  purpose: '一週間の変更を振り返り、方針からずれていないかを見る。',
  cadence: { kind: 'weekly', weekday: 1, atHour: 9 },
  modeId: 'retrospect',
  importance: 5,
  catchUp: true,
};

export const BUILTIN_DUTIES: Duty[] = [
  dailySweep, carryOver, planAhead, morningBrief, weeklyReview,
];
