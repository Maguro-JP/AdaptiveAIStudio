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
import { ProposalQueue, type Proposal } from '../agent/proposals.ts';
import { findLeads, investigationPrompt, parseProposal } from '../agent/initiative.ts';
import { IdleScheduler, type ModeStat } from '../harness/idle.ts';
import { BUILTIN_IDLE_MODES, MODE_ROLE, promptFor } from '../harness/idle-modes.ts';
import { DutyRoster, type DutyRecord } from '../harness/duties.ts';
import { BUILTIN_DUTIES } from '../harness/builtin-duties.ts';
import { readFile as readJson, writeFile as writeJson } from 'node:fs/promises';
import { RoleRegistry } from '../roles/registry.ts';
import type { Tool, ApprovalRequest } from '../agent/tools/types.ts';
import { toolsFor } from '../roles/registry.ts';
import { buildSystemPrompt } from '../roles/role.ts';
import { decompose, toWorkItems, type WorkPlan } from '../agent/pm.ts';
import { findNewerOllama, describeNewer } from '../runtime/model-updates.ts';
import { Team } from '../agent/team.ts';
import { accept, changedBetween, type AcceptanceReport, type MemberReport } from '../agent/acceptance.ts';
import { runVerification, verifyLoop, type VerifyEvent, type VerifyResult } from '../agent/verify.ts';
import { snapshotTests } from '../agent/test-integrity.ts';
import { BaselineProbe, type BaselineOutcome } from '../agent/baseline.ts';
import { Checkpoint } from '../harness/checkpoint.ts';
import type { Harness } from '../harness/harness.ts';
import { inspectGit } from '../agent/git.ts';
import { diffStat } from '../agent/diff.ts';
import { inspectDependencies, describeDependencies } from '../agent/dependencies.ts';
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
  /** 本文に紛れていた呼び出しを拾ったとき。直したことは黙らない。 */
  | { type: 'salvaged'; name: string }
  | { type: 'toolEnd'; name: string; ok: boolean; summary: string }
  | { type: 'fallback'; from: string; to: string; reason: string }
  | { type: 'recalled'; text: string }
  | { type: 'finished'; reason: string; detail?: string }
  /** 作業前の状態。今回の失敗と、前からの失敗を切り分けるために要る。 */
  | {
      type: 'baseline'; command: string; passed: boolean;
      /** 覚えていた結果を使ったか。毎回流さないことを画面に出すため。 */
      cached?: boolean;
      /** 時間切れなどで切り分けができないとき。passed は false になるが失敗ではない。 */
      unknown?: boolean;
      detail?: string;
    }
  /** 検証ループの様子。書いて終わりにしないための往復。 */
  | { type: 'verify'; event: VerifyEvent }
  | { type: 'rolledBack'; paths: string[] }
  /** 書き換えの中身。何がどう変わったかは、文章より差分の方が速い。 */
  | { type: 'diff'; path: string; diff: string; added: number; removed: number; created: boolean }
  /** 検証まで含めた、この依頼の結末。 */
  | { type: 'settled'; reason: string; verified: boolean; seconds: number; detail?: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; text: string };

/** 分解して並列に働かせるときの出来事。CLI も画面も、これを見て描く。 */
export type PlanEvent =
  | { type: 'recalled'; text: string }
  | { type: 'planRepaired'; detail: string }
  | { type: 'planned'; plan: WorkPlan }
  | { type: 'taskStart'; taskId: string; laneId: string }
  | { type: 'taskEnd'; taskId: string; state: string; ms: number; error?: string }
  | { type: 'taskSkip'; taskId: string; reason: string }
  /** 前の担当の成果を、次の担当へ渡した */
  | { type: 'handoff'; taskId: string; from: string[] }
  | { type: 'running'; taskIds: string[] }
  | { type: 'work'; taskId: string; text: string; ok: boolean }
  | { type: 'diff'; path: string; diff: string; added: number; removed: number; created: boolean }
  | { type: 'verifying'; command: string }
  | { type: 'baselineFailed' }
  | { type: 'accepted'; report: AcceptanceReport }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; text: string };

/** 暇なときに考えたことの流れ。 */
export type ThinkEvent =
  | { type: 'chose'; modeId: string; codename: string; name: string; roleCodename: string; reason: string; isDuty: boolean }
  | { type: 'noFinding'; codename: string }
  | { type: 'proposal'; proposal: Proposal; codename: string };

