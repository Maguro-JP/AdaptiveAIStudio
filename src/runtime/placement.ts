/**
 * 配置の計画。大きいモデルを「入らない」で断らず、機械の全部で分け合って動かす。
 *
 * GPU に載るだけ載せ、残りはメモリに置き、メモリにも入り切らない分は SSD から読む。
 * 断るのは、どうやっても動かないときだけ（ディスクに置けない・メモリとページングを足しても届かない）。
 * そのときは、何があれば動くかを言う。
 *
 * **ここは計算だけ。**ファイルも機械も読まない（読むのは呼ぶ側）。だから、機械を並べて試験できる。
 *
 * 前提（前の作業から引き継いだ。測った記録はリポジトリに無く、確かめ直していない。docs/PLACEMENT.md の「分かっていること・確かめていないこと」）:
 *   同梱の llama.cpp は、CPU で動かす重みを読み込むときに並べ直す（repack）。並べ直した重みはファイルの写し（mmap）ではなく
 *   普通のメモリに置かれる。だから「mmap なら SSD から読める」は、CPU の分には当てはまらない。メモリを超えた分は
 *   OS のページング（Windows のページ ファイル、Linux の swap）が SSD へ出し入れする。ページングの空きが無い機械では、
 *   メモリを超えた所で OS に止められる（Linux・swap なし・上限 3GB で 5.3GB の 9B を読ませ、止められるのを見た）。
 *   `weightsNeedRam: false` は、並べ直しの無いエンジン（llama-server の `--no-repack`）のためにある。
 */

export const GIB = 1024 ** 3;
export const MIB = 1024 ** 2;

/** この機械での具合。合図は英語、見せる言葉は `FIT_LABEL`。 */
export type Fit = 'comfortable' | 'slow' | 'ssd' | 'no';

export const FIT_LABEL: Record<Fit, string> = {
  comfortable: '快適',
  slow: '動く（遅い）',
  ssd: 'SSD から読む（とても遅い）',
  no: '入らない',
};

/** 入らない理由。合図は英語、見せる言葉は `describePlacement` が組む。 */
export type NoReason = 'disk-full' | 'paging-short' | 'tensor-too-big';

export interface PlacementModel {
  ref: string;
  /** GGUF の大きさ。重みの大きさとして使う（量子化済みなので、ほぼそのままメモリに載る）。 */
  fileBytes: number;
  /** 層の数（GGUF の block_count）。無ければ見当で数える。 */
  layers?: number;
  /** モデルが学習したコンテキストウィンドウ。 */
  trainedContext?: number;
  /** 1 トークンあたりの KV（バイト、f16）。無ければ見当で数える。 */
  kvBytesPerToken?: number;
  /** 1 トークンで実際に使う重みの割合（MoE は小さい）。既定 1。 */
  activeRatio?: number;
  /** いちばん大きいテンソル。分かるときだけ。 */
  largestTensorBytes?: number;
  /** ファイルがもう手元に在るか。無ければ、取ってくる分のディスクも数える。 */
  downloaded?: boolean;
}

export interface PlacementGpu {
  name?: string;
  vramBytes: number;
  /** いま空いている VRAM。分からなければ総量から数える。 */
  freeVramBytes?: number;
}

export interface PlacementMachine {
  ramBytes: number;
  /** ページングの空き（swap・ページ ファイル）。分からなければ undefined。 */
  swapBytes?: number;
  /** OS がページングの場所を自分で広げるか（Windows の既定・macOS）。 */
  swapGrows?: boolean;
  /** ページングが広がる先（システムのドライブ）の空き。 */
  systemDiskFreeBytes?: number;
  /** モデルの保存先の空き。 */
  modelsDiskFreeBytes?: number;
  gpus: PlacementGpu[];
  /** 計算に使えるコアの数。 */
  cores: number;
  /** CPU で動かす重みが、ファイルの写しではなくメモリに置かれるか。同梱のエンジンは true（上の説明）。 */
  weightsNeedRam?: boolean;
  /** メモリの帯域（bytes/s）。無ければ容量から見当。 */
  ramBandwidthBytesPerSec?: number;
  /** VRAM の帯域（bytes/s）。無ければ低めの見当。 */
  vramBandwidthBytesPerSec?: number;
  /** ディスクの読み出し（bytes/s）。無ければ SATA の SSD ほどの見当。 */
  diskBytesPerSec?: number;
}

