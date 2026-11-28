/**
 * 種を渡せる乱数。同じ種なら同じ列が出る（札を再現するため。`Math.random` は使わない）。
 */
export interface Rng {
  /** 0 以上 1 未満。 */
  next(): number;
  /** 0 以上 n 未満の整数。 */
  int(n: number): number;
  choice<T>(items: readonly T[]): T;
  /** 重みに比例して 1 つ。重みの合計が 0 以下なら、同じ確からしさで選ぶ。 */
  weighted<T>(items: readonly T[], weights: readonly number[]): T;
  /** 重ならない k 個（順は乱数で決まる）。 */
  sample<T>(items: readonly T[], k: number): T[];
}

/** mulberry32。32 ビットの種 1 つで決まる。 */
export function rngFrom(seed: number): Rng {
  let a = (Math.floor(seed) >>> 0) || 0x9e3779b9;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number): number => Math.min(Math.max(0, Math.floor(n)) - 1, Math.floor(next() * n));
  const choice = <T>(items: readonly T[]): T => {
    if (items.length === 0) throw new Error('空の並びからは選べません');
    return items[int(items.length)]!;
  };
  return {
    next, int, choice,
    weighted<T>(items: readonly T[], weights: readonly number[]): T {
      const ws = items.map((_, i) => Math.max(0, weights[i] ?? 1));
      const total = ws.reduce((n, w) => n + w, 0);
      if (total <= 0) return choice(items);
      let at = next() * total;
      for (let i = 0; i < items.length; i += 1) {
        at -= ws[i]!;
        if (at < 0) return items[i]!;
      }
      return items[items.length - 1]!;
    },
    sample<T>(items: readonly T[], k: number): T[] {
      const pool = [...items];
      const out: T[] = [];
      while (out.length < k && pool.length > 0) out.push(pool.splice(int(pool.length), 1)[0]!);
      return out;
    },
  };
}

/** 種が渡されなかったときの種。時刻と呼んだ回数から作る（画面で「別の札」を押すたびに変わる）。 */
let drawn = 0;
export function freshSeed(now: number = Date.now()): number {
  drawn += 1;
  return ((now % 2147483647) + drawn * 7919) % 2147483647;
}
