/**
 * 実行可能性プランナ。
 *
 * 「載りません」と言わない。必ず1つの実行可能な設定を返す。
 * 劣化は品質を落とさないものから先に使い切る。
 *
 *   1. GPU層数を減らす      速度だけ落ちる
 *   2. KVキャッシュを量子化  ほぼ落ちない
 *   3. contextを縮める      扱える情報量が減る
 *   4. 量子化を下げる        品質が落ちる（最後の手段）
 *   5. mmapでディスク実行    非常に遅いが動く
 */
import {
  type MachineSpec, type ModelSpec, type QuantName,
  QUANT_BITS, QUANT_LADDER, GB, MB,
  weightBytes, bytesPerLayer, kvCacheBytes,
} from './spec.ts';

export type KvCacheType = 'f16' | 'q8_0' | 'q4_0';

const KV_ELEMENT_BYTES: Record<KvCacheType, number> = { f16: 2, q8_0: 1, q4_0: 0.55 };

/** VRAMのうち、OS・表示・CUDAコンテキストが使う分。 */
const VRAM_RESERVED = 900 * MB;
/** 推論用の作業バッファ。contextに比例するが概算で足りる。 */
const COMPUTE_BUFFER = 400 * MB;
/** RAMのうちOS・他プロセス用に空けておく分。 */
const RAM_RESERVED = 4 * GB;

export interface PlanRequest {
  model: ModelSpec;
  machine: MachineSpec;
  /** 望ましいcontext長。収まらなければ縮める。 */
  desiredContext?: number;
  /** これ未満には縮めない下限。 */
  minContext?: number;
  /** 量子化を下げることを許すか。既定 true（最後の手段として） */
  allowQuantDowngrade?: boolean;
}

export type Placement = 'fullGpu' | 'partialOffload' | 'cpuOnly' | 'diskMmap';

export interface Plan {
  modelId: string;
  placement: Placement;
  quant: QuantName;
  gpuLayers: number;
  totalLayers: number;
  contextLength: number;
  kvCacheType: KvCacheType;
  useMmap: boolean;
  /** 予測生成速度 (tokens/sec)。実測値で上書きされるまでの目安。 */
  estimatedTps: number;
  vramUsedBytes: number;
  ramUsedBytes: number;
  /** どの劣化を使ったか。利用者に見せる。 */
  degradations: string[];
  /** 利用者に見せる一行説明。 */
  summary: string;
}

export function planExecution(req: PlanRequest): Plan {
  const { machine } = req;
  const desired = req.desiredContext ?? 8192;
  const minContext = req.minContext ?? 2048;
  const allowDowngrade = req.allowQuantDowngrade ?? true;

  const startQuant = nearestQuant(req.model.bitsPerWeight);
  const quants = allowDowngrade
    ? QUANT_LADDER.slice(QUANT_LADDER.indexOf(startQuant))
    : [startQuant];

  for (const quant of quants) {
    // 劣化の記録は採用した設定のぶんだけにする。
    // 試して駄目だった段階まで並べると、実際より劣化が大きく見えてしまう。
    const degradations: string[] = quant === startQuant
      ? []
      : [`量子化を ${startQuant} → ${quant} に下げた`];
    const model = { ...req.model, bitsPerWeight: QUANT_BITS[quant] };

    // context と KV量子化を、品質が落ちにくい順に試す
    for (const kvType of ['f16', 'q8_0', 'q4_0'] as KvCacheType[]) {
      for (const context of contextCandidates(desired, minContext)) {
        const fit = tryFit(model, machine, context, kvType);
        if (!fit) continue;

        const notes = [...degradations];
        if (fit.gpuLayers < model.layers && fit.gpuLayers > 0) {
          notes.push(`GPU層数を ${fit.gpuLayers}/${model.layers} に減らした`);
        }
        if (fit.gpuLayers === 0) notes.push('全層をCPUで実行');
        if (kvType !== 'f16') notes.push(`KVキャッシュを ${kvType} に量子化した`);
        if (context < desired) notes.push(`contextを ${desired} → ${context} に縮めた`);

        return finish(model, machine, quant, fit, context, kvType, notes);
      }
    }
  }

  // ここまで来たら、RAMにも載らない。ディスクから mmap で実行する。
  const quant = quants.at(-1)!;
  const finalDegradations = quant === startQuant ? [] : [`量子化を ${startQuant} → ${quant} に下げた`];
  const model = { ...req.model, bitsPerWeight: QUANT_BITS[quant] };
  const context = minContext;
  const tps = diskTps(model, machine);
  return {
    modelId: model.id,
    placement: 'diskMmap',
    quant,
    gpuLayers: 0,
    totalLayers: model.layers,
    contextLength: context,
    kvCacheType: 'q4_0',
    useMmap: true,
    estimatedTps: tps,
    vramUsedBytes: 0,
    ramUsedBytes: machine.ramBytes - RAM_RESERVED,
    degradations: [...finalDegradations, 'RAMに載らないためディスクから実行（非常に遅い）'],
    summary: summarize('diskMmap', model.id, quant, 0, model.layers, context, tps),
  };
}

