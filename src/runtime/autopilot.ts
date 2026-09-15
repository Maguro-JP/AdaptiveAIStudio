/**
 * 自動操縦 — 利用者にモデルを選ばせない。
 *
 * 使える範囲で最良のモデルを自分で選び、実測を溜め、
 * より良い選択肢が見つかったら裏で乗り換える。
 *
 * 設定でモデルを縛るのは、検証目的の利用者のためだけの機能であって、
 * 既定の体験ではない。
 */
import type { ModelDescriptor } from '../providers/contract.ts';
import { planExecution, type Plan } from './planner.ts';
import { rank, type Candidate, type Ranked } from './efficiency.ts';
import type { MachineSpec, ModelSpec } from './spec.ts';
import { lookupModel } from './catalog.ts';
import { MetricsStore, type Attempt } from './metrics.ts';
import { inferSpec } from './infer.ts';

export interface AutopilotOptions {
  machine: MachineSpec;
  metrics: MetricsStore;
  /**
   * 乗り換えに必要な改善幅。
   * これが無いと、わずかな差でモデルを載せ替え続けて（スラッシング）
   * 切替コストだけを払うことになる。
   */
  switchMarginRatio?: number;
  expectedTokens?: number;
}

export interface Selection {
  modelId: string;
  plan: Plan;
  ranked: Ranked;
  /** 直前と違うモデルへ乗り換えたか */
  switched: boolean;
  /** 利用者に見せる説明 */
  reason: string;
}

const DEFAULT_SWITCH_MARGIN = 0.25;

export class Autopilot {
  readonly #machine: MachineSpec;
  readonly #metrics: MetricsStore;
  readonly #margin: number;
  readonly #expectedTokens: number;

  /** provider付きModelId -> 諸元と実行計画 */
  readonly #known = new Map<string, { spec: ModelSpec; plan: Plan }>();
  #currentModelId?: string;

  constructor(opts: AutopilotOptions) {
    this.#machine = opts.machine;
    this.#metrics = opts.metrics;
    this.#margin = opts.switchMarginRatio ?? DEFAULT_SWITCH_MARGIN;
    this.#expectedTokens = opts.expectedTokens ?? 1200;
  }

  get current(): string | undefined {
    return this.#currentModelId;
  }

  /**
   * 利用可能なモデルを登録する。
   * カタログに無いモデルは名前から諸元を推定する（登録漏れで候補から落とさない）。
   */
  register(models: ModelDescriptor[]): void {
    for (const m of models) {
      if (m.locality !== 'local') continue; // クラウドは別枠で扱う
      const spec = lookupModel(m.model) ?? inferSpec(m.model);
      if (!spec) continue;
      const plan = planExecution({ model: spec, machine: this.#machine });
      this.#known.set(m.id, { spec, plan });
    }
  }

  get knownCount(): number {
    return this.#known.size;
  }

  /** 現時点で最良のモデルを選ぶ。乗り換え判定つき。 */
  select(expectedTokens = this.#expectedTokens): Selection | undefined {
    if (this.#known.size === 0) return undefined;

    const candidates: Candidate[] = [...this.#known.entries()].map(([modelId, { plan }]) => ({
      modelId,
      plan,
      stats: this.#metrics.get(modelId),
      loaded: modelId === this.#currentModelId,
    }));

    const ordered = rank({ candidates, expectedTokens });
    const best = ordered[0]!;

    // 今のモデルが十分に近ければ、乗り換えない（スラッシング防止）
    if (this.#currentModelId && best.modelId !== this.#currentModelId) {
      const cur = ordered.find((r) => r.modelId === this.#currentModelId);
      if (cur && best.expectedSeconds > cur.expectedSeconds * (1 - this.#margin)) {
        return this.#toSelection(cur, false, '現行モデルとの差が小さいため乗り換えない');
      }
    }

    const switched = this.#currentModelId !== undefined && this.#currentModelId !== best.modelId;
    const note = switched
      ? `${this.#currentModelId} より速いと判断`
      : this.#currentModelId === undefined ? '起動時の自動選択' : '継続';
    this.#currentModelId = best.modelId;
    return this.#toSelection(best, switched, note);
  }

  /** 作業の結果を記録する。次回以降の選択がこれで変わる。 */
  async record(a: Attempt): Promise<void> {
    this.#metrics.record(a);
    await this.#metrics.save().catch(() => undefined);
  }

  /** 候補の一覧。なぜその順なのかを利用者に見せるため。 */
  explain(expectedTokens = this.#expectedTokens): Ranked[] {
    const candidates: Candidate[] = [...this.#known.entries()].map(([modelId, { plan }]) => ({
      modelId, plan, stats: this.#metrics.get(modelId), loaded: modelId === this.#currentModelId,
    }));
    return rank({ candidates, expectedTokens });
  }

  #toSelection(r: Ranked, switched: boolean, note: string): Selection {
    const entry = this.#known.get(r.modelId)!;
    return {
      modelId: r.modelId,
      plan: entry.plan,
      ranked: r,
      switched,
      reason: `${note} — ${r.reason} / 1件あたり約${Math.round(r.expectedSeconds)}秒`,
    };
  }
}
