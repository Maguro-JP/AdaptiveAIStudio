/**
 * モデルとマシンの諸元。
 * 「載るか載らないか」を感覚ではなく計算で決めるための入力。
 */

export interface ModelSpec {
  id: string;
  /** 総パラメータ数（10億単位）。例: 32B なら 32 */
  paramsB: number;
  /**
   * 1トークンあたりの活性パラメータ数（10億単位）。
   * 通常モデルは paramsB と同じ。MoE はこれが小さく、CPU実行でも速い。
   */
  activeParamsB?: number;
  layers: number;
  /** KVヘッド数（GQAではヘッド数より少ない）。KVキャッシュ量を決める。 */
  kvHeads: number;
  headDim: number;
  /** 量子化の1重みあたりビット数。Q4_K_M は実効約4.83 */
  bitsPerWeight: number;
}

export interface MachineSpec {
  vramBytes: number;
  ramBytes: number;
  /** メモリ帯域 (bytes/s)。CPU側の生成速度を決める支配要因。 */
  ramBandwidthBytesPerSec: number;
  /** VRAM帯域 (bytes/s)。 */
  vramBandwidthBytesPerSec: number;
  /** ディスク読み出し帯域 (bytes/s)。mmap実行時のみ効く。 */
  diskBandwidthBytesPerSec?: number;
}

export const GB = 1024 ** 3;
export const MB = 1024 ** 2;

/** RTX 4060 (8GB) / DDR5 32GB / NVMe。本プロジェクトの基準環境。 */
export const REFERENCE_MACHINE: MachineSpec = {
  vramBytes: 8 * GB,
  ramBytes: 32 * GB,
  ramBandwidthBytesPerSec: 70 * GB,
  vramBandwidthBytesPerSec: 272 * GB,
  diskBandwidthBytesPerSec: 3 * GB,
};

/** よく使う量子化の実効ビット数。 */
export const QUANT_BITS = {
  Q8_0: 8.5,
  Q6_K: 6.6,
  Q5_K_M: 5.7,
  Q4_K_M: 4.83,
  Q3_K_M: 3.9,
  IQ2_M: 2.7,
} as const;

export type QuantName = keyof typeof QUANT_BITS;

/** 量子化を1段下げる順序。品質を落とすので最後の手段。 */
export const QUANT_LADDER: QuantName[] = ['Q8_0', 'Q6_K', 'Q5_K_M', 'Q4_K_M', 'Q3_K_M', 'IQ2_M'];

/** 重みの総バイト数。 */
export function weightBytes(model: ModelSpec): number {
  return (model.paramsB * 1e9 * model.bitsPerWeight) / 8;
}

/** 1層あたりのバイト数。部分オフロードの単位。 */
export function bytesPerLayer(model: ModelSpec): number {
  return weightBytes(model) / model.layers;
}

/**
 * KVキャッシュのバイト数。
 * = 2(K,V) × 層数 × KVヘッド数 × ヘッド次元 × context × 要素バイト数
 */
export function kvCacheBytes(
  model: ModelSpec,
  contextLength: number,
  bytesPerElement: number,
): number {
  return 2 * model.layers * model.kvHeads * model.headDim * contextLength * bytesPerElement;
}
