/**
 * aas team <tasks.json> — 複数の作業者を並列で動かす。P2 の入口。
 *
 * 作業指示書は今は手書きだが、P3 で PM が自動生成するようになる。
 * 形式はそのまま引き継ぐ。
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadConfig } from '../config.ts';
import { buildRegistry } from '../core/build.ts';
import { ChatOrchestrator } from '../core/orchestrator.ts';
import { Team, type WorkItem } from '../agent/team.ts';
import type { ApprovalRequest } from '../agent/tools/types.ts';
import { readFileTool, listFilesTool, searchTextTool, writeFileTool } from '../agent/tools/fs.ts';
import { createRunCommandTool } from '../agent/tools/shell.ts';
import { inspectGit, describeGitState } from '../agent/git.ts';
import { setupAutopilot, resolveCandidates } from '../core/autopilot-setup.ts';

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
};

const SYSTEM = `あなたはソフトウェア開発チームの作業者です。割り当てられた作業だけを行います。

守ること:
- 自分の担当範囲の外のファイルは変更しない。他の作業者が同時に作業している。
- 推測でファイルを書かない。まず read_file / search_text で現状を確認する。
- write_file には必ずファイルの全内容を渡す。
- 作業が終わったら、何をしたかを簡潔に日本語で報告する。ツールは呼ばない。

時間はいくらかかっても構わない。正確さを優先すること。`;

async function main(): Promise<void> {
  const taskFile = process.argv[2];
  if (!taskFile) {
    console.error('使い方: npm run team -- <tasks.json>');
    process.exit(1);
  }

  const { config, source } = loadConfig();
  const agentCfg = config.agent ?? {};
  const root = resolve(agentCfg.root ?? process.cwd());
  const approval = agentCfg.approval ?? 'autoEdit';

  const registry = buildRegistry(config);
  const pilot = await setupAutopilot(config, registry);
  const resolved = resolveCandidates(config, pilot);
  if (resolved.candidates.length === 0) {
    console.error(`使えるモデルがありません: ${resolved.note}`);
    process.exit(1);
  }

  // レーン未指定なら、自動選択したモデル1本で並列2のレーンを作る
  const lanes = agentCfg.lanes ?? [
    { id: 'default', candidates: resolved.candidates, parallel: 2 },
  ];

  const items = JSON.parse(await readFile(resolve(taskFile), 'utf8')) as WorkItem[];
  for (const item of items) {
    if (!lanes.some((l) => l.id === item.laneId)) {
      console.error(`タスク "${item.id}" のレーン "${item.laneId}" が設定にありません。`);
      process.exit(1);
    }
  }

  const rl = createInterface({ input: stdin, output: stdout });
  const ac = new AbortController();
  rl.on('SIGINT', () => ac.abort());

  const approve = async (req: ApprovalRequest): Promise<boolean> => {
    if (approval === 'auto') return true;
    if (approval === 'autoEdit' && req.kind === 'write') return true;
    // 並列実行中に対話で止めると他の作業者も待たされるため、
    // ask モードではコマンド実行を許可せず、記録だけ残す。
    if (req.kind === 'command') {
      console.log(c.yellow(`  コマンド実行はチーム実行では自動承認されません: ${req.command}`));
      return false;
    }
    return false;
  };

  const team = new Team(new ChatOrchestrator(registry), {
    lanes,
    system: SYSTEM,
    tools: [readFileTool, listFilesTool, searchTextTool, writeFileTool,
            createRunCommandTool({ allowed: agentCfg.allowedCommands })],
    root,
    maxTurns: agentCfg.maxTurns ?? 40,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    maxTotalParallel: agentCfg.maxTotalParallel,
    approve,
  });

  console.log(c.cyan('AdaptiveAIStudio') + c.dim(' — team (並列作業)'));
  console.log(c.dim(`設定: ${source}`));
  console.log(c.dim(`作業ディレクトリ: ${root}`));
  console.log(c.dim(`環境: ${pilot.machineText}`));
  if (!agentCfg.lanes) console.log(c.dim(`  ${resolved.note}`));
  for (const l of lanes) {
    console.log(c.dim(`  レーン ${l.id}: ${l.candidates[0]} (並列 ${l.parallel})`));
  }
  const git = describeGitState(await inspectGit(root));
  console.log(git.risky ? c.yellow(`  ${git.text}`) : c.dim(`  ${git.text}`));
  console.log(c.dim(`タスク ${items.length} 件\n`));

  const gen = team.run(items, ac.signal);
  let next = await gen.next();
  while (!next.done) {
    const p = next.value;
    switch (p.type) {
      case 'taskStart':
        console.log(c.cyan(`▶ ${p.taskId}`) + c.dim(` [${p.laneId}]`));
        break;
      case 'taskEnd':
        console.log(p.state === 'done'
          ? c.green(`✓ ${p.taskId}`) + c.dim(` (${(p.ms / 1000).toFixed(1)}s)`)
          : c.red(`✗ ${p.taskId}`) + c.dim(` ${p.error ?? ''}`));
        break;
      case 'taskSkip':
        console.log(c.yellow(`− ${p.taskId} skip`) + c.dim(` (${p.reason})`));
        break;
      case 'agent': {
        const ev = p.event;
        if (ev.type === 'toolStart') console.log(c.dim(`   ${p.taskId} · ${ev.call.name}`));
        else if (ev.type === 'toolEnd' && ev.isError) console.log(c.red(`   ${p.taskId} ✗ ${ev.result.split('\n')[0]}`));
        break;
      }
    }
    next = await gen.next();
  }

  const outcomes = next.value;
  const done = [...outcomes.values()].filter((o) => o.state === 'done').length;
  console.log(`\n完了 ${done}/${outcomes.size}`);
  rl.close();
}

await main();
