/**
 * aas agent — 作業者(worker)を1名動かす。P1 の入口。
 *
 * ローカルモデルがファイルを読み、差分を出し、承認を経て書き込む。
 * 何時間かかってもよい。打ち切るのは「進捗が無いとき」だけ。
 */
import { findCodeTool, findSymbolTool } from '../agent/tools/find.ts';
import { defaultWorkRoot } from '../core/home.ts';
import { stdin, stdout } from 'node:process';
import { LineSource } from './input.ts';
import { resolve, join } from 'node:path';
import { loadConfig } from '../config.ts';
import { buildRegistry } from '../core/build.ts';
import { ChatOrchestrator } from '../core/orchestrator.ts';
import type { ApprovalRequest } from '../agent/tools/types.ts';
import { readFileTool, listFilesTool, searchTextTool, writeFileTool, editFileTool } from '../agent/tools/fs.ts';
import { createRunCommandTool } from '../agent/tools/shell.ts';
import { inspectGit, describeGitState } from '../agent/git.ts';
import { setupAutopilot, resolveCandidates } from '../core/autopilot-setup.ts';
import { buildRuntime } from '../core/runtime-setup.ts';
import { readyLocalModel } from '../core/local-ready.ts';
import { startWarmPool } from '../core/warm-setup.ts';
import { Prefetcher, describeSnapshot } from '../agent/prefetch.ts';
import type { VerifyEvent } from '../agent/verify.ts';
import { buildHarness } from '../core/harness-setup.ts';
import { formatReport } from '../harness/metrics.ts';
import { formatProposal } from '../agent/proposals.ts';
import { stateDir } from '../core/autopilot-setup.ts';
import { RoleRegistry } from '../roles/registry.ts';
import { RoleLedger, formatChanges } from '../roles/ledger.ts';
import { createFetchUrlTool } from '../agent/tools/network.ts';
import { formatPlan } from '../agent/pm.ts';
import { checkUpdate, applyUpdate, describeUpdate } from '../core/update.ts';
import { formatReport as formatAcceptance } from '../agent/acceptance.ts';
import { formatEntry } from '../memory/memory.ts';
import { Session } from '../core/session.ts';
import { runPanel, mergeFindings } from '../agent/panel.ts';
import { formatIdleStats } from '../harness/idle.ts';
import { BUILTIN_IDLE_MODES } from '../harness/idle-modes.ts';
import { formatDuties } from '../harness/duties.ts';

