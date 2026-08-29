/**
 * チーム — 複数の作業者(Agent)をレーン上で並列に動かす。
 *
 * P3 で PM が作業指示書(DAG)を自動生成するようになるが、
 * その受け皿となる実行基盤がここ。
 */
import type { ProviderMessage } from '../providers/contract.ts';
import type { ChatOrchestrator } from '../core/orchestrator.ts';
import { Scheduler, type LaneConfig, type Task, type TaskOutcome } from '../core/scheduler.ts';
import { Agent, type AgentEvent } from './loop.ts';
import { race, type Attempt, type RaceEvent } from './race.ts';
import type { Tool, ApprovalRequest } from './tools/types.ts';

export interface WorkItem {
  id: string;
  /** 作業者への指示（自然言語） */
  instruction: string;
  laneId: string;
  deps?: string[];
  /** 書き込む可能性のあるパス。重なる相手とは同時実行されない。 */
  writes?: string[];
  /**
   * 冗長実行に使う追加のモデル。
   * 指定すると同じ作業を同時に走らせ、最初に完了したものを採用する。
   * ローカルは計算が無料なので、遊ばせるくらいなら重ねて投げた方が速い。
   */
  raceWith?: string[];
}

export interface TeamEvent {
  taskId: string;
  laneId: string;
  event: AgentEvent;
}

export type TeamProgress =
  | { type: 'taskStart'; taskId: string; laneId: string }
  | { type: 'taskEnd'; taskId: string; state: string; ms: number; error?: string }
  | { type: 'taskSkip'; taskId: string; reason: string }
  | { type: 'running'; taskIds: string[] }
  | { type: 'race'; taskId: string; event: RaceEvent }
  | (TeamEvent & { type: 'agent' });

export interface TeamOptions {
  lanes: LaneConfig[];
  system: string;
  tools: Tool[];
  root: string;
  maxTurns?: number;
  temperature?: number;
  maxTokens?: number;
  maxTotalParallel?: number;
  approve(req: ApprovalRequest): Promise<boolean>;
}

export interface WorkResult {
  /** 作業者の最終報告（ツールを呼ばずに返した文章） */
  report: string;
  turns: number;
  finished: AgentEvent & { type: 'finished' };
}

export class Team {
  readonly #orchestrator: ChatOrchestrator;
  readonly #opts: TeamOptions;

  constructor(orchestrator: ChatOrchestrator, opts: TeamOptions) {
    this.#orchestrator = orchestrator;
    this.#opts = opts;
  }

  /** 1モデルで1件の作業を最後まで走らせる。冗長実行の1本ぶんでもある。 */
  async #runOne(
    item: WorkItem,
    candidates: string[],
    signal: AbortSignal,
    push: (p: TeamProgress) => void,
  ): Promise<WorkResult> {
    const agent = new Agent(this.#orchestrator, {
      candidates,
      system: this.#opts.system,
      tools: this.#opts.tools,
      root: this.#opts.root,
      maxTurns: this.#opts.maxTurns,
      temperature: this.#opts.temperature,
      maxTokens: this.#opts.maxTokens,
      approve: this.#opts.approve,
    });

    const history: ProviderMessage[] = [{ role: 'user', content: item.instruction }];
    let report = '';
    let turns = 0;
    let finished: (AgentEvent & { type: 'finished' }) | undefined;

    for await (const ev of agent.run(history, signal)) {
      push({ type: 'agent', taskId: item.id, laneId: item.laneId, event: ev });
      if (ev.type === 'thinking') report += ev.delta;
      else if (ev.type === 'turn') turns += 1;
      else if (ev.type === 'finished') finished = ev;
    }

    if (!finished) throw new Error('作業が完了イベントを返しませんでした');
    if (finished.reason !== 'completed') {
      throw new Error(`${finished.reason}${finished.detail ? `: ${finished.detail}` : ''}`);
    }
    return { report: report.trim(), turns, finished };
  }

  async *run(
    items: WorkItem[],
    signal: AbortSignal,
  ): AsyncGenerator<TeamProgress, Map<string, TaskOutcome>> {
    const scheduler = new Scheduler(this.#opts.lanes, this.#opts.maxTotalParallel);

    // 各作業者のイベントを1本の流れに束ねる
    const inbox: TeamProgress[] = [];
    let wake: (() => void) | undefined;
    const push = (p: TeamProgress) => { inbox.push(p); wake?.(); wake = undefined; };

    const tasks: Task[] = items.map((item) => ({
      id: item.id,
      laneId: item.laneId,
      deps: item.deps,
      writes: item.writes,
      run: async (ctx): Promise<WorkResult> => {
        // 冗長実行の指定があれば、同じ作業を複数モデルへ同時に投げる
        if (item.raceWith && item.raceWith.length > 0) {
          const models = [ctx.candidates[0]!, ...item.raceWith];
          const attempts: Attempt<WorkResult>[] = models.map((modelId) => ({
            label: modelId,
            run: (signal) => this.#runOne(item, [modelId], signal, push),
          }));
          const outcome = await race(
            attempts,
            (r) => r.finished.reason === 'completed',
            ctx.signal,
            (e) => push({ type: 'race', taskId: item.id, event: e }),
          );
          if (!outcome.winner) {
            throw new Error(`全てのモデルが完了できませんでした (${models.join(', ')})`);
          }
          return outcome.winner.result;
        }

        return this.#runOne(item, ctx.candidates, ctx.signal, push);
      },
    }));

    const gen = scheduler.run(tasks, signal);
    let pump = gen.next();
    let outcomes: Map<string, TaskOutcome> | undefined;

    for (;;) {
      // 作業者から届いたものを先に流す（進捗が滞留しないように）
      while (inbox.length > 0) yield inbox.shift()!;

      const settled = await Promise.race([
        pump.then((r) => ({ kind: 'sched' as const, r })),
        new Promise<{ kind: 'agent' }>((resolve) => { wake = () => resolve({ kind: 'agent' }); }),
      ]);

      if (settled.kind === 'agent') continue;

      const { r } = settled;
      if (r.done) { outcomes = r.value; break; }

      const ev = r.value;
      if (ev.type === 'start') yield { type: 'taskStart', taskId: ev.taskId, laneId: ev.laneId };
      else if (ev.type === 'end') yield { type: 'taskEnd', taskId: ev.taskId, state: ev.state, ms: ev.ms, error: ev.error };
      else if (ev.type === 'skip') yield { type: 'taskSkip', taskId: ev.taskId, reason: ev.reason };
      else if (ev.type === 'idle') yield { type: 'running', taskIds: ev.running };

      pump = gen.next();
    }

    while (inbox.length > 0) yield inbox.shift()!;
    return outcomes!;
  }
}