export interface PlacementWant {
  /** 開きたいコンテキストウィンドウ（1 本あたり）。 */
  context?: number;
  /** これより狭くはしない。既定 4096（モデルがそれより狭ければ、モデルの長さ）。 */
  minContext?: number;
  /** 並列の本数。既定 1。 */
  sequences?: number;
  /** メモリを少なめに使う。コンテキストウィンドウを下限に、並列を 1 本に、バッチを小さくする。 */
  lowRam?: boolean;
  /** GPU に載せる層の上限（やり直しの段で使う）。 */
  maxGpuLayers?: number;
}

export interface PlacementPlan {
  ref: string;
  possible: boolean;
  fit: Fit;
  fitLabel: string;
  /** 入らない理由。possible が false のときだけ。 */
  noReason?: NoReason;
  /** 何があれば動くか。possible が false のときだけ。 */
  wouldHelp: string[];
  gpuLayers: number;
  totalLayers: number;
  /** 層の数を GGUF から読めず、見当で数えた。 */
  layersGuessed: boolean;
  vramBytes: number;
  ramBytes: number;
  /** メモリに入り切らず、SSD から読む分。 */
  ssdBytes: number;
  contextSize: number;
  sequences: number;
  batchSize: number;
  /** KV をどこに置くか。層と同じ側に置かれる。 */
  kv: 'gpu' | 'ram' | 'split';
  threads: number;
  /** ファイルの写しで読む。常に true（読み込みが速く、GPU へ送る分をメモリに二重に持たない）。 */
  useMmap: true;
  /** メモリに固定しない。常に false（入り切らないものを固定すると、機械ごと固まる）。 */
  useMlock: false;
  /** ライブラリのメモリの見張りを外すか。SSD から読む計画は、見張りが「足りない」と断るので外す。 */
  ignoreMemorySafetyChecks: boolean;
  estimatedTps: number;
  /** 何を縮めたか。見せる言葉。 */
  shrunk: string[];
  timeouts: PlacementTimeouts;
}

export interface PlacementTimeouts {
  /** 読み込みを待つ上限。ファイルの大きさとディスクの速さで決める。 */
  loadMs: number;
  /** 最初の 1 トークンまでを待つ上限。 */
  firstTokenMs: number;
  /** トークンが出ない時間の上限。 */
  stallMs: number;
}

/** GGUF から読めないときの、層の数の見当。 */
const GUESSED_LAYERS = 32;
/** GGUF から読めないときの、1 層・1 トークンあたりの KV の見当（8 ヘッド × 128 次元 × K と V × f16）。 */
const GUESSED_KV_PER_LAYER_TOKEN = 2 * 8 * 128 * 2;
/** 計算に使う作業の分。 */
const COMPUTE_BYTES = 400 * MIB;
/** これ以上なら「快適」。 */
export const COMFORTABLE_TPS = 8;

/** VRAM のうち、表示とドライバのために空ける分。 */
function vramHeadroom(gpu: PlacementGpu): number {
  return Math.max(600 * MIB, gpu.vramBytes * 0.08);
}

/** メモリのうち、OS とほかのアプリのために空ける分。 */
export function ramReserve(ramBytes: number): number {
  return Math.max(2 * GIB, ramBytes * 0.15);
}

function usableVram(machine: PlacementMachine): number {
  let sum = 0;
  for (const g of machine.gpus) {
    const base = Math.min(g.vramBytes, g.freeVramBytes ?? g.vramBytes);
    sum += Math.max(0, base - vramHeadroom(g));
  }
  return sum;
}

/** ページングで賄える量。分からなければ undefined（分からないものを「無い」と決めない）。 */
function pagingRoom(machine: PlacementMachine): number | undefined {
  const fixed = machine.swapBytes;
  if (!machine.swapGrows) return fixed;
  if (machine.systemDiskFreeBytes === undefined) return undefined;
  // 広がる先は、空きを全部は当てにしない（OS とほかのファイルの分を 2GB 残す）
  return Math.max(fixed ?? 0, Math.max(0, machine.systemDiskFreeBytes - 2 * GIB));
}

function contextSteps(want: number, min: number): number[] {
  const out: number[] = [];
  for (let c = want; c > min; c = Math.floor(c / 2)) out.push(c);
  out.push(min);
  return out;
}

