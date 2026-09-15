/**
 * 常時ロード — モデルを載せたまま保持し、作業開始時の待ちをゼロにする。
 *
 * ローカルは計算が無料なので、空いているVRAMは節約ではなく損失。
 * 使う見込みのあるモデルは先に温めておき、
 * 依頼が来た瞬間に走り出せる状態を保つ。
 *
 * 制約はVRAMだけ。溢れそうなら使っていないものから降ろす。
 */
import type { LoadedModel, LocalRuntime } from './local-runtime.ts';
import type { Plan } from './planner.ts';

export interface WarmPoolOptions {
  runtime: LocalRuntime;
  /** 常駐に使ってよいVRAM。0ならVRAM制約なし（CPU実行）とみなす。 */
  vramBudgetBytes: number;
  /** 同時常駐数の上限。VRAMとは別にプロセス数を抑える。 */
  maxResident?: number;
  /** モデルの実行計画。VRAM見積りに使う。 */
  planOf(ref: string): Plan | undefined;
  onEvent?: (e: WarmEvent) => void;
}

export type WarmEvent =
  | { type: 'warming'; ref: string }
  | { type: 'warm'; ref: string; loadSeconds: number }
  | { type: 'hit'; ref: string }
  | { type: 'evict'; ref: string; reason: string }
  | { type: 'failed'; ref: string; error: string };

interface Entry {
  ref: string;
  loaded: LoadedModel;
  vramBytes: number;
  /** 使用中の数。0より大きい間は降ろさない。 */
  refCount: number;
  lastUsedAt: number;
}

export class WarmPool {
  readonly #opts: WarmPoolOptions;
  readonly #entries = new Map<string, Entry>();
  /** 同じモデルの二重ロードを防ぐ */
  readonly #loading = new Map<string, Promise<LoadedModel>>();

  constructor(opts: WarmPoolOptions) {
    this.#opts = opts;
  }

  get resident(): string[] {
    return [...this.#entries.keys()];
  }

  usedVramBytes(): number {
    let n = 0;
    for (const e of this.#entries.values()) n += e.vramBytes;
    return n;
  }

  /** 起動時に温めておく。失敗しても他のモデルの温めは続ける。 */
  async preload(refs: string[], signal?: AbortSignal): Promise<void> {
    for (const ref of refs) {
      if (signal?.aborted) return;
      try {
        await this.acquire(ref, signal);
        this.release(ref); // 温めるだけ。使用中にはしない
      } catch (e) {
        this.#opts.onEvent?.({
          type: 'failed', ref,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  /**
   * 使える状態にして返す。既に温まっていれば即座に返る。
   * 使い終わったら release すること。
   */
  async acquire(ref: string, signal?: AbortSignal): Promise<LoadedModel> {
    const warm = this.#entries.get(ref);
    if (warm) {
      warm.refCount += 1;
      warm.lastUsedAt = Date.now();
      this.#opts.onEvent?.({ type: 'hit', ref });
      return warm.loaded;
    }

    const inFlight = this.#loading.get(ref);
    if (inFlight) {
      const loaded = await inFlight;
      const entry = this.#entries.get(ref);
      if (entry) { entry.refCount += 1; entry.lastUsedAt = Date.now(); }
      return loaded;
    }

    const vramBytes = this.#opts.planOf(ref)?.vramUsedBytes ?? 0;

    // 進行中の印は最初の await より前に立てる。
    // makeRoom を待っている間に同じ要求が来ると、二重にロードしてしまう。
    const promise = (async () => {
      await this.#makeRoom(vramBytes);
      this.#opts.onEvent?.({ type: 'warming', ref });
      return this.#opts.runtime.ensureLoaded(ref, signal);
    })();
    this.#loading.set(ref, promise);

    let loaded: LoadedModel;
    try {
      loaded = await promise;
    } finally {
      this.#loading.delete(ref);
    }

    this.#entries.set(ref, {
      ref, loaded, vramBytes, refCount: 1, lastUsedAt: Date.now(),
    });
    this.#opts.onEvent?.({ type: 'warm', ref, loadSeconds: loaded.loadSeconds ?? 0 });
    return loaded;
  }

  release(ref: string): void {
    const entry = this.#entries.get(ref);
    if (!entry) return;
    entry.refCount = Math.max(0, entry.refCount - 1);
    entry.lastUsedAt = Date.now();
  }

  /** 新しいモデルを載せる余地を作る。使用中のものは降ろさない。 */
  async #makeRoom(needBytes: number): Promise<void> {
    const maxResident = this.#opts.maxResident ?? Infinity;
    const budget = this.#opts.vramBudgetBytes;

    for (;;) {
      const overCount = this.#entries.size + 1 > maxResident;
      const overVram = budget > 0 && this.usedVramBytes() + needBytes > budget;
      if (!overCount && !overVram) return;

      const victim = this.#leastRecentlyUsedIdle();
      if (!victim) return; // 全部使用中。降ろせないので、そのまま試す

      this.#entries.delete(victim.ref);
      await this.#opts.runtime.unload(victim.ref);
      this.#opts.onEvent?.({
        type: 'evict', ref: victim.ref,
        reason: overVram ? 'VRAMを空けるため' : '常駐数の上限',
      });
    }
  }

  #leastRecentlyUsedIdle(): Entry | undefined {
    let oldest: Entry | undefined;
    for (const e of this.#entries.values()) {
      if (e.refCount > 0) continue;
      if (!oldest || e.lastUsedAt < oldest.lastUsedAt) oldest = e;
    }
    return oldest;
  }

  async shutdown(): Promise<void> {
    const refs = this.resident;
    this.#entries.clear();
    await Promise.all(refs.map((r) => this.#opts.runtime.unload(r)));
  }

  status(): Array<{ ref: string; inUse: boolean; vramBytes: number; idleSeconds: number }> {
    const now = Date.now();
    return [...this.#entries.values()].map((e) => ({
      ref: e.ref,
      inUse: e.refCount > 0,
      vramBytes: e.vramBytes,
      idleSeconds: Math.round((now - e.lastUsedAt) / 1000),
    }));
  }
}
