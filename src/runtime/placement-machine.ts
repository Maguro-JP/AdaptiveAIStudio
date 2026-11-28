/**
 * 配置の計画（placement.ts）に渡す、この機械とモデルの実際の値を読む。
 *
 * 計算（placement.ts）と、読むこと（ここ）を分ける。計算は機械を並べて試験し、ここは本物で確かめる。
 *
 * 試験の口（環境変数。本物のメモリやディスクは変わらない。大きいモデルの計画を、小さいモデルで確かめるため）:
 *   AAS_TEST_RAM_BYTES     メモリを、この量として扱う（本物より大きくはしない）
 *   AAS_TEST_PAGING_BYTES  ページングの空きを、この量の決まった大きさとして扱う（広がらない）
 *   AAS_TEST_DISK_BYTES    ディスクの空きを、この量として扱う
 *   AAS_TEST_VRAM_BYTES    読む側が使う GPU の VRAM を、この量として扱う（本物より大きくはしない。GPU の無い機械に GPU は生えない）
 *   AAS_TEST_LOAD_TIMEOUT_MS  読み込みを待つ上限を、この長さにする（時間切れの文と後片づけを、小さいモデルで見るため）
 *   AAS_TEST_LOAD_FAILS    読み込みの最初の N 段を、メモリが足りない形で落とす（段を下げて読み直すのを、小さいモデルで見るため）
 * どれも、立てなければ何も変わらない。使い方は docs/PLACEMENT.md。
 */
import { availableParallelism, totalmem } from 'node:os';
import { readFile, stat, statfs } from 'node:fs/promises';
import { readGguf } from './gguf.ts';
import { extractFacts, headDimOf } from './gguf-spec.ts';
import {
  describePlacement, planPlacement, retryLadder, reportedRam,
  type LadderStep, type PlacementGpu, type PlacementMachine, type PlacementModel, type PlacementPlan, type PlacementWant,
} from './placement.ts';

function forced(name: string, env: Record<string, string | undefined>): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

async function freeOn(dir: string): Promise<number | undefined> {
  try {
    const fs = await statfs(dir);
    return fs.bavail * fs.bsize;
  } catch { return undefined; }
}

/** その場所が無ければ、在る所まで上がって空きを見る（モデルの保存先は、まだ作られていないことがある）。 */
async function freeNear(dir: string): Promise<number | undefined> {
  let at = dir;
  for (let i = 0; i < 32; i += 1) {
    const free = await freeOn(at);
    if (free !== undefined) return free;
    const up = at.replace(/[\\/][^\\/]*[\\/]?$/, '');
    if (!up || up === at) break;
    at = up;
  }
  return undefined;
}

/** Linux の swap の空き（/proc/meminfo の SwapFree）。読めなければ undefined。 */
export function swapFreeFromMeminfo(text: string): number | undefined {
  const m = /^SwapFree:\s+(\d+)\s*kB/m.exec(text);
  return m ? Number(m[1]) * 1024 : undefined;
}

export interface MachineSource {
  /** モデルの保存先。 */
  modelsDir?: string;
  /** 読む側が実際に使う GPU（inproc の backend）。無ければ GPU なしとして数える。 */
  gpu?: { name?: string; vramBytes: number; freeVramBytes?: number };
  /** 計算に使えるコアの数（ライブラリが報じたもの）。無ければ OS の数。 */
  cores?: number;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
}

/**
 * この機械を読む。
 *
 * ページングは OS ごとに違う。Windows と macOS は、OS がページングの場所を自分で広げる（Windows は既定の「システム管理」の
 * とき。手で止めてある機械は見分けていない。私の推測で既定に寄せた）。広がる先はシステムのドライブなので、その空きを見る。
 * Linux の swap は決まった大きさなので、空きをそのまま読む。
 */
