/**
 * 常時ロードの組み立て。
 * 起動時にモデルを温め、CLI終了時に解放する。
 */
import type { AasConfig } from '../config.ts';
import type { LocalRuntime } from '../runtime/local-runtime.ts';
import { LlamaCppRuntime } from '../runtime/llamacpp.ts';
import { WarmPool, type WarmEvent } from '../runtime/warm-pool.ts';
import type { MachineSpec } from '../runtime/spec.ts';

export interface WarmBundle {
  pool?: WarmPool;
  /** 温めたモデル */
  warmed: string[];
  notes: string[];
}

/**
 * 常時ロードを開始する。
 *
 * Ollama は自前でモデルを保持するので、ここで管理するのは llamacpp のときだけ。
 * 二重に管理すると、こちらが降ろした直後に向こうが載せ直すような噛み合いが起きる。
 */
export async function startWarmPool(
  config: AasConfig,
  runtime: LocalRuntime,
  machine: MachineSpec,
  candidates: string[],
  onEvent?: (e: WarmEvent) => void,
): Promise<WarmBundle> {
  const warmCfg = config.runtime?.warm ?? {};
  const notes: string[] = [];

  if (warmCfg.enabled === false) return { warmed: [], notes: ['常時ロードは無効です'] };
  if (!(runtime instanceof LlamaCppRuntime)) {
    return { warmed: [], notes: ['Ollama はモデル保持を自前で行うため、常時ロードは適用しません'] };
  }

  const pool = new WarmPool({
    runtime,
    vramBudgetBytes: machine.vramBytes * (warmCfg.vramFraction ?? 0.95),
    maxResident: warmCfg.maxResident,
    planOf: (ref) => runtime.planFor(ref),
    onEvent,
  });

  // 温める対象: 明示指定 > 自動選択の候補順
  const targets = warmCfg.preload ?? candidates.map(stripProvider).filter(Boolean);
  const available = new Set((await runtime.list()).map((m) => m.ref));
  const loadable = targets.filter((t) => available.has(t));

  if (loadable.length === 0) {
    notes.push('温める対象が見つかりませんでした');
    return { pool, warmed: [], notes };
  }

  await pool.preload(loadable);
  return { pool, warmed: pool.resident, notes };
}

/** "provider:model" から model 部分を取り出す。 */
function stripProvider(modelId: string): string {
  const sep = modelId.indexOf(':');
  return sep === -1 ? modelId : modelId.slice(sep + 1);
}
