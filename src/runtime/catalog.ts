/**
 * モデル諸元のカタログ。
 * 層数・KVヘッド数はモデルのconfigから取れる値で、実測ではない。
 * 将来は GGUF のメタデータから自動取得する（S2）。
 */
import { type ModelSpec, QUANT_BITS } from './spec.ts';

export const KNOWN_MODELS: Record<string, ModelSpec> = {
  'qwen2.5-coder:7b': {
    id: 'qwen2.5-coder:7b',
    paramsB: 7.6, layers: 28, kvHeads: 4, headDim: 128,
    bitsPerWeight: QUANT_BITS.Q4_K_M,
  },
  'qwen2.5:14b': {
    id: 'qwen2.5:14b',
    paramsB: 14.8, layers: 48, kvHeads: 8, headDim: 128,
    bitsPerWeight: QUANT_BITS.Q4_K_M,
  },
  'qwen2.5-coder:32b': {
    id: 'qwen2.5-coder:32b',
    paramsB: 32.8, layers: 64, kvHeads: 8, headDim: 128,
    bitsPerWeight: QUANT_BITS.Q4_K_M,
  },
  // MoE: 総30Bだが1トークンあたり3Bしか使わない。CPU実行でも速い。
  'qwen3:30b-a3b': {
    id: 'qwen3:30b-a3b',
    paramsB: 30.5, activeParamsB: 3.3, layers: 48, kvHeads: 4, headDim: 128,
    bitsPerWeight: QUANT_BITS.Q4_K_M,
  },
  'llama3.1:70b': {
    id: 'llama3.1:70b',
    paramsB: 70.6, layers: 80, kvHeads: 8, headDim: 128,
    bitsPerWeight: QUANT_BITS.Q4_K_M,
  },
};

export function lookupModel(id: string): ModelSpec | undefined {
  return KNOWN_MODELS[id];
}