function gb(n: number): string {
  return `${(n / GIB).toFixed(1)}GB`;
}

/**
 * 計画を立てる。必ず一つ返す。
 *
 * 決める順:
 *   1. 全部を GPU に載せる。コンテキストウィンドウを狭めれば載るなら、狭めて載せる
 *   2. 載る層だけ GPU に載せ、残りはメモリに置く（速さだけが落ちる）
 *   3. メモリに入り切らないなら、コンテキストウィンドウを狭め、並列を減らす（覚えていられる長さが減る）
 *   4. それでも入り切らない分を SSD から読む（とても遅い）
 * 4 でも届かないときだけ「入らない」。
 */
export function planPlacement(model: PlacementModel, machine: PlacementMachine, want: PlacementWant = {}): PlacementPlan {
  const layersGuessed = !(model.layers && model.layers > 0);
  const layers = layersGuessed ? GUESSED_LAYERS : Math.floor(model.layers!);
  const kvPerToken = model.kvBytesPerToken && model.kvBytesPerToken > 0
    ? model.kvBytesPerToken
    : layers * GUESSED_KV_PER_LAYER_TOKEN;
  const weights = Math.max(0, model.fileBytes);
  // 層の外（埋め込みと出口）も一つ分として数える。GPU に全部載せるときだけ一緒に載る
  const perLayer = weights / (layers + 1);
  const trained = model.trainedContext && model.trainedContext > 0 ? Math.floor(model.trainedContext) : 8192;
  const floor = Math.min(trained, Math.max(1, Math.floor(want.minContext ?? 4096)));
  const wantContext = Math.max(floor, Math.min(trained, Math.floor(want.context ?? 8192)));
  const wantSequences = Math.max(1, Math.floor(want.sequences ?? 1));
  const cores = Math.max(1, Math.floor(machine.cores || 1));
  const needRam = machine.weightsNeedRam ?? true;

  const vram = usableVram(machine);
  const ram = Math.max(0, machine.ramBytes - ramReserve(machine.ramBytes));
  const shrunk: string[] = [];

  const base = {
    ref: model.ref, totalLayers: layers, layersGuessed, threads: cores,
    useMmap: true as const, useMlock: false as const,
  };

  // ディスクに置けないものは、取ってこられない
  if (!model.downloaded && machine.modelsDiskFreeBytes !== undefined && weights * 1.1 > machine.modelsDiskFreeBytes) {
    const short = weights * 1.1 - machine.modelsDiskFreeBytes;
    return refuse(base, model, machine, 'disk-full', [
      `モデルの保存先の空きを、あと ${gb(short)} 増やす（要るのは ${gb(weights * 1.1)}、空きは ${gb(machine.modelsDiskFreeBytes)}）`,
      '小さい量子化か、小さいモデルを選ぶ',
    ], wantContext, wantSequences);
  }

  /** その条件での置き方。メモリに入り切らない分は ssd に出る。 */
  const place = (context: number, sequences: number, cap: number) => {
    const kv = kvPerToken * context * sequences;
    let gpuLayers = 0;
    let vramUsed = 0;
    if (vram > 0 && cap > 0) {
      if (cap >= layers && weights + kv + COMPUTE_BYTES <= vram) {
        return { gpuLayers: layers, vramUsed: weights + kv + COMPUTE_BYTES, ramUsed: 0, ssd: 0, kv, full: true };
      }
      // KV は層と同じ側に置かれる。層を一つ載せるごとに、その層の KV も VRAM に要る
      const each = perLayer + kv / layers;
      gpuLayers = Math.max(0, Math.min(layers, cap, Math.floor((vram - COMPUTE_BYTES) / each)));
      // 全部の層が載っても、層の外の分が載らないなら「全部」とは言わない（上の判定で落ちている）
      vramUsed = gpuLayers > 0 ? gpuLayers * each + COMPUTE_BYTES : 0;
    }
    const cpuWeights = weights - gpuLayers * perLayer;
    const cpuKv = kv * (1 - gpuLayers / layers);
    const need = cpuWeights + cpuKv + COMPUTE_BYTES;
    const ssd = Math.max(0, need - ram);
    return { gpuLayers, vramUsed, ramUsed: Math.min(need, ram), ssd, kv, full: false };
  };

  const cap = Math.max(0, Math.min(layers, Math.floor(want.maxGpuLayers ?? layers)));
  let context = want.lowRam ? floor : wantContext;
  let sequences = want.lowRam ? 1 : wantSequences;
  let placed = place(context, sequences, cap);
  if (vram > 0 && cap >= layers && !placed.full) {
    // コンテキストウィンドウを狭めれば全部を GPU に載せられるなら、狭めて載せる（一部でもメモリに回ると、速さが桁で落ちる）
    search: for (const n of sequences > 1 ? [sequences, 1] : [1]) {
      for (const c of contextSteps(context, floor)) {
        const tried = place(c, n, cap);
        if (!tried.full) continue;
        context = c; sequences = n; placed = tried;
        break search;
      }
    }
  }
  if (placed.ssd > 0) {
    // メモリに入り切らない。先にコンテキストウィンドウと並列を縮める（SSD から読むより、ずっとまし）
    for (const c of contextSteps(context, floor)) {
      const tried = place(c, sequences, cap);
      context = c; placed = tried;
      if (tried.ssd === 0) break;
    }
    if (placed.ssd > 0 && sequences > 1) {
      sequences = 1;
      placed = place(context, 1, cap);
    }
  }
  if (context < wantContext) shrunk.push(`コンテキストウィンドウを ${wantContext} から ${context} に狭めました`);
  if (sequences < wantSequences) shrunk.push(`並列を ${wantSequences} 本から ${sequences} 本に減らしました`);
  if (cap < layers && vram > 0) shrunk.push(`GPU に載せる層を ${cap} 層までにしました`);

  // 一つのテンソルが、メモリとページングを足した全部より大きいと、読む場所が無い
  const paging = pagingRoom(machine);
  if (model.largestTensorBytes !== undefined && paging !== undefined
    && model.largestTensorBytes > ram + paging + placed.vramUsed) {
    return refuse(base, model, machine, 'tensor-too-big', [
      `メモリかページングの空きを、あと ${gb(model.largestTensorBytes - ram - paging)} 増やす`,
      '小さい量子化か、小さいモデルを選ぶ',
    ], context, sequences);
  }

  if (placed.ssd > 0 && needRam && paging !== undefined && placed.ssd > paging) {
    const short = placed.ssd - paging;
    const help = [
      machine.swapGrows
        ? `システムのドライブの空きを、あと ${gb(short)} 増やす（ページ ファイルが広がる先です）`
        : `ページングの場所（swap・ページ ファイル）を、あと ${gb(short)} 増やす`,
      `メモリを ${gb(short)} 足す`,
      ...(machine.gpus.length === 0 ? ['GPU のある機械で動かす（載る分はメモリを使いません）'] : []),
      '小さい量子化か、小さいモデルを選ぶ',
    ];
    return refuse(base, model, machine, 'paging-short', help, context, sequences);
  }

  const estimatedTps = estimateTps(model, machine, { ...placed, layers, weights });
  const fit: Fit = placed.ssd > 0 ? 'ssd' : estimatedTps >= COMFORTABLE_TPS ? 'comfortable' : 'slow';
  const lowRam = Boolean(want.lowRam) || fit === 'ssd';
  if (fit === 'ssd') shrunk.push(`メモリに入り切らない ${gb(placed.ssd)} を、SSD から読みます`);
  // 長い入力は、まとめて読むほど速い（GPU のとき）。メモリが苦しいときは小さく刻む
  const batchSize = Math.min(context, lowRam ? 256 : placed.full ? 2048 : placed.gpuLayers > 0 ? 1024 : 512);
  const plan: PlacementPlan = {
    ...base,
    possible: true, fit, fitLabel: FIT_LABEL[fit], wouldHelp: [],
    gpuLayers: placed.gpuLayers,
    vramBytes: Math.round(placed.vramUsed), ramBytes: Math.round(placed.ramUsed), ssdBytes: Math.round(placed.ssd),
    contextSize: context, sequences, batchSize,
    kv: placed.gpuLayers === 0 ? 'ram' : placed.gpuLayers >= layers ? 'gpu' : 'split',
    ignoreMemorySafetyChecks: fit === 'ssd',
    estimatedTps, shrunk,
    timeouts: { loadMs: 0, firstTokenMs: 0, stallMs: 0 },
  };
  plan.timeouts = timeoutsFor(plan, model, machine);
  return plan;
}

