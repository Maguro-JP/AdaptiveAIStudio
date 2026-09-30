/**
 * aas models — 導入済みモデルと、その実行計画を一覧表示する。
 *
 * 「このモデルはこのPCでどう動くのか」を、起動前に見せるための入口。
 */
import { loadConfig } from '../config.ts';
import { buildRuntime } from '../core/runtime-setup.ts';
import { MachineCache, describeMachine } from '../runtime/machine.ts';
import { estimateDuration } from '../runtime/planner.ts';
import { LlamaCppRuntime } from '../runtime/llamacpp.ts';
import { stateDir } from '../core/autopilot-setup.ts';
import { join } from 'node:path';
import { GB } from '../runtime/spec.ts';
import { readGguf } from '../runtime/gguf.ts';
import { toModelSpec, formatGguf } from '../runtime/gguf-spec.ts';
import { installModel, defaultModelsDir, quantFrom } from '../runtime/model-install.ts';
import { usesGguf } from '../runtime/local-runtime.ts';
import { lookupCatalog, formatCatalog, STARTER_ID } from '../runtime/model-catalog.ts';
import { pullModel } from '../runtime/ollama-pull.ts';
import { findNewerOllama, describeNewer } from '../runtime/model-updates.ts';

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
};

const { config } = loadConfig();
const machine = await new MachineCache(join(stateDir(), 'machine.json')).get();
const runtime = await buildRuntime(config, machine);

console.log(c.cyan('AdaptiveAIStudio') + c.dim(` — models (${runtime.id})`));
console.log(c.dim(`環境: ${describeMachine(machine)}\n`));

/**
 * --inspect: GGUF を読んで、書いてあることをそのまま出す。
 *
 * この読み取りは仕様の理解に依っているので、
 * **本物で目視して確かめる手段**がどうしても要る。それがこれ。
 * 値がおかしければ、この出力をそのまま知らせてもらえば直せる。
 */
/**
 * --get: モデルを取ってくる。
 *
 * llama-server は自前で用意できるのに、動かす中身は
 * 「手で落として置いてください」のままだった。片肺なので繋ぐ。
 */
/** 手元の Ollama の口。設定に無ければ既定を使う。 */
function localBaseUrl(): string {
  return config.providers.find((p) => p.kind === 'openai-compatible' && p.locality === 'local')?.baseUrl
    ?? 'http://localhost:11434/v1';
}

/**
 * --new: 新しい世代が出ていないかを配布元へ訊く。
 *
 * ローカルで動かす以上、古くて性能の低いものを使い続ける理由が無い。
 * ただし乗り換えの起点が「カタログを書き換える」だけだと、
 * 書いた人が古くなった時点で止まる。だから配布元に訊く。
 */
if (process.argv.includes('--new')) {
  const installed = (await runtime.list()).map((m) => m.ref);
  if (installed.length === 0) {
    console.log(c.yellow('  手元にモデルがありません。まず npm run models -- --get\n'));
    process.exit(0);
  }
  console.log(c.dim(`  手元: ${installed.join(', ')}\n`));
  console.log(c.dim('  配布元に訊いています...'));
  try {
    const found = await findNewerOllama({ installed });
    console.log(`\n${describeNewer(found)}\n`);
  } catch (e) {
    console.error(c.yellow(`  訊けませんでした: ${e instanceof Error ? e.message : String(e)}\n`));
    process.exit(1);
  }
  process.exit(0);
}

