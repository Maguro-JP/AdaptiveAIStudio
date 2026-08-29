/**
 * スケジューラ — 依存関係が解けたタスクを、レーンの空き枠へ流し込む。
 *
 * 制約は3つ。
 *   1. 依存(deps)が全て完了するまで開始しない
 *   2. レーンごとの並列上限を超えない
 *   3. 書き込み先が重なるタスクを同時に走らせない（書き込みロック）
 */
import { Lane, type LaneConfig } from './lane.ts';

export interface Task<R = unknown> {
  id: string;
  /** 先に完了している必要があるタスクID */
  deps?: string[];
  laneId: string;
  /** このタスクが書き込む可能性のあるパス。重なる相手とは同時実行しない。 */
  writes?: string[];
  run(ctx: TaskRunContext): Promise<R>;
}

export interface TaskRunContext {
  taskId: string;
  laneId: string;
  candidates: string[];
  signal: AbortSignal;
}

export type TaskState = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface TaskOutcome<R = unknown> {
  id: string;
  state: TaskState;
  result?: R;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

export type SchedulerEvent =
  | { type: 'start'; taskId: string; laneId: string }
  | { type: 'end'; taskId: string; state: TaskState; error?: string; ms: number }
  | { type: 'skip'; taskId: string; reason: string }
  | { type: 'idle'; running: string[] };

export class Scheduler {
  readonly #lanes = new Map<string, Lane>();
  readonly #maxTotal: number;

  constructor(lanes: LaneConfig[], maxTotalParallel?: number) {
    for (const l of lanes) this.#lanes.set(l.id, new Lane(l));
    this.#maxTotal = maxTotalParallel ?? Math.max(1, lanes.reduce((n, l) => n + l.parallel, 0));
  }

  lane(id: string): Lane | undefined {
    return this.#lanes.get(id);
  }

  /**
   * タスク群を依存順・並列に実行する。
   * 失敗したタスクに依存するものは skipped になり、全体は止まらない。
   */
  async *run(
    tasks: Task[],
    signal: AbortSignal,
  ): AsyncGenerator<SchedulerEvent, Map<string, TaskOutcome>> {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const outcomes = new Map<string, TaskOutcome>(
      tasks.map((t) => [t.id, { id: t.id, state: 'pending' as TaskState }]),
    );
    const lockedPaths = new Set<string>();
    const running = new Map<string, Promise<SchedulerEvent>>();
    const queue: SchedulerEvent[] = [];
    let inFlight = 0;
    /** 直近に使ったレーン = 今ロードされているモデル。優先して使い続ける。 */
    let lastLaneId: string | undefined;

    const ready = (t: Task): boolean => {
      if (outcomes.get(t.id)!.state !== 'pending') return false;
      for (const dep of t.deps ?? []) {
        const d = outcomes.get(dep);
        if (!d || d.state !== 'done') return false;
      }
      return true;
    };

    const blockedForever = (t: Task): string | undefined => {
      for (const dep of t.deps ?? []) {
        const d = outcomes.get(dep);
        if (!d) return `依存タスクが存在しません: ${dep}`;
        if (d.state === 'failed' || d.state === 'skipped') return `依存タスクが失敗しました: ${dep}`;
      }
      return undefined;
    };

    const launch = (t: Task): void => {
      const lane = this.#lanes.get(t.laneId);
      if (!lane) {
        outcomes.set(t.id, { id: t.id, state: 'skipped', error: `不明なレーン: ${t.laneId}` });
        queue.push({ type: 'skip', taskId: t.id, reason: `不明なレーン: ${t.laneId}` });
        return;
      }

      const writes = t.writes ?? [];
      for (const w of writes) lockedPaths.add(w);
      outcomes.get(t.id)!.state = 'running';
      const startedAt = Date.now();
      outcomes.get(t.id)!.startedAt = startedAt;
      lastLaneId = t.laneId;
      inFlight += 1;
      queue.push({ type: 'start', taskId: t.id, laneId: t.laneId });

      const p = lane
        .withSlot(() => t.run({ taskId: t.id, laneId: t.laneId, candidates: lane.config.candidates, signal }))
        .then(
          (result): SchedulerEvent => {
            outcomes.set(t.id, { id: t.id, state: 'done', result, startedAt, finishedAt: Date.now() });
            return { type: 'end', taskId: t.id, state: 'done', ms: Date.now() - startedAt };
          },
          (e: unknown): SchedulerEvent => {
            const error = e instanceof Error ? e.message : String(e);
            outcomes.set(t.id, { id: t.id, state: 'failed', error, startedAt, finishedAt: Date.now() });
            return { type: 'end', taskId: t.id, state: 'failed', error, ms: Date.now() - startedAt };
          },
        )
        .finally(() => {
          for (const w of writes) lockedPaths.delete(w);
          inFlight -= 1;
          running.delete(t.id);
        });

      running.set(t.id, p);
    };

    for (;;) {
      if (signal.aborted) break;

      // 開始できるものを可能な限り開始する。
      // 既に動いているレーンのタスクを優先し、モデル切替の回数を減らす。
      // 直列リレー（parallel:1 のレーンを渡り歩く）でも切替が最小になる。
      const activeLanes = new Set(
        [...running.keys()].map((id) => byId.get(id)?.laneId).filter((v): v is string => !!v),
      );
      // 走行中のレーン > 直前に使ったレーン（まだロード済み）> その他
      const affinity = (laneId: string): number =>
        activeLanes.has(laneId) ? 2 : laneId === lastLaneId ? 1 : 0;
      const ordered = activeLanes.size === 0 && lastLaneId === undefined
        ? tasks
        : [...tasks].sort((a, b) => affinity(b.laneId) - affinity(a.laneId));

      let launched = false;
      for (const t of ordered) {
        if (inFlight >= this.#maxTotal) break;
        if (!ready(t)) {
          const reason = outcomes.get(t.id)!.state === 'pending' ? blockedForever(t) : undefined;
          if (reason) {
            outcomes.set(t.id, { id: t.id, state: 'skipped', error: reason });
            queue.push({ type: 'skip', taskId: t.id, reason });
          }
          continue;
        }
        const lane = this.#lanes.get(t.laneId);
        if (lane && lane.freeSlots === 0) continue;
        // 書き込み先が誰かとぶつかるなら、その相手が終わるまで待つ
        if ((t.writes ?? []).some((w) => lockedPaths.has(w))) continue;
        launch(t);
        launched = true;
      }

      while (queue.length > 0) yield queue.shift()!;

      const unfinished = tasks.filter((t) => {
        const s = outcomes.get(t.id)!.state;
        return s === 'pending' || s === 'running';
      });
      if (unfinished.length === 0) break;

      if (running.size === 0 && !launched) {
        // 誰も走っておらず、誰も開始できない = デッドロック。取り残しを落とす。
        for (const t of unfinished) {
          const reason = blockedForever(t) ?? '開始条件を満たせませんでした';
          outcomes.set(t.id, { id: t.id, state: 'skipped', error: reason });
          yield { type: 'skip', taskId: t.id, reason };
        }
        break;
      }

      if (running.size > 0) {
        yield { type: 'idle', running: [...running.keys()] };
        const ev = await Promise.race(running.values());
        yield ev;
      }
    }

    await Promise.allSettled(running.values());
    while (queue.length > 0) yield queue.shift()!;
    return outcomes;
  }
}

export { type LaneConfig };
