/**
 * aas chat — LLMに指示を出すための最小CLI。
 *
 * 目的は「動くこと」ではなく「止まらないこと」なので、
 * 応答したモデルを毎回明示し、フォールバックが起きたら必ず知らせる。
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadConfig, type AasConfig } from '../config.ts';
import { OpenAiCompatibleProvider } from '../providers/openai-compatible.ts';
import { AnthropicProvider } from '../providers/anthropic.ts';
import type { ProviderMessage } from '../providers/contract.ts';
import { ProviderRegistry } from '../core/registry.ts';
import { ChatOrchestrator } from '../core/orchestrator.ts';

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
};

function buildRegistry(config: AasConfig): ProviderRegistry {
  const registry = new ProviderRegistry();
  for (const p of config.providers) {
    const apiKey = p.apiKeyEnv ? process.env[p.apiKeyEnv] : undefined;
    if (p.kind === 'anthropic') {
      registry.register(new AnthropicProvider({ id: p.id, apiKey, fallbackModels: p.models }));
    } else {
      registry.register(new OpenAiCompatibleProvider({
        id: p.id,
        baseUrl: p.baseUrl!,
        locality: p.locality,
        apiKey,
        fallbackModels: p.models,
      }));
    }
  }
  return registry;
}

const HELP = `
  /models        利用可能なモデルを一覧表示
  /model <id>    使用モデルを固定 (例: /model ollama:qwen2.5-coder:7b)
  /auto          モデル固定を解除し、設定の候補順に戻す
  /health        各Providerの到達性を確認
  /new           会話履歴を破棄して新しい会話を開始
  /system <文>   システムプロンプトを差し替え
  /exit          終了
  Ctrl-C         生成中なら中断、入力待ちなら終了
`.trimEnd();

async function main(): Promise<void> {
  const { config, source } = loadConfig();
  const registry = buildRegistry(config);
  const orchestrator = new ChatOrchestrator(registry);

  let candidates = [...config.candidates];
  let system = config.system;
  const history: ProviderMessage[] = [];

  console.log(c.cyan('AdaptiveAIStudio') + c.dim(' — chat (MVP)'));
  console.log(c.dim(`設定: ${source}`));
  console.log(c.dim(`候補: ${candidates.join(' → ')}`));

  for (const p of registry.list()) {
    const h = await p.health();
    console.log(h.ok
      ? c.dim(`  ${p.id}: `) + c.green('接続OK')
      : c.dim(`  ${p.id}: `) + c.yellow(`接続不可 (${h.reason})`));
  }
  console.log(c.dim('/help でコマンド一覧\n'));

  const rl = createInterface({ input: stdin, output: stdout });
  let generating: AbortController | undefined;

  // 生成中の Ctrl-C は中断のみ。入力待ちなら終了。
  rl.on('SIGINT', () => {
    if (generating) {
      generating.abort();
      return;
    }
    rl.close();
  });

  try {
    for (;;) {
      const line = (await rl.question(c.cyan('> '))).trim();
      if (line.length === 0) continue;

      if (line.startsWith('/')) {
        const [cmd, ...rest] = line.split(/\s+/);
        const arg = rest.join(' ');

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
          candidates = [...config.candidates];
          console.log(c.dim(`候補: ${candidates.join(' → ')}`));
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
            temperature: config.temperature, maxTokens: config.maxTokens },
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
  }
}

await main();
