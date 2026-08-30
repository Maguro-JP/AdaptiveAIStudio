/**
 * モデル諸元のカタログ。載るか載らないかの計算に使う。
 *
 * 層数・KVヘッド数はモデルの config から取れる値で、実測ではない。
 * **ここに無いモデルでも、GGUF を直接読めば諸元は取れる**（gguf-spec.ts）。
 * この表はその手前の目安で、必ず古くなる。
 * 古くなっても困らないよう、実体は GGUF から読む方を本筋にしてある。
 *
 * 上の方が現行、下が前の世代。**古いものも消さない**。
 * 推薦の一覧ではないので、既に持っている人の計算に要る。
 *
 * 確認日: 2026-08-30。
 */
import { type ModelSpec, QUANT_BITS } from './spec.ts';

export const KNOWN_MODELS: Record<string, ModelSpec> = {
  'qwen3:4b': {
    id: 'qwen3:4b',
    paramsB: 4.0, layers: 36, kvHeads: 8, headDim: 128,
    bitsPerWeight: QUANT_BITS.Q4_K_M,
  },
  'qwen3:8b': {
    id: 'qwen3:8b',
    paramsB: 8.2, layers: 36, kvHeads: 8, headDim: 128,
    bitsPerWeight: QUANT_BITS.Q4_K_M,
  },
  // MoE: 総30Bだが1トークンあたり3.3Bしか使わない。
  // VRAM に載りきらなくても、CPUへ逃がして実用速度が出る。
  'qwen3-coder:30b': {
    id: 'qwen3-coder:30b',
    paramsB: 30.5, activeParamsB: 3.3, layers: 48, kvHeads: 4, headDim: 128,
    bitsPerWeight: QUANT_BITS.Q4_K_M,
  },
  'qwen3:32b': {
    id: 'qwen3:32b',
    paramsB: 32.8, layers: 64, kvHeads: 8, headDim: 128,
    bitsPerWeight: QUANT_BITS.Q4_K_M,
  },

  // ここから下は前の世代。**消さない**。
  // これは推薦の一覧ではなく諸元表で、既に持っている人の計算に要る。
  // 新しいものを勧めることと、古いものを計算できることは別。
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
