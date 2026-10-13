/**
 * aas chat — LLMに指示を出すための最小CLI。
 *
 * 目的は「動くこと」ではなく「止まらないこと」なので、
 * 応答したモデルを毎回明示し、フォールバックが起きたら必ず知らせる。
 */
import { splitSlash, normalizeLine } from './slash.ts';
import { Priority } from '../providers/contract.ts';
import { stdin, stdout } from 'node:process';
import { LineSource } from './input.ts';
import { loadConfig } from '../config.ts';
import type { ProviderMessage } from '../providers/contract.ts';
import { buildRegistry } from '../core/build.ts';
import { ChatOrchestrator } from '../core/orchestrator.ts';
import { setupAutopilot, resolveCandidates } from '../core/autopilot-setup.ts';
import { buildRuntime } from '../core/runtime-setup.ts';
import { readyLocalModel } from '../core/local-ready.ts';

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
};

const HELP = `
  /models        利用可能なモデルを一覧表示
  /model <id>    使用モデルを固定 (例: /model ollama:qwen3-coder:30b)
  /auto          モデル固定を解除し、設定の候補順に戻す
  /health        各Providerの到達性を確認
  /new           会話履歴を破棄して新しい会話を開始
  /system <文>   システムプロンプトを差し替え
  /exit          終了
  Ctrl-C         生成中なら中断、入力待ちなら終了
`.trimEnd();

