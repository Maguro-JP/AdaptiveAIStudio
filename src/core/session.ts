/**
 * 対話の核 — 入口から切り離した本体。
 *
 * これまで対話の手順は CLI の中に書かれていた。
 * 動きはするが、画面から同じことをしようとすると、
 * 同じ手順をもう一度書くことになる。書けば必ずずれる。
 *
 * だから核を外に出す。入口（CLI・画面・その先の何か）は
 * 出来事を受け取って見せるだけにして、何が起きるかはここだけが決める。
 *
 * 承認もここでは決めない。呼ぶ側に訊く。
 * 端末なら「y/N」、画面なら押しボタンになるが、
 * **訊かずに進めない**という一点だけは、ここが守る。
 */
import { resolve, join } from 'node:path';
import type { AasConfig } from '../config.ts';
import { buildRegistry } from './build.ts';
import { ChatOrchestrator } from './orchestrator.ts';
import { setupAutopilot, resolveCandidates, stateDir, type AutopilotBundle } from './autopilot-setup.ts';
import { buildHarness } from './harness-setup.ts';
import { Agent } from '../agent/loop.ts';
import { readFileTool, listFilesTool, searchTextTool, writeFileTool } from '../agent/tools/fs.ts';
import { createRunCommandTool } from '../agent/tools/shell.ts';
import { createFetchUrlTool } from '../agent/tools/network.ts';
import { Prefetcher, describeSnapshot } from '../agent/prefetch.ts';
import { Memory, formatRecall } from '../memory/memory.ts';
import { RoleRegistry } from '../roles/registry.ts';
import type { Tool, ApprovalRequest } from '../agent/tools/types.ts';
import { toolsFor } from '../roles/registry.ts';
import { buildSystemPrompt } from '../roles/role.ts';
import { decompose, toWorkItems, type WorkPlan } from '../agent/pm.ts';
import { Team } from '../agent/team.ts';
import { accept, changedBetween, type AcceptanceReport, type MemberReport } from '../agent/acceptance.ts';
import { runVerification } from '../agent/verify.ts';
import { inspectGit } from '../agent/git.ts';
import type { LaneConfig } from './scheduler.ts';
import type { ProviderMessage } from '../providers/contract.ts';

export const DEFAULT_SYSTEM = `あなたはソフトウェア開発の作業者です。与えられた作業ディレクトリで実際に手を動かします。

守ること:
- 推測でファイルを書かない。まず read_file / list_files / search_text で現状を確認する。
- write_file には必ずファイルの全内容を渡す。一部だけ渡すと残りが消える。
- 変更したら run_command でテストやビルドを実行し、結果を確認する。
- 作業が終わったら、何をしたかを簡潔に日本語で報告する。ツールは呼ばない。
- 分からないことは推測せず、質問して止まる。

時間はいくらかかっても構わない。正確さを優先すること。`;

export type SessionEvent =
  | { type: 'text'; delta: string }
  | { type: 'toolStart'; name: string; summary: string }
  | { type: 'toolEnd'; name: string; ok: boolean; summary: string }
  | { type: 'fallback'; from: string; to: string; reason: string }
  | { type: 'recalled'; text: string }
  | { type: 'finished'; reason: string; detail?: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; text: string };

/** 分解して並列に働かせるときの出来事。CLI も画面も、これを見て描く。 */
export type PlanEvent =
  | { type: 'recalled'; text: string }
  | { type: 'planRepaired'; detail: string }
  | { type: 'planned'; plan: WorkPlan }
  | { type: 'taskStart'; taskId: string; laneId: string }
  | { type: 'taskEnd'; taskId: string; state: string; ms: number; error?: string }
  | { type: 'taskSkip'; taskId: string; reason: string }
  | { type: 'running'; taskIds: string[] }
  | { type: 'work'; taskId: string; text: string; ok: boolean }
  | { type: 'verifying'; command: string }
  | { type: 'baselineFailed' }
  | { type: 'accepted'; report: AcceptanceReport }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; text: string };

