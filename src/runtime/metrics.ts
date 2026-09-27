/**
 * 実測の蓄積。
 *
 * どのモデルが自分の環境で実際に速く・確実だったかは、
 * 諸元から推測するより、使った結果を記録する方が正確。
 * 「効率の良い運用」は、この記録があって初めて成立する。
 */
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ModelStats } from './efficiency.ts';
import { loadJournal, saveJournal } from '../core/journal-file.ts';

export interface Attempt {
  modelId: string;
  /** タスクが完了したか（作業者が report を出せたか） */
  success: boolean;
  /** 完了したが、後で誤りが判明した場合に true（検査やテストで発覚） */
  defect?: boolean;
  outputTokens: number;
  /** 生成にかかった実時間（秒）。ロード時間は含めない。 */
  seconds: number;
  /** プロセス起動を伴った場合のロード秒数 */
  loadSeconds?: number;
}

export class MetricsStore {
  readonly #path: string;
  #stats = new Map<string, ModelStats>();

  constructor(path: string) {
    this.#path = path;
  }

  /**
   * 読む。無いのは正常（事前値で走り出す）。形の違う一件（`null`・数でない回数）はその一件だけ除く。
   * 在るのに読めないときは空で始め、保存の前に読み直す（`src/core/journal-file.ts`）。
   */
  async load(): Promise<void> {
    this.#stats = new Map();
    await loadJournal(this, this.#path, (v) => {
      for (const s of validStats(v)) this.#stats.set(s.modelId, s);
    });
  }

  get(modelId: string): ModelStats | undefined {
    return this.#stats.get(modelId);
  }

  all(): ModelStats[] {
    return [...this.#stats.values()];
  }

  record(a: Attempt): ModelStats {
    const cur = this.#stats.get(a.modelId) ?? {
      modelId: a.modelId, successes: 0, failures: 0,
    };

    if (a.success) cur.successes += 1;
    else cur.failures += 1;
    if (a.defect) cur.defects = (cur.defects ?? 0) + 1;

    // 極端に短い試行は実測として使わない。
    // 「変更不要です」の一言で終わった応答から算出すると、
    // 非現実的な tok/s が記録され、以後の判断が壊れる。
    const usable = a.seconds >= 1 && a.outputTokens >= 20;

    if (usable) {
      const tps = a.outputTokens / a.seconds;
      cur.measuredTps = cur.measuredTps === undefined ? tps : cur.measuredTps * 0.7 + tps * 0.3;
      cur.measuredTps = Math.round(cur.measuredTps * 10) / 10;
    }
    if (usable) {
      cur.avgTokens = cur.avgTokens === undefined
        ? a.outputTokens
        : Math.round(cur.avgTokens * 0.7 + a.outputTokens * 0.3);
    }
    if (a.loadSeconds !== undefined) {
      cur.loadSeconds = cur.loadSeconds === undefined
        ? a.loadSeconds
        : Math.round((cur.loadSeconds * 0.7 + a.loadSeconds * 0.3) * 10) / 10;
    }

    this.#stats.set(a.modelId, cur);
    return cur;
  }

  /** 書く。一時ファイルから付け替える。起動のときに読めなかったなら、読めるまで書かない。 */
  async save(): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    await saveJournal(this, this.#path, () => JSON.stringify(this.all(), null, 2), (v) => {
      // 読めなかった間に数えた分を、ファイルの分の上に足す。実測の値は、この間に測ったものがあればそちらを取る
      for (const base of validStats(v)) {
        const now = this.#stats.get(base.modelId);
        if (!now) { this.#stats.set(base.modelId, base); continue; }
        now.successes += base.successes;
        now.failures += base.failures;
        if (base.defects !== undefined) now.defects = (now.defects ?? 0) + base.defects;
        now.measuredTps ??= base.measuredTps;
        now.avgTokens ??= base.avgTokens;
        now.loadSeconds ??= base.loadSeconds;
      }
    });
  }

  /** 利用者に見せる一覧。どの配置が実際に効いているかの判断材料。 */
  report(): string {
    const rows = this.all()
      .map((s) => {
        const attempts = s.successes + s.failures;
        const rate = attempts > 0 ? Math.round((s.successes / attempts) * 100) : 0;
        return {
          id: s.modelId,
          tps: s.measuredTps ?? 0,
          rate,
          attempts,
          perTask: s.measuredTps && s.avgTokens && s.successes > 0
            ? Math.round((s.avgTokens / s.measuredTps) / (s.successes / attempts))
            : undefined,
        };
      })
      .sort((a, b) => (a.perTask ?? Infinity) - (b.perTask ?? Infinity));

    if (rows.length === 0) return '実測データはまだありません。';
    const lines = ['モデル                        実測tok/s  成功率  試行  1件完了まで'];
    for (const r of rows) {
      lines.push(
        `${r.id.padEnd(28)}  ${String(r.tps).padStart(8)}  ${String(r.rate + '%').padStart(5)}` +
        `  ${String(r.attempts).padStart(4)}  ${r.perTask !== undefined ? `約${r.perTask}秒` : '—'}`,
      );
    }
    return lines.join('\n');
  }
}

/** 実測の記録のうち、形の合う分だけ。配列でなければ空。 */
function validStats(v: unknown): ModelStats[] {
  return Array.isArray(v) ? v.filter(isModelStats) : [];
}

function isModelStats(v: unknown): v is ModelStats {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  const count = (x: unknown) => typeof x === 'number' && Number.isInteger(x) && x >= 0;
  const measure = (x: unknown) => x === undefined || (typeof x === 'number' && Number.isFinite(x) && x >= 0);
  return typeof r.modelId === 'string' && count(r.successes) && count(r.failures)
    && (r.defects === undefined || count(r.defects))
    && measure(r.measuredTps) && measure(r.avgTokens) && measure(r.loadSeconds);
}
