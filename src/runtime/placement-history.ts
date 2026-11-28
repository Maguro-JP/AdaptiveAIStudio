/**
 * 読み込みと生成の実測を覚える（docs/PLACEMENT.md の「使うほど計画が当たる」）。
 *
 * 計画の速さは見当で、当たらない。実際に読んだ秒数と、生成の tok/s を、モデル・置き方・機械ごとに覚え、次の計画の目安を実測で置き換える。
 * 読めなかった置き方（メモリの不足で落ちた・時間切れ）も覚え、次は最初からその段を避ける。
 *
 * 置く所は AAS_HOME のデータの下の `placement-history.json`。件数に上限を付け、古いものから落とす。
 * 消すのは `clean`（既定は一覧を見せるだけ）。壊れていたら、何も覚えていないものとして読む（読み込みを止めない）。
 * 書くのはモデルを読むプロセスだけ。画面のプロセスは読むだけなので、読むたびにファイルを見る（持ち回らない）。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { stateDir } from '../core/home.ts';
import {
  COMFORTABLE_TPS, FIT_LABEL, GIB, timeoutsFor,
  type Fit, type LadderStep, type PlacementMachine, type PlacementModel, type PlacementPlan,
} from './placement.ts';

/** 覚える件数の上限（私の推測で決めた値。1 件は数百バイト）。 */
export const MAX_HISTORY_ENTRIES = 200;
/** 速さの平均に入れる回数の上限。これより前の回は、少しずつ薄れる（私の推測で決めた値）。 */
export const SPEED_WINDOW = 20;
/** これより短い生成は、速さに入れない（数トークンでは、測った時間のほとんどが誤差。私の推測で決めた値）。 */
export const MIN_SPEED_TOKENS = 8;
/** 読めなかった覚えを使う日数。過ぎたら、もう一度その段から試す（ほかのアプリがメモリを使っていただけ、を引きずらない。私の推測で決めた値）。 */
export const FAILURE_KEEP_DAYS = 30;

/** 読めなかった理由の合図。 */
export type LoadFailure = 'memory' | 'timeout';

export interface HistoryEntry {
  ref: string;
  fileBytes: number;
  /** 機械の構成（VRAM と RAM）。 */
  machine: string;
  gpuLayers: number;
  /** メモリに入り切らず、SSD から読む置き方か。 */
  ssd: boolean;
  contextSize: number;
  sequences: number;
  /** 読み込みの実測（秒）。最後に読めた回。 */
  loadSeconds?: number;
  /** 生成の実測（tok/s）。直近の平均。 */
  tokensPerSecond?: number;
  /** 速さを測った回数。 */
  samples: number;
  /** この置き方で読めなかった理由。読めたら消える。 */
  failed?: LoadFailure;
  failedAt?: string;
  /** 最後に書いた時刻（ISO）。古いものから落とすのに使う。 */
  at: string;
}

export function historyFile(dir: string = stateDir()): string {
  return join(dir, 'placement-history.json');
}

/** 機械の構成を、名前にする。VRAM と RAM を 0.1GB の刻みで（少しの揺れで別の機械にしない）。 */
export function machineKey(machine: Pick<PlacementMachine, 'ramBytes' | 'gpus'>): string {
  const vram = machine.gpus.reduce((sum, g) => sum + g.vramBytes, 0);
  return `vram${(vram / GIB).toFixed(1)}-ram${(machine.ramBytes / GIB).toFixed(1)}`;
}

type Shape = Pick<PlacementPlan, 'gpuLayers' | 'ssdBytes' | 'contextSize' | 'sequences'> & { totalLayers?: number };

function sameModelAndMachine(e: HistoryEntry, model: Pick<PlacementModel, 'ref' | 'fileBytes'>, machine: string): boolean {
  return e.ref === model.ref && e.fileBytes === model.fileBytes && e.machine === machine;
}

/** 重みの置き方が同じか（GPU の層と、SSD から読むか）。速さは、ほぼこれで決まる。 */
function samePlace(e: HistoryEntry, plan: Shape): boolean {
  return e.gpuLayers === plan.gpuLayers && e.ssd === plan.ssdBytes > 0;
}

function sameStep(e: HistoryEntry, plan: Shape): boolean {
  return samePlace(e, plan) && e.contextSize === plan.contextSize && e.sequences === plan.sequences;
}

function isEntry(x: unknown): x is HistoryEntry {
  const e = x as Partial<HistoryEntry> | null;
  return Boolean(e) && typeof e!.ref === 'string' && typeof e!.fileBytes === 'number' && typeof e!.machine === 'string'
    && typeof e!.gpuLayers === 'number' && typeof e!.ssd === 'boolean' && typeof e!.contextSize === 'number'
    && typeof e!.sequences === 'number' && typeof e!.samples === 'number' && typeof e!.at === 'string';
}

