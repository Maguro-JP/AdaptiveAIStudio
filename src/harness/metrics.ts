/**
 * ハーネス自身の計測。
 *
 * ハーネスが全てを決めるなら、ハーネスにこそ計測と調整が要る。
 * 規則は増やすほど良いのではない。締めすぎたハーネスはモデルの能力を殺し、
 * その状態は外から見ると「モデルが馬鹿」に見えるので、原因を取り違える。
 *
 * 良い規則と悪い規則は、拒否の後に何が起きたかで見分けられる。
 *
 *   拒否 → モデルが正しい手順に移った   良い規則（誘導できている）
 *   拒否 → そのまま作業が失敗した       悪い規則（邪魔をしている）
 *   一度も発動しない                    不要な規則（削る候補）
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface RuleStat {
  rule: string;
  /** 拒否した回数 */
  denials: number;
  /** 拒否の後、同じ依頼が最終的に完了した回数 */
  recovered: number;
  /** 拒否の後、同じ依頼が失敗・放棄された回数 */
  abandoned: number;
  /** 警告した回数 */
  warnings: number;
}

export interface TaskRecord {
  /** この依頼で拒否した規則（重複あり） */
  denialsByRule: string[];
  outcome: 'completed' | 'failed';
}

export interface HarnessReport {
  tasks: number;
  /** 拒否が一度も無かった依頼の割合 */
  cleanTaskRatio: number;
  rules: Array<RuleStat & {
    /** 拒否後に依頼が完了した割合。高いほど「誘導できている」 */
    recoveryRate: number;
    verdict: 'good' | 'suspect' | 'unused' | 'unknown';
    note: string;
  }>;
  advice: string[];
}

export class HarnessMetrics {
  readonly #path?: string;
  #stats = new Map<string, RuleStat>();
  #tasks = 0;
  #cleanTasks = 0;
  /**
   * 開いている依頼ごとの、拒否した規則。札で分ける（札を渡さない呼び方は '' の一つ）。
   *
   * 一つだけ持つと、並行して走る依頼の拒否が混ざる。別の依頼の始まりが、走っている依頼の拒否を消し、
   * 別の依頼の結末が、その拒否の良し悪しを決めてしまう。
   */
  #open = new Map<string, string[]>();

  constructor(path?: string) {
    this.#path = path;
  }

