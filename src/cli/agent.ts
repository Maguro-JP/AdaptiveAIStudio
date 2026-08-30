/**
 * aas agent — 作業者(worker)を1名動かす。P1 の入口。
 *
 * ローカルモデルがファイルを読み、差分を出し、承認を経て書き込む。
 * 何時間かかってもよい。打ち切るのは「進捗が無いとき」だけ。
 */
import { stdin, stdout } from 'node:process';
import { LineSource } from './input.ts';
import { resolve, join } from 'node:path';
import { loadConfig } from '../config.ts';
import { buildRegistry } from '../core/build.ts';
import { ChatOrchestrator } from '../core/orchestrator.ts';
import type { ProviderMessage } from '../providers/contract.ts';
import { Agent } from '../agent/loop.ts';
import type { ApprovalRequest } from '../agent/tools/types.ts';
import { readFileTool, listFilesTool, searchTextTool, writeFileTool } from '../agent/tools/fs.ts';
import { createRunCommandTool } from '../agent/tools/shell.ts';
import { inspectGit, describeGitState } from '../agent/git.ts';
import { setupAutopilot, resolveCandidates } from '../core/autopilot-setup.ts';
import { buildRuntime } from '../core/runtime-setup.ts';
import { startWarmPool } from '../core/warm-setup.ts';
import { Prefetcher, describeSnapshot } from '../agent/prefetch.ts';
import { verifyLoop, runVerification, type VerifyResult } from '../agent/verify.ts';
import { snapshotTests } from '../agent/test-integrity.ts';
import { buildHarness } from '../core/harness-setup.ts';
import { Checkpoint } from '../harness/checkpoint.ts';
import { formatReport } from '../harness/metrics.ts';
import { ProposalQueue, formatProposal } from '../agent/proposals.ts';
import { findLeads, investigationPrompt, parseProposal } from '../agent/initiative.ts';
import { stateDir } from '../core/autopilot-setup.ts';
import { RoleRegistry } from '../roles/registry.ts';
import { RoleLedger, formatChanges } from '../roles/ledger.ts';
import { createFetchUrlTool } from '../agent/tools/network.ts';
import { formatPlan } from '../agent/pm.ts';
import { formatReport as formatAcceptance } from '../agent/acceptance.ts';
import { Memory, formatRecall, formatEntry } from '../memory/memory.ts';
import { Session } from '../core/session.ts';
import { runPanel, mergeFindings } from '../agent/panel.ts';
import { IdleScheduler, formatIdleStats, type ModeStat } from '../harness/idle.ts';
import { BUILTIN_IDLE_MODES, MODE_ROLE, promptFor } from '../harness/idle-modes.ts';
import { DutyRoster, formatDuties, type DutyRecord } from '../harness/duties.ts';
import { BUILTIN_DUTIES } from '../harness/builtin-duties.ts';
import { readFile as readJson, writeFile as writeJson } from 'node:fs/promises';
import { buildSystemPrompt } from '../roles/role.ts';
import { toolsFor } from '../roles/registry.ts';

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
};

const SYSTEM = `あなたはソフトウェア開発の作業者です。与えられた作業ディレクトリで実際に手を動かします。

守ること:
- 推測でファイルを書かない。まず read_file / list_files / search_text で現状を確認する。
- write_file には必ずファイルの全内容を渡す。一部だけ渡すと残りが消える。
- 変更したら run_command でテストやビルドを実行し、結果を確認する。
- 作業が終わったら、何をしたかを簡潔に日本語で報告する。ツールは呼ばない。
- 分からないことは推測せず、質問して止まる。

時間はいくらかかっても構わない。正確さを優先すること。`;

function renderDiff(diff: string): string {
  return diff.split('\n').map((line) => {
    if (line.startsWith('+++') || line.startsWith('---')) return c.dim(line);
    if (line.startsWith('@@')) return c.cyan(line);
    if (line.startsWith('+')) return c.green(line);
    if (line.startsWith('-')) return c.red(line);
    return line;
  }).join('\n');
}

