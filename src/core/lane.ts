/**
 * レーン — 同時にロードしておくモデルの単位。
 *
 * VRAM 8GB でモデル数を増やす方向は行き止まりなので、
 * レーン数を絞り、レーン内の並列度で稼ぐ。
 * 同一モデルへの並列リクエストは、追加VRAMがKVキャッシュ分で済む。
 */
export interface LaneConfig {
  id: string;
  /** このレーンが使うモデル候補。先頭から順にフォールバックする。 */
  candidates: string[];
  /** 同時に流せるタスク数。VRAMではなくKVキャッシュで決まる。 */
  parallel: number;
}

/** 空き枠を待てるセマフォ。レーンの並列上限を表す。 */
export class Semaphore {
  #available: number;
  readonly #waiting: Array<() => void> = [];

  constructor(limit: number) {
    this.#available = Math.max(1, limit);
  }

  get available(): number {
    return this.#available;
  }

  async acquire(): Promise<void> {
    if (this.#available > 0) {
      this.#available -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.#waiting.push(resolve));
  }

  release(): void {
    const next = this.#waiting.shift();
    if (next) next(); // 枠は解放せず、待っている次の人へ直接渡す
    else this.#available += 1;
  }
}

export class Lane {
  readonly config: LaneConfig;
  readonly #semaphore: Semaphore;

  constructor(config: LaneConfig) {
    this.config = config;
    this.#semaphore = new Semaphore(config.parallel);
  }

  get id(): string { return this.config.id; }
  get freeSlots(): number { return this.#semaphore.available; }

  async withSlot<T>(fn: () => Promise<T>): Promise<T> {
    await this.#semaphore.acquire();
    try {
      return await fn();
    } finally {
      this.#semaphore.release();
    }
  }
}
