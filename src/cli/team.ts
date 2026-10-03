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
import { wireTeam, parseTasks } from '../core/team-setup.ts';
import { readyLocalModel } from '../core/local-ready.ts';
import { RoleRegistry } from '../roles/registry.ts';

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

  // 作業指示書は、モデルを起こす前に読んで確かめる（起こした後で落ちると、Windows では llama-server が残る）
  let items: WorkItem[];
  try {
    const roles = new RoleRegistry(config.roles ?? []);
    items = parseTasks(await readFile(resolve(taskFile), 'utf8'), agentCfg.lanes?.map((l) => l.id) ?? ['default'],
      (id) => roles.get(id) !== undefined);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }

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

  const rl = createInterface({ input: stdin, output: stdout });
  const ac = new AbortController();
  rl.on('SIGINT', () => ac.abort());
  // 入力が端末でない（パイプ・リダイレクト）と rl の SIGINT は来ない。止めずに落ちると戻り先が残らない。
  process.once('SIGINT', () => ac.abort());

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
  // 始めに作業場の記録を取る（大きい作業場では少しかかる。黙っていると止まって見える）。
  console.log(c.dim('作業場の記録を取っています…'));
  // 組み立てで落ちても、起こした子（llama-server）を残さない。下の try はまだ始まっていない。
  let wired: Awaited<ReturnType<typeof wireTeam>>;
  try {
    wired = await wireTeam(config, root, (d) => {
      if (d.outcome === 'denied') console.log(c.red(`   ⛔ ${d.rule}: ${d.reason ?? ''}`));
      else if (d.outcome === 'warned') console.log(c.yellow(`   ⚠ ${d.rule}: ${d.reason ?? ''}`));
    }, Date.now(), SYSTEM);
  } catch (e) {
    console.error(c.red(`作業の支度ができませんでした: ${(e as Error).message}`));
    await runtime.shutdown().catch(() => undefined);
    rl.close();
    process.exit(1);
  }

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

  /*
   * 途中で例外が出ても、戻り先を閉じてから終える（閉じないと、書くツールの分も run_command の分も戻せない）。
   * 起こした子も残さない。
   */
  try {
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
  } finally {
    // 控えを閉じる。閉じないと、次の一回ぶんと混ざって戻しすぎる。run_command の分もここで載せる。
    const closed = await wired.finish().catch((e: unknown) => {
      // 書き換えは済んでいる。戻り先だけが残っていないことを言う（黙ると画面の「戻す」で戻せるつもりのままになる）
      console.log(c.yellow(`戻り先を残せませんでした（${(e as Error).message}）。この回の変更は画面の「戻す」からは戻せません`));
      return undefined;
    });
    if (closed?.point) {
      // run_command の分が載っていないときは、書くツールの分だけだと分かる言い方にする
      const scope = closed.outsideLost ? '書くツールで変えた分だけ、画面の「戻す」から戻せます' : '画面の「戻す」から戻せます';
      console.log(c.dim(`戻り先: ${closed.point.id}（${scope}）`));
    }
    if (closed && closed.unrecorded.length > 0) {
      console.log(c.yellow(`前の中身を記録できず、戻せないファイル: ${closed.unrecorded.join(', ')}`));
    }
    if (closed?.outsideLost) {
      console.log(c.yellow(`run_command で変わったファイルを調べられませんでした（${closed.outsideLost}）。その分は画面の「戻す」からは戻せません`));
    }
    // 起こした子（この中で読む道）を残さない。残すと次の起動で口が埋まる。
    await runtime.shutdown().catch(() => undefined);
    rl.close();
  }
}

await main();