async function main(): Promise<void> {
  const loaded = loadConfig();
  // 候補を入れ直した設定を受け直すので let（下の readyLocalModel）。
  let config = loaded.config;
  const source = loaded.source;
  const registry = buildRegistry(config);
  const orchestrator = new ChatOrchestrator(registry);

  const pilot = await setupAutopilot(config, registry);
  /*
   * **ランタイムを先に起こしてから、候補を決める。**
   *
   * この中で読む道では、HTTP の一覧（`127.0.0.1:4177/v1/models`）は
   * **モデルを読むまで立たない**。一覧だけを見ていたので、保存先に GGUF が
   * 在っても `モデル: (なし)` のまま立ち上がり、送ると `失敗 [unavailable]`。
   * 画面は同じ設定で普通に答える。画面と同じ道を通す。
   */
  const runtime = await buildRuntime(config, pilot.machine);
  const ready = await readyLocalModel(config, runtime, (t) => console.log(c.dim(`  ${t}`)));
  config = ready.config;
  const picked = resolveCandidates(config, pilot);
  const resolved = { candidates: picked.candidates, note: ready.note ?? ready.why ?? picked.note };
  let candidates = [...resolved.candidates];
  let system = config.system;
  const history: ProviderMessage[] = [];

  console.log(c.cyan('AdaptiveAIStudio') + c.dim(' — chat (MVP)'));
  console.log(c.dim(`設定: ${source}`));
  console.log(c.dim(`環境: ${pilot.machineText}`));
  console.log(c.cyan(`モデル: ${candidates[0] ?? '(なし)'}`) + c.dim(`  ${resolved.note}`));

  for (const p of registry.list()) {
    const h = await p.health();
    console.log(h.ok
      ? c.dim(`  ${p.id}: `) + c.green('接続OK')
      : c.dim(`  ${p.id}: `) + c.yellow(`接続不可 (${h.reason})`));
  }
  console.log(c.dim('/help でコマンド一覧\n'));

  const rl = new LineSource(stdin, stdout);
  let generating: AbortController | undefined;

  // 生成中の Ctrl-C は中断のみ。入力待ちなら終了。
  rl.onSigint(() => {
    if (generating) {
      generating.abort();
      return;
    }
    // 入力を待っているときだけ閉じる（/health・/models の間に閉じると、命令は最後まで走り、終わった所で対話ごと終わっていた）
    if (rl.waiting) rl.close();
    else console.log(c.dim('（いまの命令は途中で止められません。終わるまで待つか、2 秒以内にもう一度押すと終わります）'));
  });

  try {
    for (;;) {
      const input = await rl.question(c.cyan('> '));
      if (input === undefined) break;
      const line = normalizeLine(input);
      if (line.length === 0) continue;

      if (line.startsWith('/')) {
        const { cmd, arg } = splitSlash(line);

        if (cmd === '/exit' || cmd === '/quit') break;
        if (cmd === '/help') { console.log(HELP); continue; }
        if (cmd === '/new') { history.length = 0; console.log(c.dim('履歴を破棄しました。')); continue; }
        if (cmd === '/system') {
          if (!arg) { console.log(c.dim(`現在: ${system ?? '(未設定)'}`)); continue; }
          system = arg;
          console.log(c.dim('システムプロンプトを更新しました。'));
          continue;
        }
        if (cmd === '/auto') {
          candidates = [...resolveCandidates(config, pilot).candidates];
          console.log(c.dim(`環境: ${pilot.machineText}`));
  console.log(c.cyan(`モデル: ${candidates[0] ?? '(なし)'}`) + c.dim(`  ${resolved.note}`));
          continue;
        }
        if (cmd === '/model') {
          if (!registry.resolve(arg)) {
            console.log(c.red(`不明なモデルです: ${arg}  (/models で確認してください)`));
            continue;
          }
          candidates = [arg];
          console.log(c.dim(`モデルを ${arg} に固定しました。`));
          continue;
        }
        if (cmd === '/models') {
          const models = await registry.listAllModels();
          if (models.length === 0) console.log(c.yellow('モデルが見つかりません。Providerが起動しているか確認してください。'));
          for (const m of models) {
            const pinned = candidates[0] === m.id ? c.green(' ←使用中') : '';
            console.log(`  ${m.id} ${c.dim(`[${m.locality}]`)}${pinned}`);
          }
          continue;
        }
        if (cmd === '/health') {
          for (const p of registry.list()) {
            const h = await p.health();
            const cd = registry.cooldownRemainingMs(p.id);
            const note = cd > 0 ? c.yellow(` 冷却中 ${cd === Infinity ? '(手動解除まで)' : `${Math.ceil(cd / 1000)}s`}`) : '';
            console.log(h.ok ? `  ${p.id}: ${c.green('OK')}${note}` : `  ${p.id}: ${c.yellow(h.reason)}${note}`);
          }
          continue;
        }
        console.log(c.red(`不明なコマンド: ${cmd}`));
        continue;
      }

      history.push({ role: 'user', content: line });

      generating = new AbortController();
      let answer = '';
      let answered: string | undefined;
      let failed = false;
      const started = Date.now();

      try {
        for await (const ev of orchestrator.run(
          { candidates, system, messages: history,
            temperature: config.temperature, maxTokens: config.maxTokens,
            // 端末の前に人が居る。最優先。
            priority: Priority.top },
          generating.signal,
        )) {
          switch (ev.type) {
            case 'attempt':
              if (ev.attempt > 0) process.stderr.write(c.dim(`  (再試行 ${ev.attempt}: ${ev.modelId})\n`));
              break;
            case 'fallback':
              process.stderr.write(c.yellow(`  ⤷ ${ev.from} が使えないため ${ev.to} に切り替えます\n`) + c.dim(`    理由: ${ev.reason}\n`));
              break;
            case 'text':
              answer += ev.delta;
              stdout.write(ev.delta);
              break;
            case 'done':
              answered = ev.modelId;
              break;
            case 'failed':
              failed = true;
              process.stderr.write(c.red(`\n  失敗 [${ev.error.kind}] ${ev.error.message}\n`));
              break;
          }
        }
      } finally {
        generating = undefined;
      }

      if (answer.length > 0) stdout.write('\n');

      if (answered) {
        const secs = ((Date.now() - started) / 1000).toFixed(1);
        console.log(c.dim(`  — ${answered} / ${secs}s\n`));
        history.push({ role: 'assistant', content: answer });
      } else {
        // 応答が無かったターンは履歴に残さない(次回の入力を壊すため)
        history.pop();
        if (!failed) console.log(c.dim('  中断しました。\n'));
      }
    }
  } finally {
    rl.close();
    // 起こした子（この中で読む道）を残さない。残すと次の起動で口が埋まる。
    await runtime.shutdown().catch(() => undefined);
  }
}

await main();