export interface SessionOptions {
  /** 承認の訊き方。入口ごとに違う。 */
  approve(req: ApprovalRequest): Promise<boolean>;
  /** 画面や端末へ流したいもの。省略可。 */
  onLog?(level: 'info' | 'warn' | 'error', text: string): void;
}

export class Session {
  readonly config: AasConfig;
  readonly root: string;
  readonly candidates: string[];
  readonly memory: Memory;
  readonly roles: RoleRegistry;
  readonly orchestrator: ChatOrchestrator;
  readonly pilot: AutopilotBundle;

  readonly #tools: Tool[];
  /** 権限ごとのツール。役職に応じて配り分けるために持つ。 */
  readonly toolPool: { read: Tool[]; write: Tool[]; execute: Tool[]; network: Tool[] };
  readonly #opts: SessionOptions;
  readonly #prefetch: Prefetcher;
  /** ハーネスの規則へ「いま何を頼まれているか」を渡すための箱。 */
  readonly #holder: { instruction: string };
  readonly #history: ProviderMessage[] = [];
  #running?: AbortController;
  #instruction = '';

  private constructor(init: {
    config: AasConfig; root: string; candidates: string[];
    memory: Memory; roles: RoleRegistry; orchestrator: ChatOrchestrator;
    pilot: AutopilotBundle; prefetch: Prefetcher; opts: SessionOptions;
    holder: { instruction: string };
    toolPool: { read: Tool[]; write: Tool[]; execute: Tool[]; network: Tool[] };
  }) {
    this.config = init.config;
    this.root = init.root;
    this.candidates = init.candidates;
    this.memory = init.memory;
    this.roles = init.roles;
    this.orchestrator = init.orchestrator;
    this.pilot = init.pilot;
    this.toolPool = init.toolPool;
    // 一人で全部やるときは、全ての権限を渡す。
    this.#tools = [
      ...init.toolPool.read, ...init.toolPool.write,
      ...init.toolPool.execute, ...init.toolPool.network,
    ];
    this.#prefetch = init.prefetch;
    this.#opts = init.opts;
    this.#holder = init.holder;
  }

  static async create(config: AasConfig, opts: SessionOptions): Promise<Session> {
    const agentCfg = config.agent ?? {};
    const root = resolve(agentCfg.root ?? process.cwd());

    const registry = buildRegistry(config);
    const orchestrator = new ChatOrchestrator(registry);
    const pilot = await setupAutopilot(config, registry);
    const { candidates, note } = resolveCandidates(config, pilot);
    if (candidates.length === 0) throw new Error(`使えるモデルがありません: ${note}`);

    const log = (level: 'info' | 'warn' | 'error', text: string) => opts.onLog?.(level, text);

    // ハーネス。守らせるのではなく、実行させないことで守る。
    const holder = { instruction: '' };
    const harness = await buildHarness(config, (d) => {
      if (d.outcome === 'denied') log('error', `⛔ ${d.rule}: ${d.reason ?? ''}`);
      else if (d.outcome === 'warned') log('warn', `⚠ ${d.rule}: ${d.reason ?? ''}`);
    });

    // 権限は「配らない」ことで守る。禁じる文言ではなく、手段の有無で決める。
    const netCfg = config.network ?? {};
    const wrap = (tools: Tool[]) => harness.wrapAll(tools, () => holder.instruction);
    const toolPool = {
      read: wrap([readFileTool, listFilesTool, searchTextTool]),
      write: wrap([writeFileTool]),
      execute: wrap([createRunCommandTool({ allowed: agentCfg.allowedCommands })]),
      network: netCfg.enabled === false ? [] : wrap([createFetchUrlTool({
        allowedHosts: netCfg.allowedHosts, maxBytes: netCfg.maxBytes, timeoutMs: netCfg.timeoutMs,
      })]),
    };

    const prefetch = new Prefetcher(root, () => undefined);
    prefetch.start();

    const memory = new Memory(join(stateDir(), 'memory.jsonl'));
    await memory.load();

    const session = new Session({
      config, root, candidates, memory,
      roles: new RoleRegistry(config.roles ?? []),
      orchestrator, pilot, prefetch, opts, holder, toolPool,
    });
    return session;
  }

  get busy(): boolean { return this.#running !== undefined; }

  /** レーン。指定が無ければ候補から作る。空いている資源は節約ではなく損失。 */
  get lanes(): LaneConfig[] {
    const configured = this.config.agent?.lanes;
    return configured && configured.length > 0
      ? configured
      : [{ id: 'main', candidates: this.candidates, parallel: 2 }];
  }

  /**
   * 依頼を分解して、複数の担当に同時に働いてもらい、検収まで通す。
   *
   * 入口ごとに書き直さない。ここが唯一の手順で、
   * CLI も画面も、出てくる出来事を見て描くだけにする。
   */
  async *plan(request: string): AsyncGenerator<PlanEvent, AcceptanceReport | undefined> {
    if (this.#running) {
      yield { type: 'log', level: 'warn', text: 'いま別の作業をしています。' };
      return undefined;
    }
    const ac = new AbortController();
    this.#running = ac;
    this.#holder.instruction = request;

    try {
      const root = this.root;
      const verifyCfg = this.config.agent?.verify ?? {};

      // 作業前の状態。あとで「今回何が変わったか」を出すために要る。
      const gitBefore = await inspectGit(root);
      const dirtyBefore = gitBefore.kind === 'dirty' ? gitBefore.changed : [];

      const command = await this.verifyCommand();
      const baseline = command
        ? await runVerification({ command, root, commandTimeoutMs: verifyCfg.commandTimeoutMs }, ac.signal)
        : undefined;
      const baselineFailed = baseline ? !baseline.passed : false;
      if (baselineFailed) yield { type: 'baselineFailed' };

      const active = this.roles.active();
      const fallbackRoleId = this.roles.get('worker') ? 'worker' : active[0]!.id;
      const pmCtx = {
        lanes: this.lanes,
        roleIds: active.map((r) => r.id),
        fallbackRoleId,
        maxItems: 8,
        // 誰が書き、誰が調べるだけかを渡す。二人目を付ける判断に要る。
        access: Object.fromEntries(active.map((r) => [r.id, r.access as string[]])),
      };

      // 前に分かっていること・駄目だったことを渡してから分解させる。
      const known = this.#recall(request);
      if (known) yield { type: 'recalled', text: known };

      const pm = decompose(
        this.orchestrator,
        known ? `${request}\n\n${known}` : request,
        { candidates: this.candidates, ctx: pmCtx },
        ac.signal,
      );
      let step = await pm.next();
      while (!step.done) {
        if (step.value.type === 'repaired') yield { type: 'planRepaired', detail: step.value.detail };
        step = await pm.next();
      }
      const plan = step.value;
      yield { type: 'planned', plan };

      const team = new Team(this.orchestrator, {
        lanes: this.lanes,
        system: buildSystemPrompt(this.roles.get(fallbackRoleId)!),
        tools: toolsFor(this.roles.get(fallbackRoleId)!, this.toolPool),
        root,
        maxTurns: this.config.agent?.maxTurns,
        temperature: this.config.temperature,
        maxTokens: this.config.maxTokens,
        maxTotalParallel: this.config.agent?.maxTotalParallel,
        approve: this.#opts.approve,
        // 権限は役職から配る。調べるだけの担当は書き込む手段を持たない。
        assign: (roleId) => {
          const role = this.roles.get(roleId);
          if (!role) return undefined;
          return { system: buildSystemPrompt(role), tools: toolsFor(role, this.toolPool) };
        },
      });

      /** 実際に書き換えられたファイル。宣言ではなく、起きたことを見る。 */
      const written = new Set<string>();
      const gen = team.run(toWorkItems(plan), ac.signal);
      let next = await gen.next();
      while (!next.done) {
        const ev = next.value;
        if (ev.type === 'taskStart') yield { type: 'taskStart', taskId: ev.taskId, laneId: ev.laneId };
        else if (ev.type === 'taskEnd') {
          yield { type: 'taskEnd', taskId: ev.taskId, state: ev.state, ms: ev.ms, error: ev.error };
        } else if (ev.type === 'taskSkip') yield { type: 'taskSkip', taskId: ev.taskId, reason: ev.reason };
        else if (ev.type === 'running') yield { type: 'running', taskIds: ev.taskIds };
        else if (ev.type === 'agent' && ev.event.type === 'toolEnd') {
          if (!ev.event.isError && ev.event.call.name === 'write_file') {
            const path = (ev.event.call.args as { path?: string }).path;
            if (path) written.add(path.replace(/\\/g, '/').replace(/^\.\//, ''));
            this.#prefetch.invalidate();
          }
          yield {
            type: 'work', taskId: ev.taskId, ok: !ev.event.isError,
            text: `${ev.event.call.name} ${summarize(ev.event.call.args)}`,
          };
        }
        next = await gen.next();
      }
      const outcomes = next.value;

      // 検査。通らないものを人に見せない。
      let verified: 'passed' | 'failed' | 'skipped' | 'preexisting' = 'skipped';
      let verifyDetail: string | undefined;
      if (command) {
        yield { type: 'verifying', command };
        const r = await runVerification(
          { command, root, commandTimeoutMs: verifyCfg.commandTimeoutMs }, ac.signal);
        if (r.passed) verified = 'passed';
        else if (baselineFailed) { verified = 'preexisting'; verifyDetail = firstLine(r.output); }
        else {
          verified = 'failed';
          verifyDetail = r.output.split('\n').filter((l) => l.trim()).slice(-3).join(' / ');
        }
      }

      const roleOf = new Map(plan.items.map((t) => [t.id, t.roleId]));
      const members: MemberReport[] = [...outcomes.values()].map((o) => ({
        id: o.id,
        roleId: roleOf.get(o.id) ?? '不明',
        state: o.state === 'done' ? 'done' : o.state === 'failed' ? 'failed' : 'skipped',
        ms: (o.finishedAt ?? 0) - (o.startedAt ?? 0),
        report: (o.result as { report?: string } | undefined)?.report,
        error: o.error,
      }));

      const gitAfter = await inspectGit(root);
      const dirtyAfter = gitAfter.kind === 'dirty' ? gitAfter.changed : [];
      const changed = [...new Set([...written, ...changedBetween(dirtyBefore, dirtyAfter)])].sort();

      const report = accept({
        request, summary: plan.summary, members, changed,
        declared: [...new Set(plan.items.flatMap((t) => t.writes ?? []))],
        verified, verifyDetail,
      });
      yield { type: 'accepted', report };

      // 起きたことを覚える。同じ手を二度試さないため。
      this.memory.remember({
        kind: 'attempt',
        title: request,
        detail: [
          plan.summary,
          report.verdict === 'rejected'
            ? `受け取れず: ${report.concerns.map((x) => x.reason).join(' / ')}`
            : `${members.filter((m) => m.state === 'done').length}/${members.length}件完了、検査は${verified}`,
        ].join(' — '),
        tags: changed.slice(0, 5),
        outcome: report.verdict === 'rejected' ? 'failed' : 'worked',
        source: 'plan',
      });
      this.memory.compact();
      return report;
    } catch (e) {
      yield { type: 'log', level: 'error', text: (e as Error).message };
      return undefined;
    } finally {
      this.#running = undefined;
      await this.memory.save().catch(() => undefined);
    }
  }

  /** 検査コマンド。設定 > 先読みが見つけたもの。 */
  async verifyCommand(): Promise<string | undefined> {
    const configured = this.config.agent?.verify?.command;
    if (configured) return configured;
    const snap = await this.#prefetch.snapshotWithin(2000);
    return snap?.commands.test;
  }

  /** いま動いているものを止める。止めても対話は続く。 */
  abort(): void { this.#running?.abort(); }

  /** 指示を受けて、起きたことを順に返す。 */
  async *send(instruction: string): AsyncGenerator<SessionEvent> {
    if (this.#running) {
      yield { type: 'log', level: 'warn', text: 'いま別の作業をしています。' };
      return;
    }
    const ac = new AbortController();
    this.#running = ac;
    this.#instruction = instruction;
    this.#holder.instruction = instruction;

    try {
      // 関係することを思い出して添える。無関係なら何も足さない。
      const recalled = this.#recall(instruction);
      if (recalled) yield { type: 'recalled', text: recalled };

      this.#history.push({
        role: 'user',
        content: recalled ? `${instruction}\n\n---\n${recalled}` : instruction,
      });

      const agent = new Agent(this.orchestrator, {
        candidates: this.candidates,
        system: await this.#system(),
        tools: this.#tools,
        root: this.root,
        maxTurns: this.config.agent?.maxTurns ?? 40,
        temperature: this.config.temperature,
        maxTokens: this.config.maxTokens,
        approve: this.#opts.approve,
      });

      for await (const ev of agent.run(this.#history, ac.signal)) {
        switch (ev.type) {
          case 'thinking':
            yield { type: 'text', delta: ev.delta };
            break;
          case 'toolStart':
            yield { type: 'toolStart', name: ev.call.name, summary: summarize(ev.call.args) };
            break;
          case 'toolEnd':
            if (!ev.isError && ev.call.name === 'write_file') this.#prefetch.invalidate();
            yield {
              type: 'toolEnd', name: ev.call.name, ok: !ev.isError,
              summary: firstLine(ev.result),
            };
            break;
          case 'fallback':
            yield { type: 'fallback', from: ev.from, to: ev.to, reason: ev.reason };
            break;
          case 'finished':
            yield { type: 'finished', reason: ev.reason, detail: ev.detail };
            break;
        }
      }
    } catch (e) {
      // 一度の失敗で対話ごと終わらせない。次の指示は受けられる。
      yield { type: 'log', level: 'error', text: (e as Error).message };
      yield { type: 'finished', reason: 'failed', detail: (e as Error).message };
    } finally {
      this.#running = undefined;
      await this.memory.save().catch(() => undefined);
    }
  }

  #recall(text: string): string {
    const related = this.memory.recall(text, { limit: 6 });
    const failed = this.memory.failedBefore(text, 2);
    const merged = [...related];
    for (const f of failed) if (!merged.some((e) => e.id === f.id)) merged.push(f);
    return formatRecall(merged);
  }

  /** 依頼のたびに、その時点で分かっている状況を渡す。調べ直させるより速い。 */
  async #system(): Promise<string> {
    const base = this.config.system ?? DEFAULT_SYSTEM;
    const snap = await this.#prefetch.snapshotWithin(3000);
    const brief = snap ? describeSnapshot(snap) : '';
    return brief ? `${base}\n\n${brief}` : base;
  }

  get instruction(): string { return this.#instruction; }

  async close(): Promise<void> {
    this.abort();
    this.memory.compact();
    await this.memory.save().catch(() => undefined);
  }
}

function summarize(args: unknown): string {
  if (typeof args !== 'object' || args === null) return '';
  const o = args as Record<string, unknown>;
  const key = ['path', 'command', 'query', 'url'].find((k) => typeof o[k] === 'string');
  return key ? String(o[key]).slice(0, 100) : '';
}

function firstLine(text: string): string {
  return (text.split('\n')[0] ?? '').slice(0, 160);
}
