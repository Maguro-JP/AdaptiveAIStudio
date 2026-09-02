/**
 * ランタイムの組み立て。
 * ollama と llamacpp を同じ LocalRuntime として扱い、設定で切り替える。
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { modelsDir } from './home.ts';
import type { AasConfig } from '../config.ts';
import type { LocalRuntime } from '../runtime/local-runtime.ts';
import { LlamaCppRuntime } from '../runtime/llamacpp.ts';
import { InProcRuntime } from '../runtime/inproc.ts';
import { OllamaRuntime } from '../runtime/ollama.ts';
import { findInstalled } from '../runtime/llama-install.ts';
import type { MachineSpec } from '../runtime/spec.ts';

export interface RuntimeHooks {
  /** モデルを読むライブラリの差し替え。試験で使う（本物は数GBの GGUF が要る）。 */
  inprocLoad?: () => Promise<unknown>;
}

export async function buildRuntime(
  config: AasConfig,
  machine: MachineSpec,
  onLog?: (line: string) => void,
  hooks: RuntimeHooks = {},
): Promise<LocalRuntime> {
  const rc = config.runtime ?? {};

  // このプログラムの中で読む。**二つ目の実行ファイルを置けない機械**では
  // これだけが道になる。GGUF を置き場に入れておけば、それを読む。
  if (rc.kind === 'inproc') {
    return new InProcRuntime({
      modelsDir: rc.modelsDir ?? modelsDir(),
      // 設定の basePort を渡す。渡さないと、繋ぐ側（wireInProc）は basePort を
      // 向くのに、待つ側は既定の口に立ち、**永久に繋がらない**。
      ...(rc.basePort !== undefined ? { port: rc.basePort } : {}),
      ...(onLog ? { onLog } : {}),
      ...(hooks.inprocLoad ? { load: hooks.inprocLoad } : {}),
    });
  }

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
