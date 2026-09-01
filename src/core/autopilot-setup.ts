/**
 * 自動操縦の組み立て。
 * 設定が無い状態から「使えるモデルを調べて最良を選ぶ」までを一括で行う。
 */
import { join } from 'node:path';
import type { AasConfig } from '../config.ts';
import type { ProviderRegistry } from './registry.ts';
import { Autopilot } from '../runtime/autopilot.ts';
import { MetricsStore } from '../runtime/metrics.ts';
import { MachineCache, describeMachine, type DetectedMachine } from '../runtime/machine.ts';

export interface AutopilotBundle {
  autopilot: Autopilot;
  machine: DetectedMachine;
  metrics: MetricsStore;
  machineText: string;
  /** 自動操縦が使えない場合の理由（モデルが無い等） */
  unavailable?: string;
}

// 置き場所の決め方は home.ts に集めた。ここからも今までどおり呼べるようにしておく。
import { stateDir } from './home.ts';
export { stateDir };

export async function setupAutopilot(
  config: AasConfig,
  registry: ProviderRegistry,
): Promise<AutopilotBundle> {
  const dir = stateDir();
  const machine = await new MachineCache(join(dir, 'machine.json')).get();
  const metrics = new MetricsStore(join(dir, 'metrics.json'));
  await metrics.load();

  const autopilot = new Autopilot({ machine, metrics });
  const models = await registry.listAllModels();
  autopilot.register(models);

  const local = models.filter((m) => m.locality === 'local');
  const unavailable = local.length === 0
    ? 'ローカルモデルが見つかりません（Ollama が起動しているか確認してください）'
    : autopilot.knownCount === 0
      ? 'モデル名から規模を判定できませんでした'
      : undefined;

  return { autopilot, machine, metrics, machineText: describeMachine(machine), unavailable };
}

/** 固定指定があればそれを、無ければ自動選択の結果を候補列として返す。 */
export function resolveCandidates(
  config: AasConfig,
  bundle: AutopilotBundle,
): { candidates: string[]; note: string } {
  if (config.candidates && config.candidates.length > 0) {
    return { candidates: config.candidates, note: '設定で固定' };
  }
  const sel = bundle.autopilot.select();
  if (!sel) return { candidates: [], note: bundle.unavailable ?? 'モデルなし' };

  // 選ばれたモデルを先頭に、残りをフォールバックとして並べる
  const rest = bundle.autopilot.explain()
    .map((r) => r.modelId)
    .filter((id) => id !== sel.modelId);
  return { candidates: [sel.modelId, ...rest], note: sel.reason };
}
