/**
 * ランタイムの組み立て。
 * ollama と llamacpp を同じ LocalRuntime として扱い、設定で切り替える。
 */
import { join } from 'node:path';
import { modelsDir } from './home.ts';
import type { AasConfig } from '../config.ts';
import type { LocalRuntime } from '../runtime/local-runtime.ts';
import { LlamaCppRuntime } from '../runtime/llamacpp.ts';
import { InProcRuntime } from '../runtime/inproc.ts';
import { InProcHost } from '../runtime/inproc-host-client.ts';
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
  // **既定は「この中で読む」。**書いていなければ inproc。Ollama や llama.cpp は
  // 速さを取りたい人が自分で選ぶもの（別のものを入れる手間と引き換え）。
  const kind = rc.kind ?? 'inproc';

  // このプログラムの中で読む。**二つ目の実行ファイルを置けない機械**では
  // これだけが道になる。GGUF を置き場に入れておけば、それを読む。
  if (kind === 'inproc') {
    /*
     * **モデルは別のプロセスで動かす。**
     *
     * 同じプロセスで回すと、CPU で数GBを読んでいる間、画面の口まで固まる
     * （打っても返らず、フリーズにしか見えない。実機でそうなった）。
     * 裏でやることは裏でやる。試験で偽のライブラリを渡すときだけ、
     * 同じプロセスで読む（子に偽物を渡す道は別にある）。
     */
    if (!hooks.inprocLoad) {
      return new InProcHost({
        modelsDir: rc.modelsDir ?? modelsDir(),
        ...(rc.basePort !== undefined ? { port: rc.basePort } : {}),
        ...(onLog ? { onLog } : {}),
      });
    }
    return new InProcRuntime({
      modelsDir: rc.modelsDir ?? modelsDir(),
      // 設定の basePort を渡す。渡さないと、繋ぐ側（wireInProc）は basePort を
      // 向くのに、待つ側は既定の口に立ち、**永久に繋がらない**。
      ...(rc.basePort !== undefined ? { port: rc.basePort } : {}),
      ...(rc.contextSize !== undefined ? { contextSize: rc.contextSize } : {}),
      ...(rc.parallel !== undefined ? { sequences: rc.parallel } : {}),
      ...(rc.gpu !== undefined ? { gpu: rc.gpu } : {}),
      gpuSeen: machine.vramBytes > 0,
      ...(onLog ? { onLog } : {}),
      ...(hooks.inprocLoad ? { load: hooks.inprocLoad } : {}),
    });
  }

  if (kind !== 'llamacpp') {
    const ollama = config.providers.find((p) => p.kind === 'openai-compatible' && p.locality === 'local');
    return new OllamaRuntime({ baseUrl: ollama?.baseUrl });
  }

  // 設定に書かれていなければ、自前で用意したものを使う。
  // 「PATH にある誰かが入れたもの」に頼ると、それを消された時点で動かなくなる。
  const command = rc.command ?? await findInstalled() ?? 'llama-server';

  return new LlamaCppRuntime({
    command,
    commandArgs: rc.commandArgs,
    // inproc・--get・設定画面・doctor と同じ置き場を見る。ここだけ ~/.aas/models を
    // 見ていて、AAS_HOME が別の場所だと「取ってきたのに見つからない」になっていた。
    modelsDir: rc.modelsDir ?? modelsDir(),
    machine,
    basePort: rc.basePort,
    parallel: rc.parallel,
    desiredContext: rc.desiredContext,
    onLog,
  });
}
