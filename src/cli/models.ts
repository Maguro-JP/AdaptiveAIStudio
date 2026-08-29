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

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
};

const { config } = loadConfig();
const machine = await new MachineCache(join(stateDir(), 'machine.json')).get();
const runtime = buildRuntime(config, machine);

console.log(c.cyan('AdaptiveAIStudio') + c.dim(` — models (${runtime.id})`));
console.log(c.dim(`環境: ${describeMachine(machine)}\n`));

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
