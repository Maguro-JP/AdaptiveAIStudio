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
    } else {
      console.log('\n' + c.cyan(`  コマンド実行: ${req.command}`));
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

  const initCfg = config.initiative ?? {};
  const proposals = new ProposalQueue(join(stateDir(), 'proposals.json'));
  await proposals.load();

  /**
   * 待機中の自発調査。
   * 手がかりは機械で探し、裏取りと判断だけをモデルにさせる。
   * 見つけたことは提案として溜めるだけで、勝手には直さない。
   */
  const think = async (): Promise<boolean> => {
    if (initCfg.enabled === false) return false;
    const maxOpen = initCfg.maxOpen ?? 10;
    if (proposals.open().length >= maxOpen) return false;

    const snap = await prefetch.snapshotWithin(3000);
    if (!snap) return false;

    // 提案済みだけでなく、調べて問題なしだったものも除く
    const known = proposals.seen();
    const leads = await findLeads({
      root, snapshot: snap, known, max: initCfg.leadsPerCycle ?? 1,
    });
    if (leads.length === 0) return false;

    let printed = false;
    for (const lead of leads) {
      if (proposals.open().length >= maxOpen) break;
      process.stderr.write(c.dim(`\n  考え中: ${lead.title}\n`));

      printed = true;
      const ac = new AbortController();
      generating = ac;
      let text = '';
      try {
        // 調査は読むだけ。書き込みツールは渡さない。
        const investigator = new Agent(orchestrator, {
          candidates,
          system: '与えられた手がかりの裏を取り、指示された形式で提案をまとめる調査担当です。ファイルは変更しません。',
          tools: readOnlyTools,
          root,
          maxTurns: 8,
          temperature: config.temperature,
          maxTokens: config.maxTokens,
          approve: async () => false,
        });
        for await (const ev of investigator.run(
          [{ role: 'user', content: investigationPrompt(lead) }], ac.signal,
        )) {
          if (ev.type === 'thinking') text += ev.delta;
        }
      } catch {
        return printed;
      } finally {
        generating = undefined;
      }

      // 結果にかかわらず「調べた」ことを覚える。同じ所を周回しないため。
      proposals.markExamined(lead.fingerprint);
      await proposals.save();

      const parsed = parseProposal(text);
      if (!parsed) {
        process.stderr.write(c.dim('    → 問題なしと判断しました\n'));
        continue;
      }
      const added = proposals.add({
        kind: lead.kind,
        title: parsed.title,
        rationale: parsed.rationale,
        evidence: lead.files,
        suggestedAction: parsed.action,
        fingerprint: lead.fingerprint,
      });
      if (added) {
        await proposals.save();
        console.log(c.cyan(`\n  💡 提案 ${added.id}: ${added.title}`));
        console.log(c.dim(`     ${added.rationale}`));
        console.log(c.dim(`     /proposals で詳細、/do ${added.id} で実行\n`));
      }
    }
    return printed;
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
          await proposals.save();
          console.log(c.dim(`  ${target.id} を却下しました。\n`));
          continue;
        }
        proposals.setStatus(target.id, 'accepted');
        await proposals.save();
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
      history.push({ role: 'user', content: request });
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

        // 作業のあとは状況が変わっている。次の手がかりを探し直す。
        prefetch.invalidate();
      } finally {
        generating = undefined;
      }
    }
  } finally {
    rl.close();
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
