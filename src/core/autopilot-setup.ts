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
  /**
   * 使えはするが、言っておくこと。
   *
   * **`unavailable` に書いても出ない。**あれは一つも選べなかったときだけ
   * 読まれる。選べたときに言いたいことは、選んだ理由（`note`）に混ぜる。
   * 場所を間違えると、書いたのに誰も読まない印になる。
   */
  caution?: string;
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
  /*
   * **確かめていない名前だけで進んでいることを、言う。**
   *
   * 一覧が取れないと、設定に書いてある名前で続行する道がある
   * （`/v1/models` を持たない相手が居るため）。そのとき返ってくる
   * 名前は `verified: false`。**そこに気づく道が無かったので、
   * 存在しないモデルを候補として並べ、送るたびに叩いていた。**
   * しかも設定に書いてある名前は世代ごと古くなるので、放っておくと
   * 必ずそうなる。
   */
  const unavailable = local.length === 0
    ? (config.runtime?.kind === 'ollama'
        ? 'ローカルモデルが見つかりません（Ollama が起動しているか確認してください）'
        : 'ローカルモデルが見つかりません（設定 → モデル で、保存先に .gguf があるか見てください）')
    : autopilot.knownCount === 0
      ? 'モデル名から規模を判定できませんでした'
      : undefined;

  const caution = local.length > 0 && local.every((m) => m.verified === false)
    ? '一覧を取れなかったので、設定に書いてある名前で進みます。'
      + '**その名前が本当に在るかは確かめていません**（繋ぎ先が動いているか見てください）'
    : undefined;

  return {
    autopilot, machine, metrics, machineText: describeMachine(machine),
    ...(unavailable !== undefined ? { unavailable } : {}),
    ...(caution !== undefined ? { caution } : {}),
  };
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
  // 言っておくことは、選んだ理由に混ぜる。**ここが実際に画面へ出る道。**
  const note = bundle.caution ? `${sel.reason}／${bundle.caution}` : sel.reason;
  return { candidates: [sel.modelId, ...rest], note };
}