function refuse(
  base: Pick<PlacementPlan, 'ref' | 'totalLayers' | 'layersGuessed' | 'threads' | 'useMmap' | 'useMlock'>,
  model: PlacementModel, machine: PlacementMachine, noReason: NoReason, wouldHelp: string[],
  context: number, sequences: number,
): PlacementPlan {
  const plan: PlacementPlan = {
    ...base, possible: false, fit: 'no', fitLabel: FIT_LABEL.no, noReason, wouldHelp,
    gpuLayers: 0, vramBytes: 0, ramBytes: 0, ssdBytes: 0,
    contextSize: context, sequences, batchSize: Math.min(context, 256), kv: 'ram',
    ignoreMemorySafetyChecks: false, estimatedTps: 0, shrunk: [],
    timeouts: { loadMs: 0, firstTokenMs: 0, stallMs: 0 },
  };
  plan.timeouts = timeoutsFor(plan, model, machine);
  return plan;
}

/**
 * 速さの見当（tok/s）。
 *
 * 1 トークンごとに、使う重みを全部読み直す。だから速さは、重みの在る場所の帯域でほぼ決まる。
 * CPU はコアの数でも頭打ちになる（4 コア・GPU なしで 9B Q4_K_M が 2 tok/s 台。同じ日に測った値に合わせた）。
 * SSD から読む分は、ディスクの速さで決まる。**当たらない。桁を見るためのもの。**
 */
