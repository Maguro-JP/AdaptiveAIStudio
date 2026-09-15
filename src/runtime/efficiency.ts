/**
 * モデル運用の効率計算。
 *
 * ローカルではトークン単価がゼロなので、小さいモデルを選ぶ理由は
 * 「安いから」ではなく「速いから」しかない。
 * そして速さの指標は tok/s ではない。
 *
 *   本当の指標 = 1件のタスクを「完了」させるまでの実時間
 *
 * 弱いモデルは速いが失敗してやり直す。強いモデルは遅いが一発で通る。
 * やり直しを含めた実時間で比べないと、正しい選択にならない。
 *
 *   期待実時間 = (生成時間 + モデル切替コスト) ÷ 成功率
 *
 * 成功率は推測ではなく実測で埋める（metrics.ts が蓄積する）。
 */
import type { Plan } from './planner.ts';

export interface ModelStats {
  modelId: string;
  /** 実測 tokens/sec。未実測ならプランナの見積りを使う。 */
  measuredTps?: number;
  /** 完了した試行数 */
  successes: number;
  /** その場で失敗と分かり、やり直した試行数（安いミス） */
  failures: number;
  /**
   * 完了したように見えたが、後で誤りが判明した回数（高いミス）。
   *
   * やり直し算だけで比べると、速い弱モデルが常に有利に見える。
   * だが弱いモデルの本当の危険は「失敗すること」ではなく
   * 「間違ったまま通ってしまうこと」。これを別に数える。
   */
  defects?: number;
  /** 1タスクあたりの平均生成トークン数（実測） */
  avgTokens?: number;
  /** プロセス起動〜応答可能までの実測秒数 */
  loadSeconds?: number;
}

export interface Candidate {
  modelId: string;
  plan: Plan;
  stats?: ModelStats;
  /** このモデルが今ロード済みか。未ロードなら切替コストが乗る。 */
  loaded: boolean;
}

export interface EfficiencyInput {
  candidates: Candidate[];
  /** 想定する1タスクの生成トークン数 */
  expectedTokens?: number;
  /**
   * 成功率の事前値。実測が十分でないときに使う。
   * 大きいモデルほど高いという一般的な傾向のみを表す控えめな値。
   */
  priorSuccessRate?(modelId: string, plan: Plan): number;
  /** 実測が不足しているとみなす試行数のしきい値 */
  minSamples?: number;
  /**
   * 誤りが検知されずに通った場合の追加コスト（秒）。
   * デバッグ・手戻り・信頼の毀損を時間に換算したもの。
   * 生成時間より桁で大きいのが普通なので、既定値も大きく取る。
   */
  defectPenaltySeconds?: number;
}

export interface Ranked {
  modelId: string;
  /** 1件完了までの期待実時間（秒）。小さいほど良い。 */
  expectedSeconds: number;
  generationSeconds: number;
  swapSeconds: number;
  successRate: number;
  /** 誤りが検知されず通る確率 */
  defectRate: number;
  /** 手戻りの期待コスト（秒） */
  defectSeconds: number;
  /** 実測に基づくか、事前値か */
  basis: 'measured' | 'prior' | 'mixed';
  reason: string;
}

const DEFAULT_TOKENS = 1200;
const DEFAULT_LOAD_SECONDS = 45;
const MIN_SAMPLES = 5;
/** 誤りが通ってしまったときの手戻り。30分を既定とする。 */
const DEFAULT_DEFECT_PENALTY = 1800;

/**
 * 既定の事前成功率。
 * パラメータ規模で単調に上がるという弱い仮定だけを置く。
 * 実測が溜まれば上書きされるので、精密である必要はない。
 */
export function defaultPrior(_modelId: string, plan: Plan): number {
  const layers = plan.totalLayers;
  // 層数を規模の代理指標として使う（諸元から必ず取れるため）
  if (layers >= 70) return 0.8;
  if (layers >= 60) return 0.75;
  if (layers >= 45) return 0.65;
  if (layers >= 30) return 0.5;
  return 0.4;
}

export function rank(input: EfficiencyInput): Ranked[] {
  const tokens = input.expectedTokens ?? DEFAULT_TOKENS;
  const prior = input.priorSuccessRate ?? defaultPrior;
  const minSamples = input.minSamples ?? MIN_SAMPLES;
  const defectPenalty = input.defectPenaltySeconds ?? DEFAULT_DEFECT_PENALTY;

  const ranked = input.candidates.map((c): Ranked => {
    const tps = c.stats?.measuredTps ?? c.plan.estimatedTps;
    const n = tokens;
    const generationSeconds = tps > 0 ? n / tps : Infinity;

    const swapSeconds = c.loaded ? 0 : (c.stats?.loadSeconds ?? DEFAULT_LOAD_SECONDS);

    const attempts = (c.stats?.successes ?? 0) + (c.stats?.failures ?? 0);
    const measured = attempts > 0 ? (c.stats!.successes) / attempts : undefined;
    const priorRate = prior(c.modelId, c.plan);

    // 実測が少ないうちは事前値と混ぜる（急激に振れないように）
    let successRate: number;
    let basis: Ranked['basis'];
    if (measured === undefined) {
      successRate = priorRate;
      basis = 'prior';
    } else if (attempts >= minSamples) {
      successRate = measured;
      basis = 'measured';
    } else {
      const w = attempts / minSamples;
      successRate = measured * w + priorRate * (1 - w);
      basis = 'mixed';
    }
    successRate = Math.max(0.05, Math.min(1, successRate));

    // 検知されずに通る誤りの割合。実測が無ければ、
    // 「成功率が低いモデルほど、通ってしまう誤りも多い」という仮定を置く。
    const defects = c.stats?.defects;
    const totalDone = (c.stats?.successes ?? 0) + (defects ?? 0);
    const defectRate = defects !== undefined && totalDone > 0
      ? defects / totalDone
      : (1 - successRate) * 0.5;

    const defectSeconds = defectRate * defectPenalty;
    const expectedSeconds = (generationSeconds + swapSeconds) / successRate + defectSeconds;

    return {
      modelId: c.modelId,
      expectedSeconds: roundS(expectedSeconds),
      generationSeconds: roundS(generationSeconds),
      swapSeconds: roundS(swapSeconds),
      successRate: Math.round(successRate * 100) / 100,
      defectRate: Math.round(defectRate * 100) / 100,
      defectSeconds: roundS(defectSeconds),
      basis,
      reason: explain(c, tps, generationSeconds, swapSeconds, successRate, defectRate, basis),
    };
  });

  return ranked.sort((a, b) => a.expectedSeconds - b.expectedSeconds);
}

export function choose(input: EfficiencyInput): Ranked | undefined {
  return rank(input)[0];
}

function explain(
  c: Candidate, tps: number, gen: number, swap: number,
  rate: number, defectRate: number, basis: Ranked['basis'],
): string {
  const parts = [
    `${tps} tok/s で ${Math.round(gen)}秒`,
    swap > 0 ? `切替 +${Math.round(swap)}秒` : 'ロード済み',
    `成功率 ${Math.round(rate * 100)}%${basis === 'measured' ? '(実測)' : basis === 'mixed' ? '(実測+事前)' : '(事前値)'}`,
    `見逃し ${Math.round(defectRate * 100)}%`,
  ];
  return parts.join(' / ');
}

function roundS(n: number): number {
  if (!Number.isFinite(n)) return Number.POSITIVE_INFINITY;
  return Math.round(n * 10) / 10;
}
