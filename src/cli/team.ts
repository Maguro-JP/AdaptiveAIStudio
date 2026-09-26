/**
 * aas team <tasks.json> — 複数の作業者を並列で動かす。P2 の入口。
 *
 * 作業指示書は今は手書きだが、P3 で PM が自動生成するようになる。
 * 形式はそのまま引き継ぐ。
 */
import { defaultWorkRoot } from '../core/home.ts';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadConfig } from '../config.ts';
import { buildRegistry } from '../core/build.ts';
import { ChatOrchestrator } from '../core/orchestrator.ts';
import { Team, type WorkItem } from '../agent/team.ts';
import type { ApprovalRequest } from '../agent/tools/types.ts';
import { inspectGit, describeGitState } from '../agent/git.ts';
import { setupAutopilot, resolveCandidates } from '../core/autopilot-setup.ts';
import { buildRuntime } from '../core/runtime-setup.ts';
import { wireTeam } from '../core/team-setup.ts';
import { readyLocalModel } from '../core/local-ready.ts';

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

  const loaded = loadConfig();
  // 候補を入れ直した設定を受け直すので let（下の readyLocalModel）。
  let config = loaded.config;
  const source = loaded.source;
  const agentCfg = config.agent ?? {};
  const root = resolve(agentCfg.root ?? defaultWorkRoot());
  const approval = agentCfg.approval ?? 'autoEdit';

  const registry = buildRegistry(config);
  const pilot = await setupAutopilot(config, registry);
  /*
   * **ランタイムを先に起こしてから、候補を決める。**agent / chat と同じ理由。
   * この中で読む道の口は、モデルを読むまで立たないので、一覧だけを見ると必ず空。
   */
  const runtime = await buildRuntime(config, pilot.machine);
  const ready = await readyLocalModel(config, runtime, (t) => console.log(`  ${t}`));
  config = ready.config;
  const picked = resolveCandidates(config, pilot);
  const resolved = { candidates: picked.candidates, note: ready.note ?? picked.note };
  if (resolved.candidates.length === 0) {
    console.error(`使えるモデルがありません: ${ready.why ?? picked.note}`);
    await runtime.shutdown().catch(() => undefined);
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

  /*
   * **ここもハーネスと戻り先を通す。**組み立ては `core/team-setup.ts`。
   * 入口の中に書くと、モデルを立てないと一度も通らないので外へ出してある。
   */
  const wired = await wireTeam(config, root, (d) => {
    if (d.outcome === 'denied') console.log(c.red(`   ⛔ ${d.rule}: ${d.reason ?? ''}`));
    else if (d.outcome === 'warned') console.log(c.yellow(`   ⚠ ${d.rule}: ${d.reason ?? ''}`));
  }, Date.now(), SYSTEM);

  const team = new Team(new ChatOrchestrator(registry), {
    lanes,
    system: SYSTEM,
    tools: wired.bare,
    toolsFor: (item) => wired.toolsFor(item),
    beforeWrite: (path, previous) => wired.beforeWrite(path, previous),
    // 役職が付いた依頼は、役職で絞ってから渡す。
    assign: (roleId, item) => wired.assign(roleId, item),
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
  console.log(c.dim(`規則 ${wired.harness.rules().length} 件（実行の手前で止まる）`));
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
      case 'handoff':
        console.log(c.dim(`   ${p.from.join(', ')} → ${p.taskId} へ申し送り`));
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
  // 控えを閉じる。閉じないと、次の一回ぶんと混ざって戻しすぎる。run_command の分もここで載せる。
  const { point: back, unrecorded } = await wired.finish();
  if (back) console.log(c.dim(`戻り先: ${back.id}（aas undo で戻せます）`));
  if (unrecorded.length > 0) {
    console.log(c.yellow(`前の中身を記録できず、戻せないファイル: ${unrecorded.join(', ')}`));
  }
  // 起こした子（この中で読む道）を残さない。残すと次の起動で口が埋まる。
  await runtime.shutdown().catch(() => undefined);
  rl.close();
}

await main();