if (process.argv.includes('--get') || process.argv.includes('--available')) {
  const modelsDir = config.runtime?.modelsDir ?? defaultModelsDir();

  if (process.argv.includes('--available')) {
    console.log(formatCatalog(usesGguf(runtime.id) ? 'llamacpp' : 'ollama'));
    console.log(c.dim(usesGguf(runtime.id)
      ? `\n  置き場: ${modelsDir}`
      : '\n  置き場: Ollama が持っています'));
    console.log(c.dim('  取ってくる: npm run models -- --get [名前]'));
    if (!usesGguf(runtime.id)) {
      console.log(c.dim('  一覧に無いものは、Ollama の名前をそのまま渡せます（例: --get gemma3:4b）'));
    }
    console.log();
    process.exit(0);
  }

  const wanted = process.argv[process.argv.indexOf('--get') + 1];
  const id = wanted && !wanted.startsWith('--') ? wanted : STARTER_ID;
  const entry = lookupCatalog(id);

  // 一覧に無い名前も、そのまま渡せる。
  // **この一覧は必ず古くなる**ので、載っているものしか取れない作りにすると、
  // 表を書いた人（＝私）が直すまで新しいモデルが使えないことになる。
  // llama.cpp なら Hugging Face の置き場名、Ollama ならあちらの名前。
  if (!entry && usesGguf(runtime.id) && id.includes('/')) {
    const quant = quantFrom(process.argv);
    console.log(c.cyan(`  ${id}`) + c.dim(` — 一覧にはありませんが、そのまま取ってきます（${quant}）`));
    try {
      const r = await installModel({
        entry: {
          id, repo: id, quant, ollama: '', approxGB: 0,
          note: '', license: '(配布元の表示を確認してください)',
        },
        modelsDir,
        onProgress: (line) => console.log(c.dim(`  ${line}`)),
      });
      console.log(c.green(`\n  用意できました: ${r.path}`));
      console.log(c.dim(`  ${(r.bytes / GB).toFixed(1)}GB\n`));
    } catch (e) {
      console.error(c.yellow(`\n  取ってこられませんでした: ${e instanceof Error ? e.message : String(e)}\n`));
      process.exit(1);
    }
    process.exit(0);
  }

  if (!entry && !usesGguf(runtime.id) && id.includes(':')) {
    console.log(c.cyan(`  ${id}`) + c.dim(' — 一覧にはありませんが、そのまま頼みます'));
    try {
      await pullModel({
        baseUrl: localBaseUrl(), ref: id,
        onProgress: (line) => console.log(c.dim(line)),
      });
      console.log(c.green(`\n  用意できました: ${id}\n`));
    } catch (e) {
      console.error(c.yellow(`\n  取ってこられませんでした: ${e instanceof Error ? e.message : String(e)}\n`));
      process.exit(1);
    }
    process.exit(0);
  }

  if (!entry) {
    console.error(c.yellow(`知らないモデルです: ${id}`));
    console.log(c.dim(usesGguf(runtime.id)
      ? '  Hugging Face の置き場名（例: Qwen/Qwen3-8B-GGUF）なら、そのまま渡せます。'
      : '  Ollama の名前（例: qwen3-coder:30b）なら、そのまま渡せます。'));
    console.log(c.dim(`\n${formatCatalog(usesGguf(runtime.id) ? 'llamacpp' : 'ollama')}\n`));
    if (!usesGguf(runtime.id)) {
      console.log(c.dim('  Ollama の名前をそのまま渡すこともできます（例: --get gemma3:4b）\n'));
    }
    process.exit(1);
  }

  console.log(c.cyan(`  ${entry.id}`) + c.dim(` — ${entry.note}`));

  // 道によって取ってくる先が違う。使う人が意識しなくて済むよう、こちらで振り分ける。
  if (!usesGguf(runtime.id)) {
    console.log(c.dim(`  Ollama に頼みます: ${entry.ollama}\n`));
    try {
      await pullModel({
        baseUrl: localBaseUrl(),
        ref: entry.ollama,
        onProgress: (line) => console.log(c.dim(line)),
      });
      console.log(c.green(`\n  用意できました: ${entry.ollama}\n`));
    } catch (e) {
      console.error(c.yellow(`\n  取ってこられませんでした: ${e instanceof Error ? e.message : String(e)}\n`));
      process.exit(1);
    }
    process.exit(0);
  }

  console.log(c.dim(`  配布元: ${entry.repo}（${entry.license}）`));
  console.log(c.dim(`  置き場: ${modelsDir}\n`));

  try {
    const r = await installModel({
      entry, modelsDir, onProgress: (line) => console.log(c.dim(`  ${line}`)),
    });
    console.log(c.green(`\n  用意できました: ${r.path}`));
    console.log(c.dim(`  ${(r.bytes / GB).toFixed(1)}GB\n`));
    console.log(c.dim('  2つ目からは、同じ置き場に .gguf を入れるだけでも使えます。\n'));
  } catch (e) {
    console.error(c.yellow(`\n  取ってこられませんでした: ${e instanceof Error ? e.message : String(e)}\n`));
    console.log(c.dim(`  手で入れる場合は、${modelsDir} に .gguf を置いてください。\n`));
    process.exit(1);
  }
  process.exit(0);
}

const inspectAt = process.argv.indexOf('--inspect');
if (inspectAt !== -1) {
  const path = process.argv[inspectAt + 1];
  if (!path) {
    console.error(c.yellow('使い方: npm run models -- --inspect <ファイル.gguf>'));
    process.exit(1);
  }
  try {
    const file = await readGguf(path);
    console.log(formatGguf(file, toModelSpec(file)));
    if (file.warnings.length > 0) {
      console.log(c.dim('\n  ※ 先頭だけを読んでいます。テンソルが多い場合、一覧は途中までです。'));
    }
  } catch (e) {
    console.error(c.yellow(`読めませんでした: ${(e as Error).message}`));
    process.exit(1);
  }
  process.exit(0);
}

const models = await runtime.list();
if (models.length === 0) {
  console.log(c.yellow('モデルが見つかりません。'));
  console.log(c.dim(usesGguf(runtime.id)
    ? '  `npm run models -- --get` で取ってきます（まず動く軽いものが入ります）。\n'
      + '  一覧は `npm run models -- --available`。\n'
      + '  手持ちがあるなら、同じ置き場に .gguf を入れるだけでも使えます。'
    : '  Ollama が起動しているか確認してください。'));
  process.exit(0);
}

for (const m of models) {
  const size = m.sizeBytes ? c.dim(` (${(m.sizeBytes / GB).toFixed(1)}GB)`) : '';
  console.log(c.cyan(m.ref) + size);

  if (runtime instanceof LlamaCppRuntime) {
    // ファイルから読めていれば、そう明示する。推測との差は大きい。
    const fromFile = runtime.specFor(m.ref);
    console.log(fromFile
      ? c.dim(`  ファイルから読取: ${fromFile.layers}層 / KV ${fromFile.kvHeads}ヘッド`
        + ` / 約${fromFile.paramsB.toFixed(1)}B / ${fromFile.bitsPerWeight}bit`)
      : c.yellow('  ファイルから諸元を読めませんでした（名前からの推測を使います）'));

    const plan = runtime.planFor(m.ref);
    if (!plan) {
      console.log(c.yellow('  規模を判定できません（ファイル名に 7b / 32b などが必要）'));
      continue;
    }
    console.log(`  ${plan.summary}`);
    console.log(c.dim(`  VRAM ${(plan.vramUsedBytes / GB).toFixed(1)}GB / RAM ${(plan.ramUsedBytes / GB).toFixed(1)}GB`));
    console.log(c.dim(`  1000トークンの応答: ${estimateDuration(plan, 1000)}`));
    if (plan.degradations.length > 0) {
      console.log(c.yellow(`  劣化: ${plan.degradations.join(' / ')}`));
    }
  }
  console.log();
}