interface Fit {
  gpuLayers: number;
  vramUsed: number;
  ramUsed: number;
}

/** 指定条件で載るかを判定し、載るなら最大のGPU層数を返す。 */
function tryFit(
  model: ModelSpec, machine: MachineSpec, context: number, kvType: KvCacheType,
): Fit | undefined {
  const total = weightBytes(model);
  const perLayer = bytesPerLayer(model);
  const kv = kvCacheBytes(model, context, KV_ELEMENT_BYTES[kvType]);
  const ramBudget = machine.ramBytes - RAM_RESERVED;
  const vramBudget = machine.vramBytes - VRAM_RESERVED;

  // 全層GPU: 重み + KV + 作業バッファ が VRAM に収まるか
  if (total + kv + COMPUTE_BUFFER <= vramBudget) {
    return { gpuLayers: model.layers, vramUsed: total + kv + COMPUTE_BUFFER, ramUsed: 0 };
  }

  // 部分オフロード: KVはGPUに置く（ここを削ると極端に遅くなる）
  const forLayers = vramBudget - kv - COMPUTE_BUFFER;
  const gpuLayers = forLayers > 0 ? Math.min(model.layers, Math.floor(forLayers / perLayer)) : 0;
  const cpuBytes = (model.layers - gpuLayers) * perLayer;

  // KVをGPUに置けないほど狭いなら、KVもCPU側へ回す
  const kvOnGpu = gpuLayers > 0;
  const ramUsed = cpuBytes + (kvOnGpu ? 0 : kv);
  if (ramUsed > ramBudget) return undefined;

  return {
    gpuLayers,
    vramUsed: kvOnGpu ? gpuLayers * perLayer + kv + COMPUTE_BUFFER : 0,
    ramUsed,
  };
}

function finish(
  model: ModelSpec, machine: MachineSpec, quant: QuantName,
  fit: Fit, context: number, kvType: KvCacheType, degradations: string[],
): Plan {
  const placement: Placement =
    fit.gpuLayers === model.layers ? 'fullGpu' : fit.gpuLayers === 0 ? 'cpuOnly' : 'partialOffload';
  const tps = estimateTps(model, machine, fit);
  return {
    modelId: model.id,
    placement,
    quant,
    gpuLayers: fit.gpuLayers,
    totalLayers: model.layers,
    contextLength: context,
    kvCacheType: kvType,
    useMmap: placement !== 'fullGpu',
    estimatedTps: tps,
    vramUsedBytes: fit.vramUsed,
    ramUsedBytes: fit.ramUsed,
    degradations,
    summary: summarize(placement, model.id, quant, fit.gpuLayers, model.layers, context, tps),
  };
}