export async function detectPlacementMachine(src: MachineSource = {}): Promise<PlacementMachine> {
  const env = src.env ?? process.env;
  const platform = src.platform ?? process.platform;
  const ramBytes = reportedRam(totalmem(), env);
  const disk = forced('AAS_TEST_DISK_BYTES', env);
  const paging = forced('AAS_TEST_PAGING_BYTES', env);

  let swapBytes: number | undefined;
  let swapGrows = false;
  let systemDiskFreeBytes: number | undefined;
  if (paging !== undefined) {
    swapBytes = paging;
  } else if (platform === 'linux') {
    swapBytes = await readFile('/proc/meminfo', 'utf8').then(swapFreeFromMeminfo).catch(() => undefined);
  } else if (platform === 'win32' || platform === 'darwin') {
    swapGrows = true;
    const sys = platform === 'win32' ? `${env.SystemDrive ?? 'C:'}\\` : '/';
    systemDiskFreeBytes = disk ?? await freeOn(sys);
  }
  const modelsDiskFreeBytes = disk ?? (src.modelsDir ? await freeNear(src.modelsDir) : undefined);
  // 試験の口: VRAM を小さく見せる（空きも同じ量までに抑える）。0 なら GPU なしとして数える
  const vramCap = forced('AAS_TEST_VRAM_BYTES', env);
  const vramBytes = src.gpu ? Math.min(src.gpu.vramBytes, vramCap ?? src.gpu.vramBytes) : 0;
  const freeVram = src.gpu?.freeVramBytes !== undefined ? Math.min(src.gpu.freeVramBytes, vramBytes) : undefined;
  const gpus: PlacementGpu[] = src.gpu && vramBytes > 0
    ? [{ vramBytes, ...(src.gpu.name ? { name: src.gpu.name } : {}), ...(freeVram !== undefined ? { freeVramBytes: freeVram } : {}) }]
    : [];
  return {
    ramBytes,
    ...(swapBytes !== undefined ? { swapBytes } : {}),
    swapGrows,
    ...(systemDiskFreeBytes !== undefined ? { systemDiskFreeBytes } : {}),
    ...(modelsDiskFreeBytes !== undefined ? { modelsDiskFreeBytes } : {}),
    gpus,
    cores: src.cores && src.cores > 0 ? src.cores : availableParallelism(),
  };
}

/**
 * GGUF から、計画に要る値を読む。読めないものは入れない（計画の側が見当で数え、見当だと言う）。
 * ファイルが在れば downloaded: true。
 */
export async function placementModelOf(path: string, ref: string, sizeBytes?: number): Promise<PlacementModel> {
  const fileBytes = sizeBytes ?? await stat(path).then((s) => s.size).catch(() => 0);
  const model: PlacementModel = { ref, fileBytes, downloaded: true };
  try {
    const file = await readGguf(path);
    const facts = extractFacts(file);
    if (facts.layers && facts.layers > 0) model.layers = facts.layers;
    if (facts.contextLength && facts.contextLength > 0) model.trainedContext = facts.contextLength;
    const headDim = headDimOf(facts) ?? (facts.embeddingLength && facts.headCount ? Math.floor(facts.embeddingLength / facts.headCount) : undefined);
    const kvHeads = facts.headCountKv || facts.headCount;
    if (facts.layers && headDim && kvHeads) model.kvBytesPerToken = 2 * facts.layers * kvHeads * headDim * 2;
    // MoE は、1 トークンで使うエキスパートが一部だけ。エキスパートの外（注意・埋め込み）は毎回使うので、その分を 15% と見る（私の推測）
    if (facts.expertCount && facts.expertUsedCount && facts.expertCount > facts.expertUsedCount) {
      model.activeRatio = 0.15 + 0.85 * (facts.expertUsedCount / facts.expertCount);
    }
  } catch { /* 読めなくても計画は立てる */ }
  return model;
}

/** 手元のファイルの計画。 */
export async function planFile(
  path: string, ref: string, machine: PlacementMachine, want: PlacementWant = {}, sizeBytes?: number,
): Promise<{ model: PlacementModel; plan: PlacementPlan }> {
  const model = await placementModelOf(path, ref, sizeBytes);
  return { model, plan: planPlacement(model, machine, want) };
}