export async function readHistory(dir?: string): Promise<HistoryEntry[]> {
  try {
    const raw: unknown = JSON.parse(await readFile(historyFile(dir), 'utf8'));
    const entries = (raw as { entries?: unknown } | null)?.entries;
    return Array.isArray(entries) ? entries.filter(isEntry) : [];
  } catch { return []; }
}

/** 上限を超えたら、古いものから落とす。 */
export function trimHistory(entries: readonly HistoryEntry[], max: number = MAX_HISTORY_ENTRIES): HistoryEntry[] {
  if (entries.length <= max) return [...entries];
  return [...entries].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, max);
}

/** この置き方の実測。同じ重みの置き方のうち、コンテキストウィンドウも同じものを先に、無ければ新しいものを。 */
export function measuredFor(
  entries: readonly HistoryEntry[], model: Pick<PlacementModel, 'ref' | 'fileBytes'>, machine: Pick<PlacementMachine, 'ramBytes' | 'gpus'>, plan: Shape,
): HistoryEntry | undefined {
  const key = machineKey(machine);
  const mine = entries.filter((e) => sameModelAndMachine(e, model, key) && e.ssd === plan.ssdBytes > 0 && typeof e.tokensPerSecond === 'number' && e.samples > 0);
  const hits = mine.filter((e) => samePlace(e, plan));
  const exact = hits.find((e) => sameStep(e, plan)) ?? [...hits].sort((a, b) => (a.at < b.at ? 1 : -1))[0];
  if (exact) return exact;
  /*
   * GPU の層が少しだけ違う実測も使う。画面の計画は、読むときの計画と、いまの VRAM の空きやコンテキストウィンドウの違いで
   * 層の数が数層ずれる。ずれの幅は、2 層か、全部の層の 15% の大きい方まで（私の推測で決めた値）。
   */
  const near = Math.max(2, Math.round((plan.totalLayers ?? 0) * 0.15));
  return mine
    .filter((e) => e.gpuLayers > 0 && plan.gpuLayers > 0 && Math.abs(e.gpuLayers - plan.gpuLayers) <= near)
    .sort((a, b) => Math.abs(a.gpuLayers - plan.gpuLayers) - Math.abs(b.gpuLayers - plan.gpuLayers))[0];
}

/** この置き方で、前に読めなかったか。古い覚え（`FAILURE_KEEP_DAYS` より前）は使わない。 */
export function failedFor(
  entries: readonly HistoryEntry[], model: Pick<PlacementModel, 'ref' | 'fileBytes'>, machine: Pick<PlacementMachine, 'ramBytes' | 'gpus'>, plan: Shape,
  now: number = Date.now(),
): LoadFailure | undefined {
  const key = machineKey(machine);
  const hit = entries.find((e) => sameModelAndMachine(e, model, key) && sameStep(e, plan) && e.failed);
  if (!hit) return undefined;
  const at = Date.parse(hit.failedAt ?? hit.at);
  if (Number.isFinite(at) && now - at > FAILURE_KEEP_DAYS * 86_400_000) return undefined;
  return hit.failed;
}

function roundTps(tps: number): number {
  if (tps >= 10) return Math.round(tps);
  if (tps >= 1) return Math.round(tps * 10) / 10;
  return Math.max(0.01, Math.round(tps * 100) / 100);
}

/**
 * 計画の目安を、実測で置き換える。実測が無ければ、そのまま返す（目安のまま）。
 * 具合（快適・遅い）と待つ長さも、実測の速さで決め直す。SSD から読む計画は、速くても「SSD から読む」のまま。
 */
export function applyHistory(
  plan: PlacementPlan, model: Pick<PlacementModel, 'ref' | 'fileBytes'>, machine: PlacementMachine, entries: readonly HistoryEntry[],
): PlacementPlan {
  if (!plan.possible) return plan;
  const failed = failedFor(entries, model, machine, plan);
  if (failed) plan = { ...plan, failedBefore: failed };
  const hit = measuredFor(entries, model, machine, plan);
  if (!hit || typeof hit.tokensPerSecond !== 'number') return plan;
  const estimatedTps = roundTps(hit.tokensPerSecond);
  const fit: Fit = plan.ssdBytes > 0 ? 'ssd' : estimatedTps >= COMFORTABLE_TPS ? 'comfortable' : 'slow';
  const next: PlacementPlan = {
    ...plan, estimatedTps, fit, fitLabel: FIT_LABEL[fit],
    measured: { tokensPerSecond: estimatedTps, samples: hit.samples, ...(hit.loadSeconds !== undefined ? { loadSeconds: hit.loadSeconds } : {}) },
  };
  next.timeouts = timeoutsFor(next, model, machine);
  return next;
}

