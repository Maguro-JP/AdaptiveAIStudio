/**
 * ランタイムの組み立て。
 * ollama と llamacpp を同じ LocalRuntime として扱い、設定で切り替える。
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { AasConfig } from '../config.ts';
import type { LocalRuntime } from '../runtime/local-runtime.ts';
import { LlamaCppRuntime } from '../runtime/llamacpp.ts';
import { OllamaRuntime } from '../runtime/ollama.ts';
import { findInstalled } from '../runtime/llama-install.ts';
import type { MachineSpec } from '../runtime/spec.ts';

export async function buildRuntime(
  config: AasConfig,
  machine: MachineSpec,
  onLog?: (line: string) => void,
): Promise<LocalRuntime> {
  const rc = config.runtime ?? {};
  if (rc.kind !== 'llamacpp') {
    const ollama = config.providers.find((p) => p.kind === 'openai-compatible' && p.locality === 'local');
    return new OllamaRuntime({ baseUrl: ollama?.baseUrl });
  }

  // 設定に書かれていなければ、自前で用意したものを使う。
  // 「PATH にある誰かが入れたもの」に頼ると、それを消された時点で動かなくなる。
  const command = rc.command ?? await findInstalled() ?? 'llama-server';

  return new LlamaCppRuntime({
    command,
    commandArgs: rc.commandArgs,
    modelsDir: rc.modelsDir ?? join(homedir(), '.aas', 'models'),
    machine,
    basePort: rc.basePort,
    parallel: rc.parallel,
    desiredContext: rc.desiredContext,
    onLog,
  });
}