/** 手元のファイルの、やり直しの段。 */
export async function ladderForFile(
  path: string, ref: string, machine: PlacementMachine, want: PlacementWant = {},
): Promise<{ model: PlacementModel; steps: LadderStep[] }> {
  const model = await placementModelOf(path, ref);
  return { model, steps: retryLadder(model, machine, want) };
}

/** 読む側が実際に使うもの（inproc の `Backend` のうち、ここで要る分）。 */
export interface BackendLike {
  gpu: false | string;
  vramBytes: number;
  devices?: string[];
  cpu?: { cores: number };
}

/** この機械で、そのファイルをどう置くか。読む前に訊く所（選ぶ画面・送る手前）が使う。 */
export async function planHere(o: {
  modelsDir: string; ref: string; path: string; sizeBytes?: number; backend?: BackendLike; want?: PlacementWant;
}): Promise<{ model: PlacementModel; plan: PlacementPlan; machine: PlacementMachine }> {
  const machine = await detectPlacementMachine({
    modelsDir: o.modelsDir,
    ...(o.backend && o.backend.gpu !== false && o.backend.vramBytes > 0
      ? { gpu: { vramBytes: o.backend.vramBytes, ...(o.backend.devices?.[0] ? { name: o.backend.devices[0] } : {}) } }
      : {}),
    ...(o.backend?.cpu?.cores ? { cores: o.backend.cpu.cores } : {}),
  });
  const { model, plan } = await planFile(o.path, o.ref, machine, o.want ?? {}, o.sizeBytes);
  return { model, plan, machine };
}

/**
 * 読み込みを待つ上限。計画の長さをそのまま使う。試験の口（AAS_TEST_LOAD_TIMEOUT_MS）が在れば、その長さ。
 */
export function loadLimitMs(planned: number, env: Record<string, string | undefined> = process.env): number {
  const short = forced('AAS_TEST_LOAD_TIMEOUT_MS', env);
  return short !== undefined && short > 0 ? short : planned;
}

/** 読み込みが上限までに終わらなかった。メモリの失敗ではないので、段を下げて読み直さない。 */
export class LoadTimeoutError extends Error {
  constructor(ref: string, limitMs: number) {
    const waited = limitMs >= 60_000 ? `${Math.round(limitMs / 60_000)} 分` : `${limitMs / 1000} 秒`;
    super(`${ref} の読み込みが ${waited}で終わりませんでした。`
      + 'ディスクが遅いか、メモリが足りずに行き来しています。小さいモデルか、空きの多い機械で試してください。');
    this.name = 'LoadTimeoutError';
  }
}

/**
 * 試験の口（AAS_TEST_LOAD_FAILS）: 読み込みの最初の N 段を、メモリが足りない形で落とす。
 * 落とす段なら文を返す。`state` は読む側が一つ持つ（何段落としたかを数える）。
 */
export function injectedLoadFailure(state: { used: number }, env: Record<string, string | undefined> = process.env): string | undefined {
  const n = forced('AAS_TEST_LOAD_FAILS', env);
  if (n === undefined || state.used >= n) return undefined;
  state.used += 1;
  return `メモリが足りません（試験の口 AAS_TEST_LOAD_FAILS の ${state.used}/${n} 段目）`;
}

/** 入らないときの文。今までの「大きすぎます」に、何があれば動くかを足す。 */
export function refusalText(ref: string, plan: PlacementPlan, model: Pick<PlacementModel, 'fileBytes'>, machine: Pick<PlacementMachine, 'ramBytes'>): string {
  const gb = (n: number): string => (n / 1024 ** 3).toFixed(1);
  return [
    `${ref}: この機械のメモリ（${gb(machine.ramBytes)}GB）に対して大きすぎます（${gb(model.fileBytes)}GB）。`,
    describePlacement(plan),
    ...plan.wouldHelp.slice(1).map((h) => `動かすには: ${h}`),
  ].join('\n');
}