export function estimateTps(
  model: PlacementModel, machine: PlacementMachine,
  placed: { gpuLayers: number; ssd: number; layers: number; weights: number },
): number {
  const active = Math.min(1, Math.max(0.01, model.activeRatio ?? 1));
  const perLayer = placed.weights / (placed.layers + 1);
  const gpuBytes = Math.min(placed.weights, placed.gpuLayers >= placed.layers ? placed.weights : placed.gpuLayers * perLayer) * active;
  const cpuAll = (placed.weights - gpuBytes / active) * active;
  const ssdBytes = Math.min(cpuAll, placed.ssd * active);
  const ramBytes = cpuAll - ssdBytes;
  const ramBw = machine.ramBandwidthBytesPerSec ?? (machine.ramBytes >= 32 * GIB ? 70 * GIB : 45 * GIB);
  const vramBw = machine.vramBandwidthBytesPerSec ?? 200 * GIB;
  const diskBw = machine.diskBytesPerSec ?? 0.5 * GIB;
  // CPU の計算の頭打ち。1 コアが 1 秒に通せる重みの量（測った値からの見当）
  const cpuBw = Math.min(ramBw * 0.65, Math.max(1, machine.cores) * 3.2 * GIB);
  const seconds = (gpuBytes > 0 ? gpuBytes / (vramBw * 0.65) : 0)
    + (ramBytes > 0 ? ramBytes / cpuBw : 0)
    // ページングは行ったり来たりするので、読み出しの速さの半分も出ない
    + (ssdBytes > 0 ? ssdBytes / (diskBw * 0.4) : 0);
  if (!(seconds > 0) || !Number.isFinite(seconds)) return 0;
  const tps = 1 / seconds;
  // 極端に遅い値を 0 に丸めない（0 は「動かない」と読まれる）
  if (tps >= 10) return Math.round(tps);
  if (tps >= 1) return Math.round(tps * 10) / 10;
  return Math.max(0.01, Math.round(tps * 100) / 100);
}

/**
 * 待つ長さを、計画に合わせる。
 *
 * 決め打ちの上限は、小さいモデルに合わせた長さになる。大きいモデルは、読み込みに何分もかかり、
 * 1 トークンに何十秒もかかる。動いているものを「停滞」で止めないよう、計画の速さから延ばす。短くはしない。
 */
