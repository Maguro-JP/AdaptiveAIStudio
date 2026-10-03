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
import type { Tool, ApprovalRequest, ApprovalAnswer, RequestScope } from './tools/types.ts';
import { mayChangeFiles } from './tools/write-kind.ts';

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
  /**
   * 担当させる役職。指定すると、その気質と権限で働く。
   * 権限はプロンプトではなくツールの割り当てで決まるので、
   * 調べるだけの担当は、そもそも書き込む手段を持たない。
   */
  roleId?: string;
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
  /** 前の担当からの引き継ぎを渡した。誰から誰へ流れたかを見えるようにする。 */
  | { type: 'handoff'; taskId: string; from: string[] }
  | { type: 'running'; taskIds: string[] }
  | { type: 'race'; taskId: string; event: RaceEvent }
  /** 冗長実行の指定を外して一本で走らせた（作業場を変えうるツールを持つ作業は、並べると負けた側の書き込みが残る） */
  | { type: 'raceSkipped'; taskId: string; reason: string }
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
  approve(req: ApprovalRequest): Promise<ApprovalAnswer>;
  /** 書き込む直前の控え。**戻せるようにするため**、書く道具から呼ばれる。 */
  beforeWrite?(relPath: string, previous: string | Buffer | undefined): void;
  /** 書けたときの、実際に書いた分の差分。画面の札をこれで描く。 */
  wrote?(relPath: string, diff: string, created: boolean): void;
  /**
   * 役職ごとの気質と権限を引く。
   * 省略すると全員が同じ system と tools で働く（P2までの動き）。
   */
  /**
   * 役職ごとの決まりとツール。**依頼も渡す。**
   *
   * 渡していなかったとき、端末側（`src/cli/team.ts`）は依頼ごとの履歴と
   * 依頼の文が要るので `assign` を使えず、**役職を見ないまま全部のツールを
   * 配っていた**。役職で絞る側と、依頼ごとに包む側が、同時に成り立つようにする。
   */
  assign?(roleId: string, item: WorkItem): { system: string; tools: Tool[]; request?: RequestScope } | undefined;
  /**
   * 依頼ごとにツールを組む。
   *
   * **ハーネスを通すため。**並列に走らせるので、規則が見る積み重ねは
   * 依頼ごとに分かれていないといけない（`Harness.forTask()`）。
   * 省略すると `tools` をそのまま全員で使う。
   */
  toolsFor?(item: WorkItem): Tool[];
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

  /** その作業の担当が、作業場を変えうるツールを持つか（`#runOne` と同じ選び方で見る）。 */
  #mayChange(item: WorkItem): boolean {
    const assigned = item.roleId ? this.#opts.assign?.(item.roleId, item) : undefined;
    const tools = assigned?.tools ?? this.#opts.toolsFor?.(item) ?? this.#opts.tools;
    return tools.some((t) => mayChangeFiles(t.schema.name));
  }

  /** 1モデルで1件の作業を最後まで走らせる。冗長実行の1本ぶんでもある。 */
  async #runOne(
    item: WorkItem,
    candidates: string[],
    signal: AbortSignal,
    push: (p: TeamProgress) => void,
    /** 先に終わった担当からの引き継ぎ。無ければ空。 */
    handoff = '',
  ): Promise<WorkResult> {
    // 役職が指定されていれば、その気質と権限で働かせる。
    const assigned = item.roleId ? this.#opts.assign?.(item.roleId, item) : undefined;
    const agent = new Agent(this.#orchestrator, {
      candidates,
      system: assigned?.system ?? this.#opts.system,
      tools: assigned?.tools ?? this.#opts.toolsFor?.(item) ?? this.#opts.tools,
      root: this.#opts.root,
      maxTurns: this.#opts.maxTurns,
      temperature: this.#opts.temperature,
      maxTokens: this.#opts.maxTokens,
      approve: this.#opts.approve,
      // 担当ごとの入れ物。共有のツールでも、規則の履歴を担当ごとに分ける（別の担当が読んだことで書けない）。
      ...(assigned?.request ? { request: assigned.request } : {}),
      ...(this.#opts.beforeWrite ? { beforeWrite: this.#opts.beforeWrite } : {}),
      ...(this.#opts.wrote ? { wrote: this.#opts.wrote } : {}),
    });

    const history: ProviderMessage[] = [{
      role: 'user',
      content: handoff ? `${handoff}\n\n---\n\n${item.instruction}` : item.instruction,
    }];
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

    const byId = new Map(items.map((i) => [i.id, i]));
    const tasks: Task[] = items.map((item) => ({
      id: item.id,
      laneId: item.laneId,
      deps: item.deps,
      writes: item.writes,
      run: async (ctx): Promise<WorkResult> => {
        // 前の担当が何を見つけたかを引き継ぐ。
        // 依存を順番の制約としてしか使わないと、後の担当は
        // 前の担当の成果を知らないまま、同じ調査をやり直すことになる。
        const handoff = describeHandoff(ctx.dependencies, byId);

        /*
         * **作業場を変えうるツールを持つ作業は、並べない。**試みはどれも同じ作業場へ書くので、勝ちが決まって残りを止めても、
         * 負けた側が途中まで書いた分は戻らない（「勝者の分＋敗者の途中の分」の混ざった作業場を完了と言う）。一本で走らせ、そう言う
         */
        if (item.raceWith && item.raceWith.length > 0 && this.#mayChange(item)) {
          push({ type: 'raceSkipped', taskId: item.id, reason: '作業場を変えうるツールを持つ作業なので、複数のモデルに同時に書かせず、一本で走らせます' });
        }
        // 冗長実行の指定があれば、同じ作業を複数モデルへ同時に投げる（読むだけの作業に限る）
        else if (item.raceWith && item.raceWith.length > 0) {
          const models = [ctx.candidates[0]!, ...item.raceWith];
          const attempts: Attempt<WorkResult>[] = models.map((modelId) => ({
            label: modelId,
            run: (signal) => this.#runOne(item, [modelId], signal, push, handoff),
          }));
          const outcome = await race(
            attempts,
            (r) => r.finished.reason === 'completed',
            ctx.signal,
            (e) => push({ type: 'race', taskId: item.id, event: e }),
          );
          if (!outcome.winner) {
            // 止めたのなら止めたと言う（race でない道と同じ言い方）
            if (ctx.signal.aborted) throw new Error('aborted: 中断されました');
            throw new Error(`全てのモデルが完了できませんでした (${models.join(', ')})`);
          }
          return outcome.winner.result;
        }

        if (handoff) push({ type: 'handoff', taskId: item.id, from: ctx.dependencies.map((d) => d.id) });
        return this.#runOne(item, ctx.candidates, ctx.signal, push, handoff);
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

/**
 * 前の担当の成果を、次の担当への引き継ぎ文にまとめる。
 *
 * 会社で言えば、席を立つ前の申し送り。
 * 「調べた結果はこうだった」を渡さずに次を始めさせるのは、
 * 分担ではなく、ただの直列実行になってしまう。
 *
 * 渡すのは最終報告だけにする。作業中の思考まで流し込むと、
 * 小さいモデルでは文脈が溢れて、肝心の指示が押し出される。
 */
export function describeHandoff(
  dependencies: Array<TaskOutcome<unknown>>,
  items: Map<string, WorkItem>,
  maxCharsEach = 1500,
): string {
  const parts: string[] = [];
  for (const dep of dependencies) {
    const item = items.get(dep.id);
    const what = item ? item.instruction.split('\n')[0]!.slice(0, 120) : dep.id;

    if (dep.state === 'done') {
      const report = (dep.result as WorkResult | undefined)?.report?.trim();
      // 何も言い残していない担当もいる。その事実は伝えなくてよい。
      if (!report) continue;
      parts.push(`【${dep.id}】${what}\n${clip(report, maxCharsEach)}`);
    } else {
      // 失敗も引き継ぐ。同じ壁に後続がもう一度ぶつかるのは無駄。
      parts.push(`【${dep.id}】${what}\n→ この作業は完了していません（${dep.error ?? dep.state}）。`);
    }
  }

  if (parts.length === 0) return '';
  return [
    '先に終わった担当からの申し送りです。読んでから始めてください。',
    '（同じ調査をやり直す必要はありません。書かれていないことは、確かめられていません）',
    '',
    ...parts,
  ].join('\n');
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n…（以下省略）`;
}