export interface SessionOptions {
  /** 承認の訊き方。入口ごとに違う。 */
  approve(req: ApprovalRequest): Promise<boolean>;
  /** 画面や端末へ流したいもの。省略可。 */
  onLog?(level: 'info' | 'warn' | 'error', text: string): void;
  /**
   * 暇なときの思考に、外を読むことを許すか。既定は許す。
   * 完全に閉じたいときだけ false にする。
   */
  approveThinking?: boolean;
}

export class Session {
  readonly config: AasConfig;
  readonly root: string;
  readonly candidates: string[];
  readonly memory: Memory;
  /** 溜まった提案。実行はしない。溜めて、人に選ばせる。 */
  readonly proposals: ProposalQueue;
  /** 何を考えるかの配分。無駄に考えないための仕組み。 */
  readonly idle: IdleScheduler;
  /** 日課。変化が無くてもやることを、時間で起こす。 */
  readonly duties: DutyRoster;
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
  readonly #harness: Harness;
  readonly #history: ProviderMessage[] = [];
  #running?: AbortController;
  #instruction = '';
  /** 書き込みの直前に作られた差分。承認の問い合わせを通り道にして拾う。 */
  readonly #diffs = new Map<string, { diff: string; created: boolean }>();
  /** 提案がどの思考から出たか。採否をその思考の実績に返すために持つ。 */
  readonly #origin = new Map<string, string>();
  #lastChangeAt = Date.now();
  /** 作業前検査。同じ命令なら一度しか流さない。 */
  #baseline?: BaselineProbe;

  private constructor(init: {
    config: AasConfig; root: string; candidates: string[];
    memory: Memory; roles: RoleRegistry; orchestrator: ChatOrchestrator;
    proposals: ProposalQueue; idle: IdleScheduler; duties: DutyRoster;
    pilot: AutopilotBundle; prefetch: Prefetcher; opts: SessionOptions;
    holder: { instruction: string };
    harness: Harness;
    toolPool: { read: Tool[]; write: Tool[]; execute: Tool[]; network: Tool[] };
  }) {
    this.config = init.config;
    this.root = init.root;
    this.candidates = init.candidates;
    this.memory = init.memory;
    this.proposals = init.proposals;
    this.idle = init.idle;
    this.duties = init.duties;
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
    this.#harness = init.harness;
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

    const initCfg = config.initiative ?? {};
    const proposals = new ProposalQueue(join(stateDir(), 'proposals.json'));
    await proposals.load();

    // 使う思考モードだけを配る。減らせば、その分だけ静かになる。
    const idle = new IdleScheduler(
      BUILTIN_IDLE_MODES.filter((m) => !initCfg.modes || initCfg.modes.includes(m.id)),
      {
        perHour: initCfg.budgetPerHour ?? 12,
        minGapMs: (initCfg.minGapMinutes ?? 10) * 60_000,
        maxPerChange: initCfg.maxPerChange ?? 2,
      },
    );
    try {
      idle.restore(JSON.parse(await readJson(join(stateDir(), 'idle.json'), 'utf8')) as ModeStat[]);
    } catch { /* 記録が無いのは正常 */ }

    const duties = new DutyRoster(BUILTIN_DUTIES);
    try {
      duties.restore(JSON.parse(await readJson(join(stateDir(), 'duties.json'), 'utf8')) as DutyRecord[]);
    } catch { /* 記録が無いのは正常 */ }

    const session = new Session({
      config, root, candidates, memory,
      roles: new RoleRegistry(config.roles ?? []),
      orchestrator, pilot, prefetch, opts, holder, toolPool, harness,
      proposals, idle, duties,
    });
    return session;
  }

  get busy(): boolean { return this.#running !== undefined; }

  /**
   * 承認の問い合わせを通り道にして、差分を拾っておく。
   * 差分は道具の中で作られていて、承認以外に外へ出る道が無いため。
   */
  readonly #approve = async (req: ApprovalRequest): Promise<boolean> => {
    if (req.kind === 'write') this.#diffs.set(req.path, { diff: req.diff, created: req.created });
    return this.#opts.approve(req);
  };

