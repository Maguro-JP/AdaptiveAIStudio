/**
 * aas agent — 作業者(worker)を1名動かす。P1 の入口。
 *
 * ローカルモデルがファイルを読み、差分を出し、承認を経て書き込む。
 * 何時間かかってもよい。打ち切るのは「進捗が無いとき」だけ。
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { resolve } from 'node:path';
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

/**
 * 入力を1行受け取る。標準入力が閉じている場合は undefined を返す。
 * パイプで流し込まれた入力が尽きたときに例外で落ちないようにする。
 */
async function askOrExit(
  rl: { question(q: string): Promise<string> },
  prompt: string,
): Promise<string | undefined> {
  try {
    return await rl.question(prompt);
  } catch (e) {
    if (e instanceof Error && /closed/i.test(e.message)) return undefined;
    throw e;
  }
}

async function main(): Promise<void> {
  const { config, source } = loadConfig();
  const registry = buildRegistry(config);
  const orchestrator = new ChatOrchestrator(registry);

  const agentCfg = config.agent ?? {};
  const root = resolve(agentCfg.root ?? process.cwd());
  const approval = agentCfg.approval ?? 'autoEdit';

  const rl = createInterface({ input: stdin, output: stdout });
  let generating: AbortController | undefined;
  rl.on('SIGINT', () => { if (generating) generating.abort(); else rl.close(); });

  const approve = async (req: ApprovalRequest): Promise<boolean> => {
    if (approval === 'auto') return true;
    if (approval === 'autoEdit' && req.kind === 'write') return true;

    if (req.kind === 'write') {
      console.log('\n' + c.cyan(`  ${req.created ? '新規作成' : '変更'}: ${req.path}`));
      console.log(req.diff ? renderDiff(req.diff) : c.dim('  (差分なし)'));
    } else {
      console.log('\n' + c.cyan(`  コマンド実行: ${req.command}`));
    }
    const ans = await askOrExit(rl, c.yellow('  許可しますか？ [y/N] '));
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

  // 使うモデルを先に温めておく。作業開始時の待ちをゼロにする。
  const runtime = buildRuntime(config, pilot.machine);
  const warm = await startWarmPool(config, runtime, pilot.machine, candidates, (e) => {
    if (e.type === 'warming') process.stderr.write(c.dim(`  温め中: ${e.ref}...\n`));
    else if (e.type === 'warm') process.stderr.write(c.dim(`  常駐: ${e.ref} (${e.loadSeconds}秒)\n`));
    else if (e.type === 'failed') process.stderr.write(c.yellow(`  温め失敗: ${e.ref} (${e.error})\n`));
    else if (e.type === 'evict') process.stderr.write(c.dim(`  解放: ${e.ref} (${e.reason})\n`));
  });

  const tools = [
    readFileTool, listFilesTool, searchTextTool, writeFileTool,
    createRunCommandTool({ allowed: agentCfg.allowedCommands }),
  ];

  const agent = new Agent(orchestrator, {
    candidates,
    system: SYSTEM,
    tools,
    root,
    maxTurns: agentCfg.maxTurns ?? 40,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    approve,
  });

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
  console.log(c.dim('作業を指示してください。/exit で終了。\n'));

  const history: ProviderMessage[] = [];

  try {
    for (;;) {
      const answer = await askOrExit(rl, c.cyan('依頼> '));
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
      if (line === '/warm') {
        const status = warm.pool?.status() ?? [];
        if (status.length === 0) console.log(c.dim('  常駐しているモデルはありません。\n'));
        for (const s of status) {
          console.log(`  ${s.ref} ${s.inUse ? c.green('使用中') : c.dim(`待機 ${s.idleSeconds}秒`)}`);
        }
        console.log();
        continue;
      }

      history.push({ role: 'user', content: line });
      generating = new AbortController();
      const started = Date.now();
      let printedText = false;
      let answerChars = 0;

      try {
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
            case 'toolStart':
              console.log(c.dim(`  · ${ev.call.name} ${summarize(ev.call.args)}`));
              break;
            case 'toolEnd':
              console.log(ev.isError
                ? c.red(`    ✗ ${firstLine(ev.result)}`)
                : c.dim(`    ✓ ${firstLine(ev.result)}`));
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
              break;
            }
          }
        }
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