/**
 * 生成速度の見積り。
 *
 * 自己回帰生成は1トークンごとに全活性重みを読み直すため、
 * 速度は計算力ではなく**メモリ帯域**でほぼ決まる。
 * MoE は活性パラメータが少ないぶん、読む量が減って速くなる。
 */
function estimateTps(model: ModelSpec, machine: MachineSpec, fit: Fit): number {
  const activeRatio = (model.activeParamsB ?? model.paramsB) / model.paramsB;
  const total = weightBytes(model) * activeRatio;
  const gpuFraction = fit.gpuLayers / model.layers;

  const gpuBytes = total * gpuFraction;
  const cpuBytes = total * (1 - gpuFraction);

  // GPUが無い環境では vramBandwidth が 0 になる。
  // 0バイトを0帯域で割ると NaN になり、速度0＝「動かせない」と誤判定されるため、
  // 読むバイト数が0の項は時間0として扱う。
  const seconds = time(gpuBytes, machine.vramBandwidthBytesPerSec)
                + time(cpuBytes, machine.ramBandwidthBytesPerSec);

  // 実効帯域は理論値の6〜7割程度しか出ない
  return Number.isFinite(seconds) && seconds > 0 ? round(1 / (seconds / 0.65)) : 0;
}

/** バイト数0なら時間0。帯域0で割って NaN を作らない。 */
function time(bytes: number, bandwidth: number): number {
  if (bytes <= 0) return 0;
  if (bandwidth <= 0) return Number.POSITIVE_INFINITY;
  return bytes / bandwidth;
}

function diskTps(model: ModelSpec, machine: MachineSpec): number {
  const activeRatio = (model.activeParamsB ?? model.paramsB) / model.paramsB;
  const bytes = weightBytes(model) * activeRatio;
  const bw = machine.diskBandwidthBytesPerSec ?? 1 * GB;
  return round(1 / (bytes / bw / 0.5));
}

function contextCandidates(desired: number, min: number): number[] {
  const out: number[] = [];
  for (let c = desired; c >= min; c = Math.floor(c / 2)) out.push(c);
  if (out.at(-1) !== min) out.push(min);
  return out;
}

function nearestQuant(bits: number): QuantName {
  let best: QuantName = 'Q4_K_M';
  let diff = Infinity;
  for (const name of QUANT_LADDER) {
    const d = Math.abs(QUANT_BITS[name] - bits);
    if (d < diff) { diff = d; best = name; }
  }
  return best;
}

function summarize(
  placement: Placement, id: string, quant: QuantName,
  gpuLayers: number, layers: number, context: number, tps: number,
): string {
  const where = {
    fullGpu: '全層GPU',
    partialOffload: `部分オフロード (GPU ${gpuLayers}/${layers}層)`,
    cpuOnly: 'CPU実行',
    diskMmap: 'ディスク実行 (mmap)',
  }[placement];
  return `${id} ${quant} / ${where} / context ${context} / 約 ${tps} tok/s`;
}

/** 1000トークン生成にかかる時間の目安（利用者への予告用）。 */
export function estimateDuration(plan: Plan, tokens: number): string {
  if (plan.estimatedTps <= 0) return '不明';
  const sec = tokens / plan.estimatedTps;
  if (sec < 60) return `約 ${Math.ceil(sec)}秒`;
  if (sec < 3600) return `約 ${Math.ceil(sec / 60)}分`;
  if (sec < 86400) return `約 ${(sec / 3600).toFixed(1)}時間`;
  return `約 ${(sec / 86400).toFixed(1)}日`;
}

/**
 * 丸め。極端に遅い速度を 0 に潰さないこと。
 * 0 tok/s は「動かせない」と読まれてしまい、本プロジェクトの方針に反する。
 */
function round(n: number): number {
  if (n >= 10) return Math.round(n);
  if (n >= 1) return Math.round(n * 10) / 10;
  return Math.max(0.01, Math.round(n * 100) / 100);
}