  /** 直近の書き換えの差分。取り出したら手放す。 */
  #takeDiff(path: string): { diff: string; created: boolean } | undefined {
    const key = path.replace(/\\/g, '/').replace(/^\.\//, '');
    for (const candidate of [path, key]) {
      const found = this.#diffs.get(candidate);
      if (found) { this.#diffs.delete(candidate); return found; }
    }
    return undefined;
  }

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
      // 作業前検査は切り分けのためだけのもの。切っても作業後の検査は残す。
      const probed = command && verifyCfg.baseline !== false
        ? await this.measureBaseline(command, ac.signal)
        : undefined;
      const baseline = probed?.result;
      // 「分からない」は失敗ではない。切り分けをやめるだけ。
      const baselineFailed = probed?.status === 'failed';
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
        approve: this.#approve,
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
        else if (ev.type === 'handoff') yield { type: 'handoff', taskId: ev.taskId, from: ev.from };
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
          const shown = this.#diffFor(ev.event.call.name, ev.event.call.args, ev.event.isError);
          if (shown) yield shown;
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
      this.markChanged();
      return report;
    } catch (e) {
      yield { type: 'log', level: 'error', text: (e as Error).message };
      return undefined;
    } finally {
      this.#running = undefined;
      await this.memory.save().catch(() => undefined);
    }
  }

  /**
   * 暇なときの思考。
   *
   * 何を考えるかはハーネス側のスケジューラが決める。
   * 「変わっていないのに考え直す」「予算を超えて考える」
   * 「役に立たなかった考え方を繰り返す」を、そこで止める。
   *
   * 考えた結果は提案として溜めるだけで、実行はしない。
   * 勝手に手を動かされるのと、勝手に考えてくれるのは、別の話。
   */
  async *think(): AsyncGenerator<ThinkEvent, boolean> {
    if (this.config.initiative?.enabled === false) return false;
    if (this.#running) return false;

    const now = Date.now();
    const due = this.duties.due(now).map((s) => ({
      dutyId: s.duty.id, modeId: s.duty.modeId,
      codename: s.duty.codename, isCatchUp: s.isCatchUp,
    }));

    const decision = await this.idle.choose(
      { lastChangeAt: this.#lastChangeAt, openProposals: this.proposals.open().length, now },
      due,
    );
    if (!decision.mode) return false;

    const mode = decision.mode;
    const role = this.roles.get(MODE_ROLE[mode.id] ?? 'scout') ?? this.roles.get('scout')!;
    const snap = await this.#prefetch.snapshotWithin(3000);

    let context = snap ? describeSnapshot(snap) : '';
    let fingerprint = `${mode.id}:${Date.now()}`;
    let files: string[] = [];

    // 外へ出る前に、手元を数えて渡す。
    // 「何か新しい話は無いか」と漠然と出しても、雑音しか持ち帰らない。
    // 「この依存のどれが古いか」なら、答えは一つに定まる。
    if (mode.id === 'briefing') {
      const deps = await inspectDependencies(this.root);
      context = `${context}\n\n${describeDependencies(deps)}`;

      // 新しいモデルが出ていないかも、外の情報として拾う。
      // ローカルで動かす以上、古いものを使い続ける理由が無い。
      // ただし**人が思い出したときだけ**確かめる作りでは、結局は古いまま使い続ける。
      // 機械が定期的に見に行き、出ていたら提案として上げる。
      try {
        // 「provider:model」から model 側だけを取る。model にも : が入る。
        const using = this.candidates
          .filter((c) => c.startsWith('ollama:'))
          .map((c) => c.slice('ollama:'.length));
        if (using.length > 0) {
          const newer = await findNewerOllama({ installed: using });
          if (newer.length > 0) context = `${context}\n\n${describeNewer(newer)}`;
        }
      } catch {
        // 配布元へ行けないのは、この思考を止める理由にはならない。
        // 手元で分かることだけで続ける。
      }
    }

    // RECON だけは手がかりを機械で探してから渡す。
    // 事実の収集は機械の方が速く、確実で、無料。
    if (mode.id === 'recon') {
      if (!snap) return false;
      const leads = await findLeads({
        root: this.root, snapshot: snap, known: this.proposals.seen(), max: 1,
      });
      if (leads.length === 0) return false;
      const lead = leads[0]!;
      context = `${context}\n\n${investigationPrompt(lead)}`;
      fingerprint = lead.fingerprint;
      files = lead.files;
    }

    this.idle.begin(mode, Date.now());
    yield {
      type: 'chose', modeId: mode.id, codename: mode.codename, name: mode.name,
      roleCodename: role.codename, reason: decision.reason, isDuty: !!decision.dutyId,
    };

    const ac = new AbortController();
    this.#running = ac;
    let text = '';
    try {
      const thinker = new Agent(this.orchestrator, {
        candidates: this.candidates,
        system: buildSystemPrompt(role),
        tools: toolsFor(role, this.toolPool),
        root: this.root,
        maxTurns: 8,
        temperature: this.config.temperature,
        maxTokens: this.config.maxTokens,
        // 考えるだけ。手は動かさない。
        // ただし外を**読む**ことは止めない。読むだけなら、この場所は変わらない。
        // 止めるのは書き込みとコマンド。手を出すことと、調べることは違う。
        approve: async (req) => req.kind === 'network' && this.#opts.approveThinking !== false,
      });
      for await (const ev of thinker.run(
        [{ role: 'user', content: promptFor(mode, context) }], ac.signal,
      )) {
        if (ev.type === 'thinking') text += ev.delta;
      }
    } catch {
      // 考えに失敗しても、この場所は止まらない。
      return true;
    } finally {
      this.#running = undefined;
    }

    if (mode.id === 'recon') this.proposals.markExamined(fingerprint);

    // 日課として動いたなら、済んだことにする。
    // 報告が無くても「確認した」ことに変わりはない。
    if (decision.dutyId) {
      this.duties.complete(decision.dutyId, Date.now());
      await this.saveAutonomy();
    }

    const parsed = parseProposal(text);
    this.idle.recordOutcome(mode.id, parsed !== undefined);
    await this.saveAutonomy();

    if (!parsed) {
      await this.proposals.save();
      yield { type: 'noFinding', codename: mode.codename };
      return true;
    }

    // 外から持ち帰ったことは覚えておく。同じことを何度も訊きに行かないため。
    if (mode.id === 'briefing') {
      this.memory.remember({
        kind: 'fact', title: parsed.title, detail: parsed.rationale, source: '外部',
      });
      await this.memory.save().catch(() => undefined);
    }

    const added = this.proposals.add({
      kind: mode.id === 'patrol' ? 'bug' : mode.id === 'briefing' ? 'risk' : 'question',
      title: parsed.title,
      rationale: `[${role.codename}] ${parsed.rationale}`,
      evidence: files,
      suggestedAction: parsed.action,
      fingerprint,
    });
    await this.proposals.save();

    if (added) {
      // どの思考から出た提案かを覚える。採否がその思考の実績になる。
      this.#origin.set(added.id, mode.id);
      yield { type: 'proposal', proposal: added, codename: mode.codename };
    }
    return true;
  }

  /** 提案の採否。役に立ったかどうかが、次に何を考えるかを変える。 */
  async decide(id: string, verdict: 'accepted' | 'rejected'): Promise<Proposal | undefined> {
    const target = this.proposals.find(id);
    if (!target) return undefined;
    this.proposals.setStatus(target.id, verdict);
    const origin = this.#origin.get(target.id);
    if (origin) this.idle.recordVerdict(origin, verdict);
    await this.proposals.save();
    await this.saveAutonomy();
    return target;
  }

  /** 提案を実行し終えたことにする。 */
  async completeProposal(id: string): Promise<void> {
    this.proposals.setStatus(id, 'done');
    await this.proposals.save();
  }

  /** 思考の実績と日課の記録を残す。次の起動でも続きから考えられるように。 */
  async saveAutonomy(): Promise<void> {
    await writeJson(join(stateDir(), 'idle.json'),
      JSON.stringify(this.idle.stats(), null, 2), 'utf8').catch(() => undefined);
    await writeJson(join(stateDir(), 'duties.json'),
      JSON.stringify(this.duties.records(), null, 2), 'utf8').catch(() => undefined);
  }

  /** 何かが変わった。考え直す価値が生まれたということ。 */
  markChanged(at = Date.now()): void { this.#lastChangeAt = at; }
  get lastChangeAt(): number { return this.#lastChangeAt; }

  /** 検査コマンド。設定 > 先読みが見つけたもの。 */
  /** 作業前検査の実行役。設定を読んで一度だけ作る。 */
  get baselineProbe(): BaselineProbe {
    if (!this.#baseline) {
      const cfg = this.config.agent?.verify ?? {};
      this.#baseline = new BaselineProbe(this.root, {
        ...(cfg.baselineTimeoutMs !== undefined ? { timeoutMs: cfg.baselineTimeoutMs } : {}),
        ...(cfg.baselineMaxAgeMs !== undefined ? { maxAgeMs: cfg.baselineMaxAgeMs } : {}),
      });
    }
    return this.#baseline;
  }

  /** 作業前の状態を得る。二度目からは覚えていた結果を返す。 */
  async measureBaseline(command: string, signal: AbortSignal): Promise<BaselineOutcome> {
    return this.baselineProbe.measure(command, signal);
  }

  async verifyCommand(): Promise<string | undefined> {
    const configured = this.config.agent?.verify?.command;
    if (configured) return configured;
    const snap = await this.#prefetch.snapshotWithin(2000);
    return snap?.commands.test;
  }

  /** いま動いているものを止める。止めても対話は続く。 */
  abort(): void { this.#running?.abort(); }

  /**
   * 指示を受けて、起きたことを順に返す。
   *
   * 「書いて終わり」にしない。テストを流し、失敗したら自分で直させる。
   * 計算が無料なローカルでは、この往復が**時間で品質を買う**手段になる。
   * 打ち切ったときに中途半端な状態を残さないよう、書く前に控えも取る。
   */
  async *send(instruction: string): AsyncGenerator<SessionEvent> {
    if (this.#running) {
      yield { type: 'log', level: 'warn', text: 'いま別の作業をしています。' };
      return;
    }
    const ac = new AbortController();
    this.#running = ac;
    this.#instruction = instruction;
    this.#holder.instruction = instruction;

    const verifyCfg = this.config.agent?.verify ?? {};
    const harnessCfg = this.config.harness ?? {};
    const started = Date.now();
    const checkpoint = new Checkpoint(this.root);
    this.#harness.beginTask();

    let finishedReason: string | undefined;
    let answerChars = 0;
    let verified = true;

    try {
      // 関係することを思い出して添える。無関係なら何も足さない。
      const recalled = this.#recall(instruction);
      if (recalled) yield { type: 'recalled', text: recalled };

      this.#history.push({
        role: 'user',
        content: recalled ? `${instruction}\n\n---\n${recalled}` : instruction,
      });

      // 作業前のテストの状態。改ざん検出の基準になる。
      const verifyOn = verifyCfg.enabled !== false;
      const testsBefore = verifyOn ? await snapshotTests(this.root).catch(() => undefined) : undefined;

      // 作業前の成否。今回の失敗と、前からの失敗を切り分けるために要る。
      let baseline: VerifyResult | undefined;
      const command = verifyOn ? await this.verifyCommand() : undefined;
      if (command && verifyCfg.baseline !== false) {
        const probed = await this.measureBaseline(command, ac.signal);
        baseline = probed.result;
        yield {
          type: 'baseline', command,
          passed: probed.status === 'passed',
          cached: probed.cached,
          ...(probed.status === 'unknown' ? { unknown: true } : {}),
          ...(probed.reason !== undefined ? { detail: probed.reason } : {}),
        };
      }

      const run = async function* (this: Session, agent: Agent): AsyncGenerator<SessionEvent> {
        for await (const ev of agent.run(this.#history, ac.signal)) {
          switch (ev.type) {
            case 'thinking':
              answerChars += ev.delta.length;
              yield { type: 'text', delta: ev.delta };
              break;
            case 'salvaged':
              yield { type: 'salvaged', name: ev.name };
              break;
            case 'toolStart':
              // 書き込む前の状態を控える。打ち切ったときに戻せるように。
              if (ev.call.name === 'write_file' && harnessCfg.rollbackOnGiveUp) {
                const p = (ev.call.args as { path?: unknown }).path;
                if (typeof p === 'string') await checkpoint.capture(p);
              }
              yield { type: 'toolStart', name: ev.call.name, summary: summarize(ev.call.args) };
              break;
            case 'toolEnd': {
              if (!ev.isError && ev.call.name === 'write_file') this.#prefetch.invalidate();
              yield {
                type: 'toolEnd', name: ev.call.name, ok: !ev.isError, summary: firstLine(ev.result),
              };
              const shown = this.#diffFor(ev.call.name, ev.call.args, ev.isError);
              if (shown) yield shown;
              break;
            }
            case 'fallback':
              yield { type: 'fallback', from: ev.from, to: ev.to, reason: ev.reason };
              break;
            case 'finished':
              finishedReason = ev.reason;
              yield { type: 'finished', reason: ev.reason, detail: ev.detail };
              break;
          }
        }
      }.bind(this);

      yield* run(await this.#agent());

      // 実測を溜める。次回以降の自動選択がこれで変わる。
      await this.pilot.autopilot.record({
        modelId: this.candidates[0]!,
        success: finishedReason === 'completed',
        outputTokens: Math.round(answerChars / 3),
        seconds: (Date.now() - started) / 1000,
      });

      // 書いて終わりにしない。失敗したら、その内容を渡して直させる。
      if (finishedReason === 'completed' && testsBefore && command) {
        verified = false;
        const events: SessionEvent[] = [];
        const fix = async (feedback: string, sig: AbortSignal): Promise<void> => {
          this.#history.push({ role: 'user', content: feedback });
          for await (const ev of (await this.#agent()).run(this.#history, sig)) {
            if (ev.type === 'thinking') events.push({ type: 'text', delta: ev.delta });
            else if (ev.type === 'salvaged') events.push({ type: 'salvaged', name: ev.name });
            else if (ev.type === 'toolStart') {
              if (ev.call.name === 'write_file' && harnessCfg.rollbackOnGiveUp) {
                const p = (ev.call.args as { path?: unknown }).path;
                if (typeof p === 'string') await checkpoint.capture(p);
              }
              events.push({ type: 'toolStart', name: ev.call.name, summary: summarize(ev.call.args) });
            } else if (ev.type === 'toolEnd') {
              if (!ev.isError && ev.call.name === 'write_file') this.#prefetch.invalidate();
              events.push({
                type: 'toolEnd', name: ev.call.name, ok: !ev.isError, summary: firstLine(ev.result),
              });
              const shown = this.#diffFor(ev.call.name, ev.call.args, ev.isError);
              if (shown) events.push(shown);
            }
          }
        };

        const loop = verifyLoop(
          {
            command, root: this.root,
            maxRounds: verifyCfg.maxRounds,
            timeBudgetMs: verifyCfg.timeBudgetMs,
            commandTimeoutMs: verifyCfg.commandTimeoutMs,
          },
          fix, ac.signal, testsBefore, baseline,
        );
        let step = await loop.next();
        while (!step.done) {
          const ev = step.value;
          if (ev.type === 'passed' || ev.type === 'preexisting') verified = true;
          yield { type: 'verify', event: ev };
          // 直させている間に出たものも、そのまま見せる。黙って直させない。
          while (events.length > 0) yield events.shift()!;
          step = await loop.next();
        }
        while (events.length > 0) yield events.shift()!;
      }

      // 打ち切ったなら、中途半端な状態を残さない選択肢を持つ。
      if (!verified && harnessCfg.rollbackOnGiveUp && checkpoint.size > 0) {
        const paths = await checkpoint.restore();
        yield { type: 'rolledBack', paths };
      } else {
        checkpoint.commit();
      }

      const succeeded = finishedReason === 'completed' && verified;
      this.#harness.endTask(succeeded ? 'completed' : 'failed');
      await this.#harness.metrics?.save();
      this.#prefetch.invalidate();
      this.markChanged();

      yield {
        type: 'settled',
        reason: finishedReason ?? 'failed',
        verified,
        seconds: (Date.now() - started) / 1000,
      };
    } catch (e) {
      // 一度の失敗で対話ごと終わらせない。次の指示は受けられる。
      this.#harness.endTask('failed');
      yield { type: 'log', level: 'error', text: (e as Error).message };
      yield {
        type: 'settled', reason: 'failed', verified: false,
        seconds: (Date.now() - started) / 1000, detail: (e as Error).message,
      };
    } finally {
      this.#running = undefined;
      await this.memory.save().catch(() => undefined);
    }
  }

  /** 書き換えが通ったら、その差分を出来事にする。 */
  #diffFor(name: string, args: unknown, isError: boolean): (SessionEvent & PlanEvent & { type: 'diff' }) | undefined {
    if (isError || name !== 'write_file') return undefined;
    const path = (args as { path?: unknown }).path;
    if (typeof path !== 'string') return undefined;
    const found = this.#takeDiff(path);
    if (!found) return undefined;
    const { added, removed } = diffStat(found.diff);
    return { type: 'diff', path, diff: found.diff, added, removed, created: found.created };
  }

  /** 一人で全部やる作業者。気質も権限も既定のもの。 */
  async #agent(): Promise<Agent> {
    return new Agent(this.orchestrator, {
      candidates: this.candidates,
      system: await this.#system(),
      tools: this.#tools,
      root: this.root,
      maxTurns: this.config.agent?.maxTurns ?? 40,
      temperature: this.config.temperature,
      maxTokens: this.config.maxTokens,
      approve: this.#approve,
    });
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

  /** 話の続きを切る。覚えたことは消えない。忘れるのは、いま話していた流れだけ。 */
  reset(): void { this.#history.length = 0; }

  async close(): Promise<void> {
    this.abort();
    await this.saveAutonomy();
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