import { ACK_IDS, ACK_TEXT, isAckId } from '../core/acks.ts';
const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
};

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
  // 候補を入れ直した設定を受け直すので let。入れ直すのは下の readyLocalModel。
  const loaded = loadConfig();
  let config = loaded.config;
  const source = loaded.source;
  const registry = buildRegistry(config);
  const orchestrator = new ChatOrchestrator(registry);

  const agentCfg = config.agent ?? {};
  const root = resolve(agentCfg.root ?? defaultWorkRoot());
  const approval = agentCfg.approval ?? 'autoEdit';

  const rl = new LineSource(stdin, stdout);
  let generating: AbortController | undefined;
  rl.onSigint(() => { if (generating) generating.abort(); else rl.close(); });

  const approve = async (req: ApprovalRequest): Promise<boolean> => {
    // 協議だけは自動承認から外す。人が読まない協議は、記録しか残らない。
    if (approval === 'auto' && req.kind !== 'deliberation') return true;
    if (approval === 'autoEdit' && req.kind === 'write') return true;

    if (req.kind === 'write') {
      console.log('\n' + c.cyan(`  ${req.created ? '新規作成' : '変更'}: ${req.path}`));
      console.log(req.diff ? renderDiff(req.diff) : c.dim('  (差分なし)'));
    } else if (req.kind === 'command') {
      console.log('\n' + c.cyan(`  コマンド実行: ${req.command}`));
    } else if (req.kind === 'deliberation') {
      // 重大な変更。ここは自動承認の対象にせず、必ず読ませる。
      console.log('\n' + c.cyan('  協議: 重大な変更の申し出'));
      for (const line of req.summary.split('\n')) console.log(c.dim(`  ${line}`));
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

  /*
   * **ランタイムを先に起こしてから、候補を決める。**
   *
   * ここは HTTP の一覧（`127.0.0.1:4177/v1/models`）だけを見ていた。
   * この中で読む道では、**その口はモデルを読むまで立たない**ので必ず空になり、
   * 保存先に GGUF が在っても `使えるモデルがありません` で exit 1 していた。
   * 同じ設定・同じ保存先で、画面は普通に答える。doctor も
   * 「動かせます。`npm run agent` で端末」と言う。案内された手が、その場で落ちる。
   *
   * 画面と同じ道（`readyLocalModel`）を通す。読んだものを、そのまま候補にする。
   */
  const runtime = await buildRuntime(config, pilot.machine);
  const ready = await readyLocalModel(config, runtime, (t) => process.stderr.write(c.dim(`  ${t}\n`)));
  config = ready.config;
  const picked = resolveCandidates(config, pilot);
  const candidates = picked.candidates;
  // 保存先から選んだのなら、そう言う。利用者は「設定で固定」していない。
  const note = ready.note ?? picked.note;
  if (candidates.length === 0) {
    console.error(c.red(`使えるモデルがありません: ${ready.why ?? note}`));
    await runtime.shutdown().catch(() => undefined);
    process.exit(1);
  }

  // 状況把握を裏で始める。待たない。利用者が指示を考えている間に済ませる。
  const prefetch = new Prefetcher(root, (e) => {
    if (e.type === 'failed') process.stderr.write(c.dim(`  先読み失敗: ${e.task}\n`));
  });
  prefetch.start();

  // 使うモデルを先に温めておく。作業開始時の待ちをゼロにする。
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

  // 調査担当には書き込みを渡さない。権限が無ければ事故は起きない。
  const readOnlyTools = harness.wrapAll(
    [readFileTool, listFilesTool, searchTextTool], () => currentInstruction);


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
    read: harness.wrapAll([readFileTool, listFilesTool, searchTextTool, findCodeTool, findSymbolTool], () => currentInstruction),
    write: harness.wrapAll([writeFileTool, editFileTool], () => currentInstruction),
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
        const added = (await getSession()).proposals.add({
          kind: f.roleId === 'security' ? 'risk' : 'bug',
          title: f.title, rationale: `[${f.roleName}] ${f.rationale}`,
          evidence: [target], suggestedAction: f.action,
          fingerprint: `panel:${f.title}`,
        });
        console.log(c.cyan(`  💡 [${f.roleName}] ${f.title}`) + also);
        console.log(c.dim(`     ${f.rationale}`));
        if (added) console.log(c.dim(`     → 提案 ${added.id} として登録しました`));
      }
      await (await getSession()).proposals.save();
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
          case 'rolledBack':
            console.log(c.yellow(`  確かめて落ちたので、この依頼の変更を巻き戻しました: ${ev.paths.join(', ') || 'なし'}`
              + (ev.notRestored?.length ? `（戻せなかった: ${ev.notRestored.join(', ')}）` : '')));
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
          case 'handoff':
            console.log(c.dim(`   ${ev.from.join(', ')} → ${ev.taskId} へ申し送り`));
            break;
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
  const idleModes = BUILTIN_IDLE_MODES.filter(
    (m) => !initCfg.modes || initCfg.modes.includes(m.id));

  /**
   * 核。手順はここが持つ。使うときに初めて作る。
   * 提案・日課・思考の配分も核が持っているので、
   * 端末から動かしても画面から動かしても、同じように溜まっていく。
   */
  let core: Session | undefined;
  const getSession = async (): Promise<Session> => {
    core ??= await Session.create(config, { approve });
    return core;
  };

  let lastChangeAt = Date.now();

  /**
   * 待機中の思考。何を考えるかは核の中のスケジューラが決める。
   * ここは選ばれた結果を端末に描くだけ。
   */
  const think = async (): Promise<boolean> => {
    const session = await getSession();
    session.markChanged(lastChangeAt);
    let acted = false;
    const gen = session.think();
    let step = await gen.next();
    while (!step.done) {
      const ev = step.value;
      if (ev.type === 'chose') {
        if (ev.isDuty) process.stderr.write(c.dim(`\n  ${ev.reason}\n`));
        process.stderr.write(c.dim(`\n  [${ev.codename}] ${ev.name} — ${ev.roleCodename}\n`));
      } else if (ev.type === 'noFinding') {
        process.stderr.write(c.dim('    → 報告することはありませんでした\n'));
      } else if (ev.type === 'proposal') {
        console.log(c.cyan(`\n  💡 [${ev.codename}] ${ev.proposal.title}`));
        console.log(c.dim(`     ${ev.proposal.rationale}`));
        console.log(c.dim(`     /do ${ev.proposal.id} で実行、/reject ${ev.proposal.id} で却下\n`));
      }
      step = await gen.next();
    }
    acted = step.value;
    return acted;
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
      if (line === '/new') {
        core?.reset();
        console.log(c.dim('履歴を破棄しました。記憶は残ります。\n'));
        continue;
      }
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
        const duties = (await getSession()).duties;
        console.log(formatDuties(duties.status(Date.now()), Date.now()));
        const pending = duties.due(Date.now());
        console.log(pending.length === 0
          ? c.dim('\n  今やるべき日課はありません。\n')
          : c.yellow(`\n  未了: ${pending.map((p) => p.duty.codename).join(', ')}\n`));
        continue;
      }
      if (line.startsWith('/skip ')) {
        const id = line.slice('/skip '.length).trim();
        const session = await getSession();
        const target = session.duties.duties().find((d) => d.id === id || d.codename === id);
        if (!target) { console.log(c.red(`  日課が見つかりません: ${id}\n`)); continue; }
        session.duties.skip(target.id, Date.now());
        await session.saveAutonomy();
        console.log(c.dim(`  ${target.codename} を今期は流しました。\n`));
        continue;
      }
      if (line === '/idle') {
        const session = await getSession();
        console.log(formatIdleStats(idleModes, session.idle.stats()));
        console.log(c.dim(`\n  この1時間の消費: ${session.idle.spentThisHour(Date.now())}`
          + ` / ${initCfg.budgetPerHour ?? 12}`));
        const d = await session.idle.choose({
          lastChangeAt, openProposals: session.proposals.open().length, now: Date.now(),
        });
        console.log(c.dim(`  次に考えること: ${d.mode ? d.mode.codename : `なし（${d.reason}）`}`));
        const next = session.idle.nextAllowedAt();
        if (next !== undefined && next > Date.now()) {
          console.log(c.dim(`  次に考えてよくなるまで: 約${Math.ceil((next - Date.now()) / 60_000)}分`));
        }
        console.log();
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
        const memory = (await getSession()).memory;
        const found = q
          ? memory.recall(q, { limit: 20, includeSuperseded: true })
          : memory.all().slice(-20);
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
        const memory = (await getSession()).memory;
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
      if (line === '/ack' || line === '/unack') {
        console.log(c.dim(`  使い方: ${line} <警告の名前>（${ACK_IDS.join(', ')}）。一覧は /acks\n`));
        continue;
      }
      if (line === '/acks' || line.startsWith('/ack ') || line.startsWith('/unack ')) {
        const session = await getSession();
        if (line === '/acks') {
          const mine = (await session.acks.list()).filter((a) => a.root === session.root);
          if (mine.length === 0) console.log(c.dim('  この作業場で了解した警告はありません。\n'));
          for (const a of mine) console.log(`  ${c.cyan(a.id)} — ${c.dim(ACK_TEXT[a.id])}`);
          if (mine.length > 0) console.log();
          continue;
        }
        const [cmd, id] = line.split(/\s+/);
        if (!isAckId(id)) {
          console.log(c.red(`  了解できる警告ではありません: ${id ?? ''}（${ACK_IDS.join(', ')}）\n`));
          continue;
        }
        try {
          if (cmd === '/ack') {
            await session.acks.add(id, session.root);
            console.log(c.dim(`  ${id} を了解しました。この作業場では次から出しません（/unack ${id} で戻せます）。\n`));
          } else {
            await session.acks.remove(id, session.root);
            console.log(c.dim(`  ${id} をまた出すようにしました。\n`));
          }
        } catch (e) {
          // 記憶が書けなくても、対話は続ける。
          console.log(c.red(`  了解を保存できませんでした: ${e instanceof Error ? e.message : String(e)}\n`));
        }
        continue;
      }
      if (line === '/proposals') {
        const open = (await getSession()).proposals.open();
        if (open.length === 0) console.log(c.dim('  未処理の提案はありません。\n'));
        else {
          for (const p of open) console.log(formatProposal(p, true) + '\n');
        }
        continue;
      }
      if (line === '/update' || line === '/update!') {
        const status = await checkUpdate(root);
        console.log(c.dim(`  ${describeUpdate(status)}\n`));
        if (!status.can) continue;
        if (line !== '/update!') {
          console.log(c.dim('  取り込むなら /update! を実行してください。\n'));
          continue;
        }
        const r = await applyUpdate(root);
        console.log(r.ok ? c.green(`  ${r.message}\n`) : c.red(`  ${r.message}\n`));
        continue;
      }
      if (line === '/think') { await think(); continue; }
      if (line.startsWith('/do ') || line.startsWith('/reject ')) {
        const [cmd, id] = line.split(/\s+/);
        const session = await getSession();
        const target = await session.decide(
          id ?? '', cmd === '/reject' ? 'rejected' : 'accepted');
        if (!target) { console.log(c.red(`  提案が見つかりません: ${id ?? ''}\n`)); continue; }
        if (cmd === '/reject') {
          console.log(c.dim(`  ${target.id} を却下しました。\n`));
          continue;
        }
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

      // 手順は核が持つ。ここは出来事を端末に描くだけ。
      const session = await getSession();
      generating = new AbortController();
      let printedText = false;
      const flush = () => { if (printedText) { stdout.write('\n'); printedText = false; } };

      try {
        for await (const ev of session.send(request)) {
          switch (ev.type) {
            case 'recalled':
              console.log(c.dim(ev.text.split('\n').map((l) => `  ${l}`).join('\n')));
              break;
            case 'baseline':
              console.log(c.dim(
                ev.cached
                  ? `  作業前の状態（確認済み・再実行なし）: ${ev.command}`
                  : `  作業前の状態を確認中: ${ev.command}`));
              console.log(
                ev.unknown ? c.yellow(`    ${ev.detail ?? '確認できませんでした'}`)
                  : ev.passed ? c.dim('    通っています')
                  : c.yellow('    作業前から失敗しています'));
              break;
            case 'text':
              stdout.write(ev.delta);
              printedText = true;
              break;
            case 'salvaged':
              console.log(c.dim(`  （本文に書かれていた ${ev.name} の呼び出しを拾いました）`));
              break;
            case 'trimmed':
              flush();
              console.log(c.dim(ev.dropped > 0
                ? `  （文脈に収まらないので、古い ${ev.dropped} 往復を省きました）`
                : '  （文脈に収まらないので、古い道具の結果を縮めました）'));
              break;
            case 'nudged':
              flush();
              console.log(c.dim(`  （途中で手が止まったので、続きを促しました。あと ${ev.left} 回）`));
              break;
            case 'toolStart':
              flush();
              console.log(c.dim(`  · ${ev.name} ${ev.summary}`));
              break;
            case 'toolEnd':
              console.log(ev.ok ? c.dim(`    ✓ ${ev.summary}`) : c.red(`    ✗ ${ev.summary}`));
              break;
            case 'fallback':
              flush();
              console.log(c.yellow(`  ⤷ ${ev.from} → ${ev.to} に切替`) + c.dim(` (${ev.reason})`));
              break;
            case 'finished': {
              flush();
              const label = {
                completed: c.green('完了'),
                maxTurns: c.yellow('ターン上限'),
                noProgress: c.yellow('堂々巡りのため停止'),
                aborted: c.dim('中断'),
                failed: c.red('失敗'),
              }[ev.reason] ?? ev.reason;
              console.log(`\n  ${label}${ev.detail ? c.dim(` — ${ev.detail}`) : ''}`);
              break;
            }
            case 'verify':
              flush();
              renderVerify(ev.event);
              break;
            case 'outsideChanged':
              flush();
              if (ev.beforeBaseline) {
                const where = ev.paths ? `${ev.paths.length} 件` : '比べられませんでした';
                console.log(c.yellow(ev.remembered
                  ? `  外のツールが先に作業場を変えました（${where}）。作業前の成否は、この回より前に測った結果を使います。`
                  : `  外のツールが先に作業場を変えました（${where}）。作業前の状態は測れないので、このあと落ちたものは今回の作業のものとして直させます。`));
              } else if (ev.paths) {
                console.log(c.yellow(`  外のツールが作業場を変えました（${ev.paths.length} 件: ${ev.paths.slice(0, 5).join(', ')}${ev.paths.length > 5 ? ' ほか' : ''}）。作業前の状態は測っていないので、落ちても今回の変更が原因とは限りません。一度だけ確かめます。`));
              } else {
                console.log(c.yellow('  外のツールを使いましたが、作業場が変わったかを比べられませんでした（git の管理下でない作業場など）。確かめは回していません。'));
                // 一度伝われば済む。了解は作業場ごとに覚える（画面のボタンと同じ記憶）。
                if (ev.ackable) console.log(c.dim(`     次から出さない: /ack ${ev.ackable}（取り消しは /unack ${ev.ackable}）`));
              }
              break;
            case 'rolledBack':
              flush();
              console.log(c.yellow(`  変更を巻き戻しました: ${ev.paths.join(', ')}`
                + (ev.notRestored?.length ? `（戻せなかった: ${ev.notRestored.join(', ')} — 大きすぎて前の中身を記録していません）` : '') + '\n'));
              break;
            case 'settled': {
              // 画面と同じく、どのモデルがどれだけの速さだったかを添える。
              const speed = typeof ev.tps === 'number' ? ` · ${ev.model} · 約 ${ev.tps} tok/s` : ev.model ? ` · ${ev.model}` : '';
              console.log(c.dim(`  (${ev.seconds.toFixed(1)}s${speed})\n`));
              if (typeof ev.tps === 'number' && ev.tps < 3) {
                console.log(c.yellow(`  遅いです（約 ${ev.tps} tok/s）。このモデルはこの機械には大きすぎるかもしれません。\n`));
              }
              // 確かめて落ちたときだけ、片付けない。
              // （試験の無い作業場で、いつまでも残り続けるのを避ける）
              if (acceptedProposalId && ev.reason === 'completed' && ev.checked !== 'failed' && ev.checked !== 'unsure') {
                await session.completeProposal(acceptedProposalId);
              }
              acceptedProposalId = undefined;
              break;
            }
            case 'log':
              flush();
              console.log(ev.level === 'error' ? c.red(`  ${ev.text}`) : c.yellow(`  ${ev.text}`));
              break;
          }
        }
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
    await core?.close().catch(() => undefined);
    await warm.pool?.shutdown().catch(() => undefined);
    // 起こした子（この中で読む道）も落とす。**温めの片づけは読み込みを解くだけ**で、
    // 子は残る。残ると次の起動で口が埋まり、「モデルが読めない」としか見えない。
    await runtime.shutdown().catch(() => undefined);
  }
}

/** 検証ループの様子を端末に描く。判断はしない。描くだけ。 */
function renderVerify(ev: VerifyEvent): void {
  switch (ev.type) {
    case 'running':
      console.log(c.dim(`  検証 ${ev.round}回目: ${ev.command}`));
      break;
    case 'passed':
      console.log(c.green('  ✓ 検証を通過しました') + c.dim(` (${(ev.durationMs / 1000).toFixed(1)}s)`));
      break;
    case 'failed':
      console.log(c.yellow(`  ✗ 検証に失敗（${ev.round}回目）`));
      console.log(c.dim(ev.digest.split('\n').slice(-6).map((l) => `    ${l}`).join('\n')));
      break;
    case 'preexisting':
      console.log(c.yellow('  この失敗は作業前から出ています。今回の作業が原因ではありません。'));
      console.log(c.dim(ev.digest.split('\n').slice(-4).map((l) => `    ${l}`).join('\n')));
      break;
    case 'tampered':
      console.log(c.red(`  ✗ ${ev.reason}`));
      break;
    case 'fixing':
      console.log(c.dim('  修正させています...'));
      break;
    case 'giveUp':
      console.log(c.yellow(`  検証を打ち切りました — ${ev.detail}`));
      break;
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