/**
 * 前に読めなかった段を、最初から避ける。避けた段は `skipped` に返す（記録に言うため）。
 * 全部の段が読めなかった覚えなら、避けない（避けると読む段が無い。もう一度、上から試す）。
 */
export function avoidFailed(
  steps: readonly LadderStep[], model: Pick<PlacementModel, 'ref' | 'fileBytes'>, machine: Pick<PlacementMachine, 'ramBytes' | 'gpus'>,
  entries: readonly HistoryEntry[], now: number = Date.now(),
): { steps: LadderStep[]; skipped: Array<{ step: LadderStep; why: LoadFailure }> } {
  const skipped: Array<{ step: LadderStep; why: LoadFailure }> = [];
  const kept: LadderStep[] = [];
  for (const step of steps) {
    const why = step.plan.possible ? failedFor(entries, model, machine, step.plan, now) : undefined;
    if (why) skipped.push({ step, why });
    else kept.push(step);
  }
  if (kept.length === 0) return { steps: [...steps], skipped: [] };
  return { steps: kept, skipped };
}

export const FAILURE_LABEL: Record<LoadFailure, string> = { memory: 'メモリが足りずに落ちた', timeout: '時間切れになった' };

/** 実測を書く口。同じプロセスの中の書き込みは、順に行う（読んで・足して・書く、が重ならないように）。 */
export class PlacementHistory {
  readonly #dir: string | undefined;
  #queue: Promise<unknown> = Promise.resolve();
  constructor(dir?: string) { this.#dir = dir; }

  read(): Promise<HistoryEntry[]> { return readHistory(this.#dir); }

  /** 書き終わるのを待つ（試験と、止めるとき用）。 */
  async settled(): Promise<void> { await this.#queue.catch(() => undefined); }

  #update(
    model: Pick<PlacementModel, 'ref' | 'fileBytes'>, machine: Pick<PlacementMachine, 'ramBytes' | 'gpus'>, plan: Shape,
    change: (e: HistoryEntry) => void,
  ): Promise<void> {
    const run = this.#queue.catch(() => undefined).then(async () => {
      const entries = await readHistory(this.#dir);
      const key = machineKey(machine);
      let entry = entries.find((e) => sameModelAndMachine(e, model, key) && sameStep(e, plan));
      if (!entry) {
        entry = {
          ref: model.ref, fileBytes: model.fileBytes, machine: key, gpuLayers: plan.gpuLayers, ssd: plan.ssdBytes > 0,
          contextSize: plan.contextSize, sequences: plan.sequences, samples: 0, at: '',
        };
        entries.push(entry);
      }
      change(entry);
      entry.at = new Date().toISOString();
      const file = historyFile(this.#dir);
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, `${JSON.stringify({ version: 1, entries: trimHistory(entries) }, null, 2)}\n`);
      await rename(tmp, file);
    });
    this.#queue = run;
    // 覚えを書けなくても、読み込みと答えは止めない
    return run.catch(() => undefined);
  }

  /** 読めた。読み込みの秒数を覚え、読めなかった覚えを消す。 */
  recordLoad(model: Pick<PlacementModel, 'ref' | 'fileBytes'>, machine: Pick<PlacementMachine, 'ramBytes' | 'gpus'>, plan: Shape, loadSeconds: number): Promise<void> {
    return this.#update(model, machine, plan, (e) => {
      e.loadSeconds = Math.round(loadSeconds * 10) / 10;
      delete e.failed;
      delete e.failedAt;
    });
  }

  /** 生成の速さ。短すぎる生成（`MIN_SPEED_TOKENS` 未満）は入れない。入れたら true。 */
  recordSpeed(
    model: Pick<PlacementModel, 'ref' | 'fileBytes'>, machine: Pick<PlacementMachine, 'ramBytes' | 'gpus'>, plan: Shape,
    generated: number, seconds: number,
  ): Promise<void> | undefined {
    if (!(generated >= MIN_SPEED_TOKENS) || !(seconds > 0)) return undefined;
    const tps = generated / seconds;
    return this.#update(model, machine, plan, (e) => {
      const n = Math.min(e.samples, SPEED_WINDOW - 1);
      e.tokensPerSecond = e.tokensPerSecond === undefined || n === 0 ? tps : e.tokensPerSecond + (tps - e.tokensPerSecond) / (n + 1);
      e.tokensPerSecond = Math.round(e.tokensPerSecond * 100) / 100;
      e.samples += 1;
    });
  }

  /** 読めなかった。次は、この段を最初から避ける。 */
  recordFailure(model: Pick<PlacementModel, 'ref' | 'fileBytes'>, machine: Pick<PlacementMachine, 'ramBytes' | 'gpus'>, plan: Shape, why: LoadFailure): Promise<void> {
    return this.#update(model, machine, plan, (e) => {
      e.failed = why;
      e.failedAt = new Date().toISOString();
    });
  }
}
