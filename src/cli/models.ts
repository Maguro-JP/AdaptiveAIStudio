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

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
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
  console.log(c.dim(runtime.id === 'llamacpp'
    ? '  GGUFファイルを modelsDir に置いてください。'
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
