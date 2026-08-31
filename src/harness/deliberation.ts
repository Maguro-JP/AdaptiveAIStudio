/**
 * 協議 — 重大な変更を、独りで決めさせない。
 *
 * 小さな変更は止めない方がよい。いちいち相談させれば作業は進まないし、
 * 「毎回聞かれるもの」は読まれなくなって、結局は素通りする。
 *
 * だから止めるのは**重大な変更だけ**にする。重大とは、間違えたときに
 * 自分では気づけなくなるもの —— 守りの仕掛けそのものと、広範囲の書き換え。
 *
 * 止め方は「禁止」ではなく「先に議題に出せ」。案・理由・影響・戻し方を
 * 言葉にできない変更は、たいてい本人も分かっていない。
 * 出せたなら通す。判断を奪うのではなく、判断を残させるための関所。
 */
import { minimatch } from './glob.ts';
import { type Rule, allow, deny, argString } from './rules.ts';
import type { ToolCall } from '../providers/contract.ts';

/**
 * 守りの仕掛けそのもの。
 * ここを書き換えられると、以後の検査がすべて無意味になる。
 * 「テストを消して通す」と同じことを、規則の側でやられると誰も気づけない。
 */
export const GUARDED_PATHS = [
  'src/harness/gate.ts',
  'src/harness/rules.ts',
  'src/harness/builtin-rules.ts',
  'src/harness/deliberation.ts',
  'src/harness/harness.ts',
  'src/harness/audit.ts',
  'src/core/harness-setup.ts',
  'src/agent/tools/paths.ts',
  'src/agent/tools/network.ts',
];

export function isGuarded(rel: string): boolean {
  const path = rel.split('\\').join('/').replace(/^\.\//, '');
  return GUARDED_PATHS.some((p) => minimatch(path, p));
}

/** 協議の記録。言葉にさせるための項目で、飾りはない。 */
export interface Proposal {
  /** 何を変えるか */
  subject: string;
  /** なぜ必要か */
  reason: string;
  /** 何に影響するか */
  impact: string;
  /** 間違いだったとき、どう戻すか */
  rollback: string;
  /** 対象ファイル（相対パス） */
  paths: string[];
  at: number;
}

/**
 * この依頼の中で開かれた協議。
 *
 * 依頼をまたいで持ち越さない。前の依頼で通した話を根拠に
 * 別の変更を通せてしまうと、記録の意味がなくなる。
 */
export class Forum {
  #open: Proposal[] = [];

  add(p: Proposal): void {
    this.#open.push(p);
  }

  /** その path について協議が開かれているか */
  covers(path: string): Proposal | undefined {
    const norm = path.split('\\').join('/').replace(/^\.\//, '');
    return this.#open.find((p) =>
      p.paths.some((q) => q.split('\\').join('/').replace(/^\.\//, '') === norm),
    );
  }

  list(): readonly Proposal[] {
    return this.#open;
  }

  clear(): void {
    this.#open = [];
  }
}

/** 記録として足りているか。空欄や一言で埋めた体裁だけの記録は受け取らない。 */
export function validateProposal(p: Partial<Proposal>): string | undefined {
  const need: Array<[keyof Proposal, string]> = [
    ['subject', '何を変えるか'],
    ['reason', 'なぜ必要か'],
    ['impact', '何に影響するか'],
    ['rollback', 'どう戻すか'],
  ];
  for (const [key, label] of need) {
    const v = p[key];
    if (typeof v !== 'string' || v.trim().length < 10) {
      return `${label}（${String(key)}）を、具体的に書いてください。`;
    }
  }
  if (!Array.isArray(p.paths) || p.paths.length === 0) {
    return '対象ファイル（paths）を挙げてください。';
  }
  return undefined;
}

export interface DeliberationOptions {
  forum: Forum;
  /** 何件以上の書き換えを重大とみなすか */
  wideChangeFiles?: number;
}

/**
 * 重大な変更を、協議を経ていない限り止める。
 *
 * 二種類を見る。
 *   ・守りの仕掛けへの書き換え（一件でも重大）
 *   ・広範囲の書き換え（件数で見る）
 */
export function requiresDeliberation(opts: DeliberationOptions): Rule {
  const wide = opts.wideChangeFiles ?? 8;
  const forum = opts.forum;

  return {
    name: 'requires-deliberation',
    description: '重大な変更は、協議の記録なしに実行させない',
    pre(call, ctx) {
      if (call.name !== 'write_file') return allow;
      const path = argString(call, 'path');
      if (!path) return allow;

      const guarded = isGuarded(path);
      const written = countWritten(ctx.history);
      const spreading = !written.has(path) && written.size >= wide;
      if (!guarded && !spreading) return allow;

      if (forum.covers(path)) return allow;

      const why = guarded
        ? `${path} は守りの仕掛けそのものです。ここが緩むと、以後の検査はすべて素通りになります。`
        : `この依頼で既に ${written.size} 件を書き換えています。範囲が広がりすぎです。`;

      return deny(
        `${why}\n` +
        'deliberate（協議）で、次を先に出してください: ' +
        '何を変えるか(subject) / なぜ必要か(reason) / 何に影響するか(impact) / どう戻すか(rollback) / 対象(paths)。\n' +
        '出せたらそのまま進められます。出せないなら、その変更はまだ決めるべきではありません。',
      );
    },
  };
}

function countWritten(history: readonly ToolCall[]): Set<string> {
  const s = new Set<string>();
  for (const c of history) {
    if (c.name !== 'write_file') continue;
    const p = argString(c, 'path');
    if (p) s.add(p);
  }
  return s;
}
