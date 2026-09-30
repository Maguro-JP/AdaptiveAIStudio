/**
 * モデル名からの諸元推定。
 *
 * カタログに載っていないモデルを候補から落とさないための保険。
 * 精度は高くないが、「知らないから使わない」より遥かにましである。
 * 実測が溜まれば見積りの誤差は影響しなくなる。
 */
import { type ModelSpec, QUANT_BITS } from './spec.ts';

export function inferSpec(name: string): ModelSpec | undefined {
  const n = name.toLowerCase();

  // "30b-a3b" のような MoE 表記（総params-活性params）
  const moe = /(\d+(?:\.\d+)?)b[-_]a(\d+(?:\.\d+)?)b/.exec(n);
  // "7b" "14b" "32b" のような規模表記
  const dense = /(\d+(?:\.\d+)?)\s*b\b/.exec(n);

  const paramsB = moe ? Number(moe[1]) : dense ? Number(dense[1]) : undefined;
  if (paramsB === undefined || !Number.isFinite(paramsB) || paramsB <= 0) return undefined;

  const activeParamsB = moe ? Number(moe[2]) : undefined;

  return {
    id: name,
    paramsB,
    ...(activeParamsB !== undefined ? { activeParamsB } : {}),
    layers: inferLayers(paramsB),
    kvHeads: paramsB >= 13 ? 8 : 4,
    headDim: 128,
    bitsPerWeight: inferQuant(n),
  };
}

/** 規模から層数を概算する。最近のTransformerの一般的な比率。 */
function inferLayers(paramsB: number): number {
  if (paramsB >= 65) return 80;
  if (paramsB >= 28) return 64;
  if (paramsB >= 13) return 48;
  if (paramsB >= 6) return 28;
  if (paramsB >= 2) return 24;
  return 16;
}

function inferQuant(name: string): number {
  // 量子化していないもの。Q8_0 の重さで数えると半分に見積もり、GPU に載せすぎる
  if (/f32|fp32/.test(name)) return 32;
  if (/f16|fp16|bf16/.test(name)) return 16;
  if (/q8/.test(name)) return QUANT_BITS.Q8_0;
  if (/q6/.test(name)) return QUANT_BITS.Q6_K;
  if (/q5/.test(name)) return QUANT_BITS.Q5_K_M;
  if (/q3/.test(name)) return QUANT_BITS.Q3_K_M;
  if (/iq2|q2/.test(name)) return QUANT_BITS.IQ2_M;
  return QUANT_BITS.Q4_K_M; // 既定の配布形式
}