async function main(): Promise<void> {
  const { config, source } = loadConfig();
  const registry = buildRegistry(config);
  const orchestrator = new ChatOrchestrator(registry);

  const agentCfg = config.agent ?? {};
  const root = resolve(agentCfg.root ?? process.cwd());
  const approval = agentCfg.approval ?? 'autoEdit';

  const rl = new LineSource(stdin, stdout);
  let generating: AbortController | undefined;
  rl.onSigint(() => { if (generating) generating.abort(); else rl.close(); });

  const approve = async (req: ApprovalRequest): Promise<boolean> => {
    if (approval === 'auto') return true;
    if (approval === 'autoEdit' && req.kind === 'write') return true;

    if (req.kind === 'write') {
      console.log('\n' + c.cyan(`  ${req.created ? '新規作成' : '変更'}: ${req.path}`));
      console.log(req.diff ? renderDiff(req.diff) : c.dim('  (差分なし)'));
    } else if (req.kind === 'command') {
      console.log('\n' + c.cyan(`  コマンド実行: ${req.command}`));
    } else {
      console.log('\n' + c.cyan(`  外部への問い合わせ: ${req.url}`));
      console.log(c.dim('  取得のみ。資格情報は送りません。'));
    }
    const ans = await rl.question(c.yellow('  許可しますか？ [y/N] '));
    if (ans === undefined) return false; // 入力が無いなら許可しない
    const normalized = ans.trim().toLowerCase();
    return normalized === 'y' || normalized === 'yes';
  };

  const pilot = await setupAutopilot(config, registry);
  const { candidates, note } = resolveCandidates(config, pilot);
  if (candidates.length === 0) {
    console.error(c.red(`使えるモデルがありません: ${note}`));
    process.exit(1);
  }

  // 状況把握を裏で始める。待たない。利用者が指示を考えている間に済ませる。
  const prefetch = new Prefetcher(root, (e) => {
    if (e.type === 'failed') process.stderr.write(c.dim(`  先読み失敗: ${e.task}\n`));
  });
  prefetch.start();

  // 使うモデルを先に温めておく。作業開始時の待ちをゼロにする。
  const runtime = buildRuntime(config, pilot.machine);
  const warm = await startWarmPool(config, runtime, pilot.machine, candidates, (e) => {
    if (e.type === 'warming') process.stderr.write(c.dim(`  温め中: ${e.ref}...\n`));
    else if (e.type === 'warm') process.stderr.write(c.dim(`  常駐: ${e.ref} (${e.loadSeconds}秒)\n`));
    else if (e.type === 'failed') process.stderr.write(c.yellow(`  温め失敗: ${e.ref} (${e.error})\n`));
    else if (e.type === 'evict') process.stderr.write(c.dim(`  解放: ${e.ref} (${e.reason})\n`));
  });

  // ハーネス: 規則をツールの手前に挟む。
  // モデルに守らせるのではなく、実行させないことで守る。
  let currentInstruction = '';
  const harness = await buildHarness(config, (d) => {
    if (d.outcome === 'denied') {
      console.log(c.red(`    ⛔ ${d.rule}: ${d.reason ?? ''}`));
    } else if (d.outcome === 'warned') {
      console.log(c.yellow(`    ⚠ ${d.rule}: ${d.reason ?? ''}`));
    }
  });

  const rawTools = [
    readFileTool, listFilesTool, searchTextTool, writeFileTool,
    createRunCommandTool({ allowed: agentCfg.allowedCommands }),
  ];
  const tools = harness.wrapAll(rawTools, () => currentInstruction);
  // 調査担当には書き込みを渡さない。権限が無ければ事故は起きない。
  const readOnlyTools = harness.wrapAll(
    [readFileTool, listFilesTool, searchTextTool], () => currentInstruction);

  // 依頼のたびに、その時点で分かっている状況を作業者へ渡す。
  // まだ構築中なら少しだけ待つ。モデルが調べ直すより速い。
  const systemFor = async (): Promise<string> => {
    const snap = await prefetch.snapshotWithin(3000);
    const brief = snap ? describeSnapshot(snap) : '';
    return brief ? `${SYSTEM}\n\n${brief}` : SYSTEM;
  };

  const verifyCfg = agentCfg.verify ?? {};
  const harnessCfg = config.harness ?? {};

  /** 検証コマンドを決める。設定 > 先読みが検出したもの。 */
  const verifyCommand = async (): Promise<string | undefined> => {
    if (verifyCfg.command) return verifyCfg.command;
    const snap = await prefetch.snapshotWithin(2000);
    return snap?.commands.test;
  };

  const makeAgent = async () => new Agent(orchestrator, {
    candidates,
    system: await systemFor(),
    tools,
    root,
    maxTurns: agentCfg.maxTurns ?? 40,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    approve,
  });

  /**
   * 自己検証ループ。作業者に失敗内容を渡して直させ、通るまで繰り返す。
   * 打ち切りは回数・時間・進捗の3つで、無人でも暴走しない。
   */
  const runVerify = async (
    before: Awaited<ReturnType<typeof snapshotTests>>,
    baseline: VerifyResult | undefined,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const command = await verifyCommand();
    if (!command) {
      console.log(c.dim('  検証コマンドが分からないため、検証は行いません。\n'));
      return true;
    }

    const fix = async (feedback: string, sig: AbortSignal): Promise<void> => {
      history.push({ role: 'user', content: feedback });
      let text = '';
      const agent = await makeAgent();
      for await (const ev of agent.run(history, sig)) {
        if (ev.type === 'thinking') { text += ev.delta; stdout.write(ev.delta); }
        else if (ev.type === 'toolStart') console.log(c.dim(`  · ${ev.call.name} ${summarize(ev.call.args)}`));
        else if (ev.type === 'toolEnd') {
          console.log(ev.isError ? c.red(`    ✗ ${firstLine(ev.result)}`) : c.dim(`    ✓ ${firstLine(ev.result)}`));
          if (!ev.isError && ev.call.name === 'write_file') prefetch.invalidate();
        }
      }
      if (text) stdout.write('\n');
    };

    let passed = false;
    for await (const ev of verifyLoop(
      {
        command, root,
        maxRounds: verifyCfg.maxRounds,
        timeBudgetMs: verifyCfg.timeBudgetMs,
        commandTimeoutMs: verifyCfg.commandTimeoutMs,
      },
      fix, signal, before, baseline,
    )) {
      switch (ev.type) {
        case 'running':
          console.log(c.dim(`  検証 ${ev.round}回目: ${ev.command}`));
          break;
        case 'passed':
          passed = true;
          console.log(c.green(`  ✓ 検証を通過しました`) + c.dim(` (${(ev.durationMs / 1000).toFixed(1)}s)\n`));
          break;
        case 'failed':
          console.log(c.yellow(`  ✗ 検証に失敗（${ev.round}回目）`));
          console.log(c.dim(ev.digest.split('\n').slice(-6).map((l) => `    ${l}`).join('\n')));
          break;
        case 'preexisting':
          console.log(c.yellow('  この失敗は作業前から出ています。今回の作業が原因ではありません。'));
          console.log(c.dim(ev.digest.split('\n').slice(-4).map((l) => `    ${l}`).join('\n')) + '\n');
          break;
        case 'tampered':
          console.log(c.red(`  ✗ ${ev.reason}\n`));
          break;
        case 'fixing':
          console.log(c.dim(`  修正させています...`));
          break;
        case 'giveUp':
          console.log(c.yellow(`  検証を打ち切りました — ${ev.detail}\n`));
          break;
      }
    }
    return passed;
  };

  // 人員。設定から気質を足したり上書きしたりできる。
  const roles = new RoleRegistry(config.roles ?? []);

  // 名簿は消さない。変わったら必ず周知する。周知前に落ちても、次の起動で伝える。
  const ledger = new RoleLedger(join(stateDir(), 'roles-ledger.json'));
  await ledger.load();
  ledger.sync(roles.roster());
  const roleNews = ledger.pending();
  if (roleNews.length > 0) {
    console.log(c.yellow(formatChanges(roleNews)) + '\n');
    ledger.markAnnounced();
  }
  await ledger.save();

  const panelCfg = config.panel ?? {};
  const netCfg = config.network ?? {};

  /** 権限に応じてツールを配る。持たせない権限は事故にならない。 */
  const toolPool = {
    read: harness.wrapAll([readFileTool, listFilesTool, searchTextTool], () => currentInstruction),
    write: harness.wrapAll([writeFileTool], () => currentInstruction),
    execute: harness.wrapAll(
      [createRunCommandTool({ allowed: agentCfg.allowedCommands })], () => currentInstruction),
    // 外へ出る口。閉じてもこの場所は動く。持っていない人は外に出られない。
    network: netCfg.enabled === false ? [] : harness.wrapAll(
      [createFetchUrlTool({
        allowedHosts: netCfg.allowedHosts,
        maxBytes: netCfg.maxBytes,
        timeoutMs: netCfg.timeoutMs,
      })], () => currentInstruction),
  };

  /** 合議。気質の違う担当を同じ対象に当てる。 */
  const runPanelOn = async (target: string): Promise<void> => {
    const ids = panelCfg.roles ?? ['tester', 'breaker', 'security'];
    const members = ids.map((id) => roles.get(id)).filter((r): r is NonNullable<typeof r> => !!r);
    if (members.length === 0) {
      console.log(c.red('  参加できる役職がありません。\n'));
      return;
    }
    console.log(c.dim(`  合議: ${members.map((m) => m.name).join(' / ')}`));

    const ac = new AbortController();
    generating = ac;
    const gen = runPanel(orchestrator, target, {
      roles: members, candidates, root, toolPool,
      parallel: panelCfg.parallel ?? 2,
      temperature: config.temperature, maxTokens: config.maxTokens,
    }, ac.signal);

    try {
      let next = await gen.next();
      while (!next.done) {
        const ev = next.value;
        if (ev.type === 'assigned') console.log(c.dim(`  · ${ev.roleName} が確認中`));
        else if (ev.type === 'noFinding') console.log(c.dim(`    ${ev.roleName}: 問題なし`));
        else if (ev.type === 'failed') console.log(c.red(`    ${ev.roleId}: ${ev.error}`));
        next = await gen.next();
      }
      const merged = mergeFindings(next.value);
      if (merged.length === 0) {
        console.log(c.green('  全員が問題なしと判断しました。\n'));
      }
      for (const f of merged) {
        const also = f.alsoBy.length > 0 ? c.dim(`（${f.alsoBy.join('・')}も同意）`) : '';
        const added = proposals.add({
          kind: f.roleId === 'security' ? 'risk' : 'bug',
          title: f.title, rationale: `[${f.roleName}] ${f.rationale}`,
          evidence: [target], suggestedAction: f.action,
          fingerprint: `panel:${f.title}`,
        });
        console.log(c.cyan(`  💡 [${f.roleName}] ${f.title}`) + also);
        console.log(c.dim(`     ${f.rationale}`));
        if (added) console.log(c.dim(`     → 提案 ${added.id} として登録しました`));
      }
      await proposals.save();
      console.log();
    } finally {
      generating = undefined;
    }
  };

  /**
   * レーン。指定が無ければ候補から作る。
   * 空いている計算資源は節約ではなく損失なので、余っていれば並べる。
   */
  const lanes = agentCfg.lanes && agentCfg.lanes.length > 0
    ? agentCfg.lanes
    : [{ id: 'main', candidates, parallel: 2 }];

  /**
   * 依頼を分解して、複数の担当に同時に働いてもらう。
   *
   * 分解に失敗しても止まらない。最悪でも「一人で全部やる」に畳んで進む。
   * 分解できないことは、作業をしない理由にならない。
   */
  /**
   * 依頼を分解して、複数の担当に同時に働いてもらう。
   *
   * 手順は核（Session）が持っている。ここは出来事を端末に描くだけ。
   * 画面側も同じ核を見ているので、書き方が二つに割れることがない。
   */
  /**
   * 核。分解と並列実行の手順はここが持つ。
   * 使うときに初めて作る。使わない起動で余計な支度をしない。
   */
  let core: Session | undefined;
  const getSession = async (): Promise<Session> => {
    core ??= await Session.create(config, { approve });
    return core;
  };

  const runPlanOn = async (request: string): Promise<void> => {
    const session = await getSession();
    const ac = new AbortController();
    generating = ac;
    try {
      for await (const ev of session.plan(request)) {
        switch (ev.type) {
          case 'recalled':
            console.log(c.dim(ev.text.split('\n').map((l) => `  ${l}`).join('\n')));
            break;
          case 'baselineFailed':
            console.log(c.yellow('  作業前から検査が失敗しています。今回の作業の成否とは切り分けて見ます。'));
            break;
          case 'planRepaired':
            console.log(c.yellow(`  計画を直しました: ${ev.detail}`));
            break;
          case 'planned':
            console.log(formatPlan(ev.plan) + '\n');
            break;
          case 'taskStart':
            console.log(c.cyan(`  ▶ ${ev.taskId} 着手 @${ev.laneId}`));
            break;
          case 'taskEnd': {
            const mark = ev.state === 'done' ? c.green('✓') : c.red('✗');
            console.log(`  ${mark} ${ev.taskId} (${Math.round(ev.ms / 1000)}s)`
              + (ev.error ? ` ${c.red(ev.error)}` : ''));
            break;
          }
          case 'taskSkip':
            console.log(c.yellow(`  − ${ev.taskId} 未実施: ${ev.reason}`));
            break;
          case 'running':
            if (ev.taskIds.length > 1) console.log(c.dim(`    同時進行: ${ev.taskIds.join(', ')}`));
            break;
          case 'verifying':
            console.log(c.dim(`  検査: ${ev.command}`));
            break;
          case 'accepted': {
            const text = formatAcceptance(ev.report);
            console.log('\n' + (ev.report.verdict === 'accepted' ? c.green(text)
              : ev.report.verdict === 'rejected' ? c.red(text) : c.yellow(text)) + '\n');
            break;
          }
          case 'log':
            console.log(ev.level === 'error' ? c.red(`  ${ev.text}`) : c.yellow(`  ${ev.text}`));
            break;
        }
      }
      prefetch.invalidate();
      lastChangeAt = Date.now();
    } finally {
      generating = undefined;
    }
  };

  const initCfg = config.initiative ?? {};
  const proposals = new ProposalQueue(join(stateDir(), 'proposals.json'));
  await proposals.load();

  /**
   * 記憶。起動のたびに何も覚えていないなら、それは道具であって住人ではない。
   * 決めたこと・試して駄目だったこと・分かったこと・好みが、ここに残る。
   */
  const memory = new Memory(join(stateDir(), 'memory.jsonl'));
  await memory.load();
  if (memory.size > 0) console.log(c.dim(`  記憶: ${memory.size}件`));

  /** 依頼に関係することを思い出す。無関係なものは出さない。 */
  const recallFor = (text: string): string => {
    const related = memory.recall(text, { limit: 6 });
    const failed = memory.failedBefore(text, 2);
    const merged = [...related];
    for (const f of failed) if (!merged.some((e) => e.id === f.id)) merged.push(f);
    return formatRecall(merged);
  };

  // 思考の配分。何を考えるかはスケジューラが決める。
  const idleModes = BUILTIN_IDLE_MODES.filter(
    (m) => !initCfg.modes || initCfg.modes.includes(m.id));
  const idle = new IdleScheduler(idleModes, { perHour: initCfg.budgetPerHour ?? 12 });
  const idleStatePath = join(stateDir(), 'idle.json');
  try {
    idle.restore(JSON.parse(await readJson(idleStatePath, 'utf8')) as ModeStat[]);
  } catch { /* 記録が無いのは正常 */ }

  // 日課。変化が無くてもやることを、時間で起こす。
  const roster = new DutyRoster(BUILTIN_DUTIES);
  const dutyStatePath = join(stateDir(), 'duties.json');
  try {
    roster.restore(JSON.parse(await readJson(dutyStatePath, 'utf8')) as DutyRecord[]);
  } catch { /* 記録が無いのは正常 */ }
  const saveDuties = () =>
    writeJson(dutyStatePath, JSON.stringify(roster.records(), null, 2), 'utf8')
      .catch(() => undefined);

  let lastChangeAt = Date.now();
  /** 提案がどの思考から出たかを覚える。採否が実績になる。 */
  const proposalOrigin = new Map<string, string>();

  /**
   * 待機中の思考。
   *
   * 何を考えるかはハーネス側のスケジューラが決める。
   * 「変わっていないのに考え直す」「予算を超えて考える」
   * 「役に立たなかった考え方を繰り返す」を、ここで止める。
   */
  const think = async (): Promise<boolean> => {
    if (initCfg.enabled === false) return false;

    const now = Date.now();
    const due = roster.due(now).map((s) => ({
      dutyId: s.duty.id, modeId: s.duty.modeId,
      codename: s.duty.codename, isCatchUp: s.isCatchUp,
    }));

    const decision = await idle.choose(
      { lastChangeAt, openProposals: proposals.open().length, now },
      due,
    );
    if (!decision.mode) return false;

    const mode = decision.mode;
    if (decision.dutyId) {
      process.stderr.write(c.dim(`\n  ${decision.reason}\n`));
    }
    const role = roles.get(MODE_ROLE[mode.id] ?? 'scout') ?? roles.get('scout')!;
    idle.begin(mode, Date.now());

    const snap = await prefetch.snapshotWithin(3000);
    const known = proposals.seen();

    // RECON だけは手がかりを機械で探してから渡す。
    // 事実の収集は機械の方が速く、確実で、無料。
    let context = snap ? describeSnapshot(snap) : '';
    let fingerprint = `${mode.id}:${Date.now()}`;
    let files: string[] = [];
    if (mode.id === 'recon') {
      if (!snap) return false;
      const leads = await findLeads({ root, snapshot: snap, known, max: 1 });
      if (leads.length === 0) return false;
      const lead = leads[0]!;
      context = `${context}\n\n気づいたこと: ${lead.title}\n確認できた事実: ${lead.fact}\n対象: ${lead.files.join(', ')}`;
      fingerprint = lead.fingerprint;
      files = lead.files;
    }

    process.stderr.write(c.dim(`\n  [${mode.codename}] ${mode.name} — ${role.codename}\n`));

    const ac = new AbortController();
    generating = ac;
    let text = '';
    try {
      const thinker = new Agent(orchestrator, {
        candidates,
        system: buildSystemPrompt(role),
        tools: toolsFor(role, toolPool),
        root,
        maxTurns: 8,
        temperature: config.temperature,
        maxTokens: config.maxTokens,
        approve: async () => false,
      });
      for await (const ev of thinker.run(
        [{ role: 'user', content: promptFor(mode, context) }], ac.signal,
      )) {
        if (ev.type === 'thinking') text += ev.delta;
      }
    } catch {
      return true;
    } finally {
      generating = undefined;
    }

    if (mode.id === 'recon') proposals.markExamined(fingerprint);

    // 日課として動いたなら、済んだことにする。
    // 報告が無くても「確認した」ことに変わりはない。
    if (decision.dutyId) {
      roster.complete(decision.dutyId, Date.now());
      await saveDuties();
    }

    const parsed = parseProposal(text);
    idle.recordOutcome(mode.id, parsed !== undefined);
    await writeJson(idleStatePath, JSON.stringify(idle.stats(), null, 2), 'utf8').catch(() => undefined);

    if (!parsed) {
      process.stderr.write(c.dim('    → 報告することはありませんでした\n'));
      await proposals.save();
      return true;
    }

    const added = proposals.add({
      kind: mode.id === 'patrol' ? 'bug' : mode.id === 'briefing' ? 'risk' : 'question',
      title: parsed.title,
      rationale: `[${role.codename}] ${parsed.rationale}`,
      evidence: files,
      suggestedAction: parsed.action,
      fingerprint,
    });
    await proposals.save();

    if (added) {
      proposalOrigin.set(added.id, mode.id);
      console.log(c.cyan(`\n  💡 [${mode.codename}] ${added.title}`));
      console.log(c.dim(`     ${parsed.rationale}`));
      console.log(c.dim(`     /do ${added.id} で実行、/reject ${added.id} で却下\n`));
    }
    return true;
  };

  console.log(c.cyan('AdaptiveAIStudio') + c.dim(' — agent (作業者1名)'));
  console.log(c.dim(`設定: ${source}`));
  console.log(c.dim(`作業ディレクトリ: ${root}`));
  console.log(c.dim(`環境: ${pilot.machineText}`));
  console.log(c.cyan(`担当モデル: ${candidates[0]}`));
  console.log(c.dim(`  ${note}`));
  console.log(c.dim(`承認モード: ${approval}`));

  // 自動書き込みを行う前に、巻き戻せる状態かを必ず確認する
  if (approval !== 'ask') {
    const git = describeGitState(await inspectGit(root));
    console.log(git.risky ? c.yellow(`  ${git.text}`) : c.dim(`  ${git.text}`));
  }
  for (const p of registry.list()) {
    const h = await p.health();
    console.log(h.ok ? c.dim(`  ${p.id}: `) + c.green('接続OK')
                     : c.dim(`  ${p.id}: `) + c.yellow(`接続不可 (${h.reason})`));
  }
  if (warm.warmed.length > 0) {
    console.log(c.green(`  常駐: ${warm.warmed.join(', ')}`) + c.dim(' — 待ちなしで開始できます'));
  } else if (warm.notes.length > 0) {
    console.log(c.dim(`  ${warm.notes[0]}`));
  }
  const snap = prefetch.peek();
  if (snap && snap.ready.length > 0) {
    const parts = [`ファイル ${snap.files.length} 件`];
    if (snap.kind) parts.unshift(snap.kind);
    if (snap.commands.test) parts.push(`テスト: ${snap.commands.test}`);
    console.log(c.green('  先読み完了: ') + c.dim(parts.join(' / ')));
  }
  console.log(c.dim('作業を指示してください。/exit で終了。\n'));

  const history: ProviderMessage[] = [];
  let pendingRequest: string | undefined;
  let acceptedProposalId: string | undefined;

  try {
    for (;;) {
      const answer = initCfg.enabled === false
        ? await rl.question(c.cyan('依頼> '))
        : await rl.questionWhileIdle(
            c.cyan('依頼> '), (initCfg.idleSeconds ?? 30) * 1000, think);
      if (answer === undefined) break;
      const line = answer.trim();
      if (!line) continue;
      if (line === '/exit' || line === '/quit') break;
      if (line === '/new') { history.length = 0; console.log(c.dim('履歴を破棄しました。\n')); continue; }
      if (line === '/models') {
        for (const r of pilot.autopilot.explain()) {
          const mark = r.modelId === candidates[0] ? c.green(' ←使用中') : '';
          console.log(`  ${r.modelId}${mark}\n    ${c.dim(r.reason)} / 約${Math.round(r.expectedSeconds)}秒`);
        }
        console.log();
        continue;
      }
      if (line === '/metrics') { console.log(pilot.metrics.report() + '\n'); continue; }
      if (line === '/duties') {
        console.log(formatDuties(roster.status(Date.now()), Date.now()));
        const pending = roster.due(Date.now());
        console.log(pending.length === 0
          ? c.dim('\n  今やるべき日課はありません。\n')
          : c.yellow(`\n  未了: ${pending.map((p) => p.duty.codename).join(', ')}\n`));
        continue;
      }
      if (line.startsWith('/skip ')) {
        const id = line.slice('/skip '.length).trim();
        const target = roster.duties().find((d) => d.id === id || d.codename === id);
        if (!target) { console.log(c.red(`  日課が見つかりません: ${id}\n`)); continue; }
        roster.skip(target.id, Date.now());
        await saveDuties();
        console.log(c.dim(`  ${target.codename} を今期は流しました。\n`));
        continue;
      }
      if (line === '/idle') {
        console.log(formatIdleStats(idleModes, idle.stats()));
        console.log(c.dim(`\n  この1時間の消費: ${idle.spentThisHour(Date.now())} / ${initCfg.budgetPerHour ?? 12}`));
        const d = await idle.choose({
          lastChangeAt, openProposals: proposals.open().length, now: Date.now(),
        });
        console.log(c.dim(`  次に考えること: ${d.mode ? d.mode.codename : `なし（${d.reason}）`}\n`));
        continue;
      }
      if (line === '/roles') {
        for (const r of roles.active()) {
          console.log(`  ${c.cyan(r.codename.padEnd(10))} ${r.name.padEnd(8)} ${c.dim(r.access.join('/'))}`);
          console.log(c.dim(`    ${r.disposition}`));
          if (r.formerly?.length) console.log(c.dim(`    旧称: ${r.formerly.join(', ')}`));
        }
        const retired = roles.roster().filter((r) => r.retired);
        if (retired.length > 0) {
          console.log(c.dim('\n  引き継ぎ済み（呼べば後任に繋がります）'));
          for (const r of retired) {
            const to = (r.succeededBy ?? []).map((id) => roles.get(id)?.codename ?? id);
            console.log(c.dim(`  ${r.codename.padEnd(10)} → ${to.join(', ') || '(未設定)'}`));
          }
        }
        console.log();
        continue;
      }
      if (line.startsWith('/memory')) {
        const q = line.slice('/memory'.length).trim();
        const found = q ? memory.recall(q, { limit: 20, includeSuperseded: true }) : memory.all().slice(-20);
        if (found.length === 0) {
          console.log(c.dim(q ? `  「${q}」に関係する記憶はありません。\n` : '  まだ何も覚えていません。\n'));
        } else {
          for (const e of found) console.log(formatEntry(e));
          console.log(c.dim(`  （全 ${memory.size} 件）\n`));
        }
        continue;
      }
      if (line.startsWith('/remember')) {
        const body = line.slice('/remember'.length).trim();
        if (!body) {
          console.log(c.dim('  使い方: /remember <覚えること>  /remember 決定: <決めたこと>\n'));
          continue;
        }
        // 「決定:」で始まれば決めたこととして扱う。決定は古くても効き続ける。
        const m = body.match(/^(決定|決めた|方針)[:：]\s*(.+)$/s);
        const r = memory.remember({
          kind: m ? 'decision' : 'preference',
          title: (m ? m[2]! : body).trim(),
          source: '利用者',
        });
        console.log(r.reinforced
          ? c.dim(`  覚えています（${r.entry.confirms}回目）: ${r.entry.title}\n`)
          : c.green(`  覚えました: ${r.entry.title}\n`));
        for (const conflict of r.conflicts) {
          console.log(c.yellow(`  前にこう決めています: ${conflict.title}`));
          console.log(c.dim(`    決め直すなら、そう言ってください（${conflict.id}）\n`));
        }
        await memory.save();
        continue;
      }
      if (line.startsWith('/plan')) {
        const target = line.slice('/plan'.length).trim();
        if (!target) { console.log(c.dim('  使い方: /plan <依頼>\n')); continue; }
        await runPlanOn(target);
        continue;
      }
      if (line.startsWith('/panel')) {
        const target = line.slice('/panel'.length).trim();
        await runPanelOn(target || '直近の変更を見て、問題があれば指摘してください。');
        continue;
      }
      if (line === '/proposals') {
        const open = proposals.open();
        if (open.length === 0) console.log(c.dim('  未処理の提案はありません。\n'));
        else {
          for (const p of open) console.log(formatProposal(p, true) + '\n');
        }
        continue;
      }
      if (line === '/think') { await think(); continue; }
      if (line.startsWith('/do ') || line.startsWith('/reject ')) {
        const [cmd, id] = line.split(/\s+/);
        const target = id ? proposals.find(id) : undefined;
        if (!target) { console.log(c.red(`  提案が見つかりません: ${id ?? ''}\n`)); continue; }
        if (cmd === '/reject') {
          proposals.setStatus(target.id, 'rejected');
          const origin = proposalOrigin.get(target.id);
          if (origin) idle.recordVerdict(origin, 'rejected');
          await proposals.save();
          await writeJson(idleStatePath, JSON.stringify(idle.stats(), null, 2), 'utf8').catch(() => undefined);
          console.log(c.dim(`  ${target.id} を却下しました。\n`));
          continue;
        }
        proposals.setStatus(target.id, 'accepted');
        const origin = proposalOrigin.get(target.id);
        if (origin) idle.recordVerdict(origin, 'accepted');
        await proposals.save();
        await writeJson(idleStatePath, JSON.stringify(idle.stats(), null, 2), 'utf8').catch(() => undefined);
        console.log(c.dim(`  ${target.id} を実行します: ${target.suggestedAction}\n`));
        // 提案の内容をそのまま依頼として流す
        pendingRequest = target.suggestedAction;
        acceptedProposalId = target.id;
      }
      if (line === '/rules') {
        console.log(c.dim('  実行前に適用される規則:'));
        for (const r of harness.rules()) console.log(`  ${c.cyan(r.name)} — ${c.dim(r.description)}`);
        console.log();
        continue;
      }
      if (line === '/harness') {
        const report = harness.metrics?.report(harness.rules().map((r) => r.name));
        console.log(report ? formatReport(report) : c.dim('  計測が有効ではありません。'));
        console.log();
        continue;
      }
      if (line === '/audit') {
        const s = harness.audit.summary();
        console.log(`  許可 ${s.allowed} / 拒否 ${s.denied} / 警告 ${s.warned}`);
        for (const [rule, n] of s.byRule) console.log(c.dim(`    ${rule}: ${n}回`));
        console.log();
        continue;
      }
      if (line === '/context') {
        const s = await prefetch.snapshot();
        console.log(s ? describeSnapshot(s) || c.dim('  先読みできる情報がありません。') : c.dim('  先読みは開始されていません。'));
        console.log();
        continue;
      }
      if (line === '/warm') {
        const status = warm.pool?.status() ?? [];
        if (status.length === 0) console.log(c.dim('  常駐しているモデルはありません。\n'));
        for (const s of status) {
          console.log(`  ${s.ref} ${s.inUse ? c.green('使用中') : c.dim(`待機 ${s.idleSeconds}秒`)}`);
        }
        console.log();
        continue;
      }

      const request = pendingRequest ?? line;
      pendingRequest = undefined;
      // 依頼に関係することを思い出して添える。無関係なら何も足さない。
      const recalled = recallFor(request);
      history.push({
        role: 'user',
        content: recalled ? `${request}\n\n---\n${recalled}` : request,
      });
      currentInstruction = request;
      harness.beginTask();
      const checkpoint = new Checkpoint(root);
      generating = new AbortController();
      // 作業前のテストの状態を控えておく。改ざん検出の基準になる。
      const verifyOn = verifyCfg.enabled !== false;
      const testsBefore = verifyOn
        ? await snapshotTests(root).catch(() => undefined)
        : undefined;

      // 作業前の状態を控える。失敗の責任を切り分けるために要る。
      let baseline: VerifyResult | undefined;
      if (verifyOn && verifyCfg.baseline !== false) {
        const cmd = await verifyCommand();
        if (cmd) {
          console.log(c.dim(`  作業前の状態を確認中: ${cmd}`));
          baseline = await runVerification(
            { command: cmd, root, commandTimeoutMs: verifyCfg.commandTimeoutMs },
            generating.signal,
          );
          console.log(baseline.passed
            ? c.dim('    通っています')
            : c.yellow('    作業前から失敗しています'));
        }
      }
      const started = Date.now();
      let printedText = false;
      let answerChars = 0;
      let finishedReason: string | undefined;

      try {
        const agent = await makeAgent();
        for await (const ev of agent.run(history, generating.signal)) {
          switch (ev.type) {
            case 'thinking':
              stdout.write(ev.delta);
              answerChars += ev.delta.length;
              printedText = true;
              break;
            case 'turn':
              if (printedText) { stdout.write('\n'); printedText = false; }
              break;
            case 'fallback':
              console.log(c.yellow(`  ⤷ ${ev.from} → ${ev.to} に切替`) + c.dim(` (${ev.reason})`));
              break;
            case 'toolStart': {
              console.log(c.dim(`  · ${ev.call.name} ${summarize(ev.call.args)}`));
              // 書き込む前の状態を控える。打ち切ったときに戻せるように。
              if (ev.call.name === 'write_file' && harnessCfg.rollbackOnGiveUp) {
                const p = (ev.call.args as { path?: unknown }).path;
                if (typeof p === 'string') await checkpoint.capture(p);
              }
              break;
            }
            case 'toolEnd':
              console.log(ev.isError
                ? c.red(`    ✗ ${firstLine(ev.result)}`)
                : c.dim(`    ✓ ${firstLine(ev.result)}`));
              // ファイルが変わったら索引が古くなる。裏で作り直す。
              if (!ev.isError && ev.call.name === 'write_file') prefetch.invalidate();
              break;
            case 'finished': {
              const secs = ((Date.now() - started) / 1000).toFixed(1);
              // 実測を溜める。次回以降の自動選択がこれで変わる。
              await pilot.autopilot.record({
                modelId: candidates[0]!,
                success: ev.reason === 'completed',
                outputTokens: Math.round(answerChars / 3),
                seconds: (Date.now() - started) / 1000,
              });
              const label = {
                completed: c.green('完了'),
                maxTurns: c.yellow('ターン上限'),
                noProgress: c.yellow('堂々巡りのため停止'),
                aborted: c.dim('中断'),
                failed: c.red('失敗'),
              }[ev.reason];
              console.log(`\n  ${label}${ev.detail ? c.dim(` — ${ev.detail}`) : ''} ${c.dim(`(${secs}s)`)}\n`);
              finishedReason = ev.reason;
              break;
            }
          }
        }

        // 書いて終わりにしない。テストを流し、失敗したら自分で直させる。
        let verified = true;
        if (finishedReason === 'completed' && testsBefore) {
          verified = await runVerify(testsBefore, baseline, generating.signal);
        }

        // 打ち切った場合、中途半端な状態を残さない選択肢を持つ
        if (!verified && harnessCfg.rollbackOnGiveUp && checkpoint.size > 0) {
          const restored = await checkpoint.restore();
          console.log(c.yellow(`  変更を巻き戻しました: ${restored.join(', ')}\n`));
        } else {
          checkpoint.commit();
        }

        // 拒否が誘導になったのか邪魔になったのか、結末で判定させる
        const succeeded = finishedReason === 'completed' && verified;
        harness.endTask(succeeded ? 'completed' : 'failed');
        await harness.metrics?.save();

        if (acceptedProposalId && succeeded) {
          proposals.setStatus(acceptedProposalId, 'done');
          await proposals.save();
        }
        acceptedProposalId = undefined;

        // 作業のあとは状況が変わっている。考え直す価値が生まれた。
        prefetch.invalidate();
        lastChangeAt = Date.now();
      } finally {
        generating = undefined;
      }
    }
  } finally {
    rl.close();
    // 覚えたことは必ず残す。次の起動で思い出せなければ、記憶ではない。
    memory.compact();
    await memory.save().catch(() => undefined);
    await warm.pool?.shutdown().catch(() => undefined);
  }
}

function summarize(args: unknown): string {
  if (typeof args !== 'object' || args === null) return '';
  const o = args as Record<string, unknown>;
  const key = ['path', 'command', 'query'].find((k) => typeof o[k] === 'string');
  return key ? String(o[key]).slice(0, 80) : '';
}

function firstLine(s: string): string {
  const line = s.split('\n')[0] ?? '';
  return line.length > 120 ? `${line.slice(0, 120)}...` : line;
}

await main();
