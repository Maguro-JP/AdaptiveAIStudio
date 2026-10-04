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
    // 動かし方ごとに言う（inproc でも Ollama の文を出していたので、Ollama を使っていない人に Ollama を疑わせた）
    const who = config.runtime?.kind === 'inproc' ? 'この中で読む道（inproc）' : 'Ollama';
    return { warmed: [], notes: [`${who}はモデル保持を自前で行うため、常時ロードは適用しません`] };
  }

  // VRAM が無い（測れない）機械では、上限が 0 になって効かず、候補を全部システムの記憶へ温めていた。そのときは一つだけ温める
  const fraction = Math.min(1, Math.max(0, warmCfg.vramFraction ?? 0.95));
  const noVram = !(machine.vramBytes > 0);
  if (noVram) notes.push('VRAM が見当たらないので、常時ロードは一つだけにします');
  const pool = new WarmPool({
    runtime,
    vramBudgetBytes: machine.vramBytes * fraction,
    maxResident: noVram ? Math.min(1, warmCfg.maxResident ?? 1) : warmCfg.maxResident,
    planOf: (ref) => runtime.planFor(ref),
    onEvent,
  });

  // 温める対象: 明示指定 > 自動選択の候補順
  // 明示指定も `provider:` を外して照らす（候補だけ外していたので、`llamacpp:x.gguf` と書くと必ず見つからなかった）。
  // 外すのは、頭が設定にある provider の名前のときだけ（モデル名そのものに `:` が入ることがある）
  const providerIds = new Set(config.providers.map((p) => p.id));
  const fromPreload = (ref: string): string => {
    const sep = ref.indexOf(':');
    return sep > 0 && providerIds.has(ref.slice(0, sep)) ? ref.slice(sep + 1) : ref;
  };
  const targets = warmCfg.preload ? warmCfg.preload.map(fromPreload) : candidates.map(stripProvider).filter(Boolean);
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