export function timeoutsFor(
  plan: Pick<PlacementPlan, 'fit' | 'contextSize' | 'estimatedTps' | 'ssdBytes'>,
  model: Pick<PlacementModel, 'fileBytes'>, machine: Pick<PlacementMachine, 'diskBytesPerSec'>,
): PlacementTimeouts {
  // 読み込み: 遅いディスク（HDD の 60MB/s）でも読み切れる長さの 2 倍。SSD から読む計画は、並べ直しながらページングするのでさらに 4 倍
  const disk = Math.max(20 * MIB, Math.min(machine.diskBytesPerSec ?? 60 * MIB, 60 * MIB));
  const readSeconds = model.fileBytes / disk;
  const loadMs = Math.round(Math.max(600, readSeconds * 2 * (plan.fit === 'ssd' ? 4 : 1)) * 1000);
  const tps = plan.estimatedTps > 0 ? plan.estimatedTps : 0.05;
  // 入力を読む速さは、書く速さの数倍（まとめて読める）。SSD から読むときは、ほぼ同じ
  const readTps = tps * (plan.fit === 'ssd' ? 1.5 : 4);
  const firstTokenMs = Math.round(Math.max(600, (plan.contextSize / readTps) * 2) * 1000);
  // 1 トークンにかかる時間の 30 倍は待つ
  const stallMs = Math.round(Math.max(120, 30 / tps) * 1000);
  return { loadMs, firstTokenMs, stallMs };
}

/** 一行で言う。モデルを選ぶ画面と、読み込むときの記録に出す。 */
export function describePlacement(plan: PlacementPlan): string {
  if (!plan.possible) {
    const why = plan.noReason === 'disk-full' ? 'ディスクの空きが足りません'
      : plan.noReason === 'tensor-too-big' ? '一つのテンソルが、メモリとページングを足した全部より大きいです'
        : 'メモリとページングの空きを足しても届きません';
    return `この PC では: 入りません（${why}）。${plan.wouldHelp[0] ? `動かすには: ${plan.wouldHelp[0]}` : ''}`;
  }
  const parts: string[] = [];
  if (plan.gpuLayers >= plan.totalLayers) parts.push('全部を GPU に載せます');
  else if (plan.gpuLayers > 0) parts.push(`GPU に ${plan.gpuLayers}/${plan.totalLayers} 層、残りはメモリ`);
  else parts.push('GPU は使わず、メモリに載せて CPU で動かします');
  if (plan.ssdBytes > 0) parts.push(`足りない分（${gb(plan.ssdBytes)}）は SSD から読みます`);
  const speed = plan.estimatedTps > 0 ? `目安 ${plan.estimatedTps} tok/s` : '';
  const slow = plan.fit === 'ssd' ? '。とても遅いですが、動きます' : plan.fit === 'slow' ? '。遅いですが、動きます' : '';
  return `この PC では: ${parts.join('、')}。${speed}${slow}`;
}

/** 「計画を見る」の中身。一行ずつ。 */
export function placementDetail(plan: PlacementPlan, model: Pick<PlacementModel, 'fileBytes'>): string[] {
  const lines = [
    `具合: ${plan.fitLabel}`,
    `モデルの大きさ: ${gb(model.fileBytes)}`,
  ];
  if (!plan.possible) {
    lines.push(describePlacement(plan));
    for (const h of plan.wouldHelp) lines.push(`動かすには: ${h}`);
    return lines;
  }
  lines.push(
    `GPU: ${plan.gpuLayers}/${plan.totalLayers} 層${plan.layersGuessed ? '（層の数は見当）' : ''}・VRAM ${gb(plan.vramBytes)}`,
    `メモリ: ${gb(plan.ramBytes)}`,
    `SSD から読む分: ${plan.ssdBytes > 0 ? gb(plan.ssdBytes) : 'なし'}`,
    `コンテキストウィンドウ: ${plan.contextSize} × 並列 ${plan.sequences} 本（KV は${plan.kv === 'gpu' ? ' GPU' : plan.kv === 'ram' ? 'メモリ' : ' GPU とメモリに分けて'}）`,
    `バッチ: ${plan.batchSize}・スレッド: ${plan.threads}`,
    `速さの目安: ${plan.estimatedTps} tok/s`,
    `待つ上限: 読み込み ${Math.round(plan.timeouts.loadMs / 60000)} 分・最初の 1 トークン ${Math.round(plan.timeouts.firstTokenMs / 60000)} 分・無音 ${Math.round(plan.timeouts.stallMs / 1000)} 秒`,
  );
  for (const s of plan.shrunk) lines.push(`縮めたもの: ${s}`);
  return lines;
}

/** やり直しの一段。 */
export interface LadderStep {
  /** 合図。 */
  id: 'as-planned' | 'fewer-gpu-layers' | 'smaller-context' | 'cpu-only';
  /** 見せる一行。 */
  say: string;
  plan: PlacementPlan;
}

