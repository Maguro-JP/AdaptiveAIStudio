/**
 * 実測の蓄積。
 *
 * どのモデルが自分の環境で実際に速く・確実だったかは、
 * 諸元から推測するより、使った結果を記録する方が正確。
 * 「効率の良い運用」は、この記録があって初めて成立する。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ModelStats } from './efficiency.ts';

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

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.#path, 'utf8');
      const parsed = JSON.parse(raw) as ModelStats[];
      this.#stats = new Map(parsed.map((s) => [s.modelId, s]));
    } catch {
      // 記録が無いのは正常。事前値で走り出す。
      this.#stats = new Map();
    }
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

    // 実測 tok/s は移動平均で更新する。1回の外れ値で振れないように。
    if (a.seconds > 0 && a.outputTokens > 0) {
      const tps = a.outputTokens / a.seconds;
      cur.measuredTps = cur.measuredTps === undefined ? tps : cur.measuredTps * 0.7 + tps * 0.3;
      cur.measuredTps = Math.round(cur.measuredTps * 10) / 10;
    }
    if (a.outputTokens > 0) {
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

  async save(): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    await writeFile(this.#path, JSON.stringify(this.all(), null, 2), 'utf8');
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
