/**
 * 人に見せる時刻は日本時間（JST）。
 *
 * 記録は ISO（UTC）でよいが、**見せるときは JST に直す**（CLAUDE.md）。
 * `toISOString().slice(0, 10)` は UTC の日付なので、日本の朝 9 時まで
 * 昨日の日付を見せる。実際にそうなっていた（記憶の一覧）。
 *
 * 機械の時間帯には寄らない。どの機械でも、同じ日付を出す。
 */
const ZONE = 'Asia/Tokyo';

const dateFmt = new Intl.DateTimeFormat('sv-SE', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const timeFmt = new Intl.DateTimeFormat('sv-SE', {
  timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});

/** YYYY-MM-DD（JST）。 */
export function jstDate(at: number | string | Date = Date.now()): string {
  // 読めない時刻（記録の壊れた値）で投げない。投げると、その一件で一覧ごと出せなくなる
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? '（日付不明）' : dateFmt.format(d);
}

/** YYYY-MM-DD HH:MM:SS（JST）。 */
export function jstDateTime(at: number | string | Date = Date.now()): string {
  // sv-SE は "2026-09-01 12:34:56" の形で出す。区切りを他の言語に依らせない。
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '（日時不明）';
  return timeFmt.format(d).replace('T', ' ');
}