/**
 * 読み込みに失敗したときの、やり直しの段。上から順に試す。
 *
 *   1. 計画どおり
 *   2. GPU の層を半分に（VRAM の確保で落ちる機械がある。見積もりは外れる）
 *   3. コンテキストウィンドウを下限に・並列を 1 本に
 *   4. GPU を使わず、メモリと SSD で
 * 同じ中身の段は並べない（GPU の無い機械で、同じ読み込みを 4 回繰り返さない）。
 */
export function retryLadder(model: PlacementModel, machine: PlacementMachine, want: PlacementWant = {}): LadderStep[] {
  const first = planPlacement(model, machine, want);
  const steps: LadderStep[] = [{ id: 'as-planned', say: '計画どおりに読みます', plan: first }];
  if (!first.possible) return steps;
  // バッチだけが違う段は、同じものとして並べない（数GBを読み直すほどの差が無い）
  const same = (a: PlacementPlan, b: PlacementPlan) => a.gpuLayers === b.gpuLayers && a.contextSize === b.contextSize
    && a.sequences === b.sequences;
  const add = (id: LadderStep['id'], say: (p: PlacementPlan) => string, plan: PlacementPlan) => {
    if (!plan.possible || steps.some((s) => same(s.plan, plan))) return;
    steps.push({ id, say: say(plan), plan });
  };
  if (first.gpuLayers > 0) {
    const half = Math.floor(first.gpuLayers / 2);
    add('fewer-gpu-layers', (p) => `GPU に載せる層を ${first.gpuLayers} から ${p.gpuLayers} に減らして、読み直します`,
      planPlacement(model, machine, { ...want, maxGpuLayers: half }));
  }
  const fewer = steps.at(-1)!.plan;
  // コンテキストウィンドウがもう下限なら、変わるのは並列だけ。変わらないものを「狭めて」と言わない
  add('smaller-context', (p) => (p.contextSize < fewer.contextSize
    ? `コンテキストウィンドウを ${p.contextSize} に狭めて、読み直します`
    : `並列を ${fewer.sequences} 本から ${p.sequences} 本に減らして、読み直します`),
    planPlacement(model, machine, { ...want, lowRam: true, maxGpuLayers: fewer.gpuLayers }));
  add('cpu-only', () => 'GPU を使わず、メモリと SSD で読み直します',
    planPlacement(model, { ...machine, gpus: [] }, { ...want, lowRam: true }));
  return steps;
}

/** メモリか VRAM が足りなくて落ちたか。やり直す値打ちがあるのは、このときだけ（ファイルが壊れているなら、何度読んでも同じ）。 */
export function isMemoryFailure(e: unknown): boolean {
  const text = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  return /InsufficientMemory|too large for the available|out of memory|failed to allocate|alloc(ation)? fail|bad_alloc|ErrorOutOfDeviceMemory|CUDA error|VRAM|メモリが足りません|Failed to create context|failed to (create|load) (the )?(context|model)/i.test(text);
}

/**
 * 段を順に試す。メモリの失敗なら次の段へ、それ以外はその場で投げる。
 * 一段ごとに `say` を呼ぶ（記録と画面に一行）。
 */
export async function runLadder<T>(
  steps: readonly LadderStep[],
  load: (step: LadderStep) => Promise<T>,
  say: (line: string) => void,
): Promise<{ value: T; step: LadderStep }> {
  let last: unknown;
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i]!;
    if (i > 0) say(`やり直し ${i}/${steps.length - 1}: ${step.say}`);
    try {
      return { value: await load(step), step };
    } catch (e) {
      last = e;
      if (!isMemoryFailure(e)) throw e;
      say(`読み込めませんでした（${e instanceof Error ? e.message : String(e)}）`);
    }
  }
  throw last;
}

/**
 * 機械のメモリ。試験の口: `AAS_TEST_RAM_BYTES` が在れば、その量として扱う
 * （大きいモデルの計画を、小さいモデルで確かめるため。本物のメモリは変わらない）。
 */
export function reportedRam(real: number, env: Record<string, string | undefined> = process.env): number {
  const forced = Number(env.AAS_TEST_RAM_BYTES);
  return Number.isFinite(forced) && forced > 0 ? Math.min(real, forced) : real;
}