  async load(): Promise<void> {
    if (!this.#path) return;
    try {
      const raw = JSON.parse(await readFile(this.#path, 'utf8')) as {
        stats: RuleStat[]; tasks: number; cleanTasks: number;
      };
      this.#stats = new Map(raw.stats.map((s) => [s.rule, s]));
      this.#tasks = raw.tasks;
      this.#cleanTasks = raw.cleanTasks;
    } catch {
      // 記録が無いのは正常
    }
  }

  /** 依頼の開始。拒否の集計単位を切る。`key` は依頼の札（並行する依頼を見分ける）。 */
  beginTask(key = ''): void {
    this.#open.set(key, []);
  }

  recordDenial(rule: string, key = ''): void {
    const current = this.#open.get(key);
    if (current) current.push(rule);
    else this.#open.set(key, [rule]);
    this.#stat(rule).denials += 1;
  }

  recordWarning(rule: string): void {
    this.#stat(rule).warnings += 1;
  }

  /**
   * 依頼の終わり。
   * ここで初めて「その拒否が良かったのか」が分かる。
   */
  endTask(outcome: TaskRecord['outcome'], key = ''): void {
    const current = this.#open.get(key) ?? [];
    // 終えた札は閉じる。次の依頼に前の拒否を持ち越さない。
    this.#open.delete(key);
    this.#tasks += 1;
    if (current.length === 0) {
      this.#cleanTasks += 1;
      return;
    }
    // 同じ規則が複数回拒否しても、依頼としては1件と数える
    for (const rule of new Set(current)) {
      const stat = this.#stat(rule);
      if (outcome === 'completed') stat.recovered += 1;
      else stat.abandoned += 1;
    }
  }

  /** 発動しなかった規則も一覧に出す。「効いていない」ことが情報になる。 */
  report(knownRules: string[]): HarnessReport {
    const rules = knownRules.map((rule) => {
      const s = this.#stats.get(rule) ?? {
        rule, denials: 0, recovered: 0, abandoned: 0, warnings: 0,
      };
      const tasksWithDenial = s.recovered + s.abandoned;
      const recoveryRate = tasksWithDenial > 0 ? s.recovered / tasksWithDenial : 0;

      let verdict: 'good' | 'suspect' | 'unused' | 'unknown';
      let note: string;
      if (s.denials === 0) {
        verdict = 'unused';
        note = '一度も発動していません。不要か、条件が厳しすぎます。';
      } else if (tasksWithDenial < 3) {
        verdict = 'unknown';
        note = `判断にはまだ試行が足りません（${tasksWithDenial}件）。`;
      } else if (recoveryRate >= 0.7) {
        verdict = 'good';
        note = '拒否の後、作業は完了しています。正しく誘導できています。';
      } else {
        verdict = 'suspect';
        note = '拒否の後、作業が失敗しがちです。厳しすぎるか、理由の伝え方が悪い可能性があります。';
      }
      return { ...s, recoveryRate, verdict, note };
    });

    const advice: string[] = [];
    for (const r of rules) {
      if (r.verdict === 'suspect') {
        advice.push(`${r.rule}: 回復率 ${pct(r.recoveryRate)} — 緩めるか、拒否文言に次の手順を書き足してください。`);
      }
      if (r.verdict === 'unused' && this.#tasks >= 10) {
        advice.push(`${r.rule}: ${this.#tasks}件の依頼で一度も発動していません。削る候補です。`);
      }
    }
    const denialTaskRatio = this.#tasks > 0 ? 1 - this.#cleanTasks / this.#tasks : 0;
    if (this.#tasks >= 10 && denialTaskRatio > 0.6) {
      advice.push(
        `依頼の ${pct(denialTaskRatio)} で拒否が発生しています。` +
        'ハーネスが作業の邪魔をしている疑いがあります。',
      );
    }

    return {
      tasks: this.#tasks,
      cleanTaskRatio: this.#tasks > 0 ? this.#cleanTasks / this.#tasks : 0,
      rules,
      advice,
    };
  }

  async save(): Promise<void> {
    if (!this.#path) return;
    try {
      await mkdir(dirname(this.#path), { recursive: true });
      await writeFile(this.#path, JSON.stringify({
        stats: [...this.#stats.values()],
        tasks: this.#tasks,
        cleanTasks: this.#cleanTasks,
      }, null, 2), 'utf8');
    } catch {
      // 記録に失敗しても本体は止めない
    }
  }

  #stat(rule: string): RuleStat {
    const existing = this.#stats.get(rule);
    if (existing) return existing;
    const created: RuleStat = { rule, denials: 0, recovered: 0, abandoned: 0, warnings: 0 };
    this.#stats.set(rule, created);
    return created;
  }
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

/** 人が読む形の要約。 */
export function formatReport(r: HarnessReport): string {
  const lines: string[] = [];
  lines.push(`依頼 ${r.tasks} 件 / 拒否なしで完了 ${pct(r.cleanTaskRatio)}`);
  lines.push('');
  lines.push('規則                   拒否  回復  放棄  回復率  判定');
  for (const rule of r.rules) {
    lines.push(
      `${rule.rule.padEnd(22)}${String(rule.denials).padStart(4)}` +
      `${String(rule.recovered).padStart(6)}${String(rule.abandoned).padStart(6)}` +
      `${pct(rule.recoveryRate).padStart(8)}  ${verdictLabel(rule.verdict)}`,
    );
  }
  if (r.advice.length > 0) {
    lines.push('', '調整の提案:');
    lines.push(...r.advice.map((a) => `  ${a}`));
  }
  return lines.join('\n');
}

function verdictLabel(v: 'good' | 'suspect' | 'unused' | 'unknown'): string {
  return { good: '良好', suspect: '過剰の疑い', unused: '未発動', unknown: '判断保留' }[v];
}
