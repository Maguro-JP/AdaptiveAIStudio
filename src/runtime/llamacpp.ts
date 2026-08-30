/**
 * llama.cpp を直接制御するランタイム（S1）。
 *
 * Ollama はオフロード層数を自動で決め、こちらから指定できない。
 * 「載らないモデルを遅くても動かす」にはプランナの計算値を
 * そのまま渡す必要があるため、llama-server を自分で起動する。
 *
 * llama-server は OpenAI互換APIを出すので、Provider層に変更は要らない。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { runtimeEnv } from './llama-env.ts';
import { readdir, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { planExecution, type Plan } from './planner.ts';
import { inferSpec } from './infer.ts';
import { lookupModel } from './catalog.ts';
import { readGguf } from './gguf.ts';
import { toModelSpec } from './gguf-spec.ts';
import type { MachineSpec, ModelSpec } from './spec.ts';
import type { AvailableModel, LoadedModel, LocalRuntime } from './local-runtime.ts';

export interface LlamaCppOptions {
  /** llama-server の実行パス */
  command?: string;
  /**
   * command の直後に付ける固定引数。
   * ラッパースクリプト経由の起動や、環境固有のオプションを差し込むのに使う。
   */
  commandArgs?: string[];
  /** GGUFファイルを置くディレクトリ */
  modelsDir: string;
  machine: MachineSpec;
  /** 使用するポートの開始番号。順に空きを探す。 */
  basePort?: number;
  /** 起動〜応答可能までの上限。巨大モデルは数分かかる。 */
  startupTimeoutMs?: number;
  desiredContext?: number;
  /** レーンの並列度。llama-server の --parallel に渡る。 */
  parallel?: number;
  onLog?: (line: string) => void;
}

interface Running {
  ref: string;
  child: ChildProcess;
  baseUrl: string;
  port: number;
  plan: Plan;
  loadSeconds: number;
}

export class LlamaCppRuntime implements LocalRuntime {
  readonly id = 'llamacpp';
  readonly #opts: Required<Omit<LlamaCppOptions, 'onLog' | 'machine' | 'modelsDir'>> &
    Pick<LlamaCppOptions, 'onLog'> & { machine: MachineSpec; modelsDir: string };
  readonly #running = new Map<string, Running>();
  /**
   * ファイルから読み取った諸元。
   * 名前からの推測より、書いてあるものの方が確か。
   */
  readonly #specs = new Map<string, ModelSpec>();
  #nextPort: number;

  constructor(opts: LlamaCppOptions) {
    this.#opts = {
      command: opts.command ?? 'llama-server',
      commandArgs: opts.commandArgs ?? [],
      modelsDir: opts.modelsDir,
      machine: opts.machine,
      basePort: opts.basePort ?? 18080,
      startupTimeoutMs: opts.startupTimeoutMs ?? 600_000,
      desiredContext: opts.desiredContext ?? 8192,
      parallel: opts.parallel ?? 1,
      onLog: opts.onLog,
    };
    this.#nextPort = this.#opts.basePort;
  }

  async list(): Promise<AvailableModel[]> {
    let entries: string[];
    try {
      entries = await readdir(this.#opts.modelsDir);
    } catch {
      return []; // ディレクトリが無いのは異常ではない
    }
    const out: AvailableModel[] = [];
    for (const name of entries) {
      if (!name.toLowerCase().endsWith('.gguf')) continue;
      let sizeBytes: number | undefined;
      try {
        sizeBytes = (await stat(join(this.#opts.modelsDir, name))).size;
      } catch { /* 読めなくても一覧には出す */ }
      // ファイルの先頭を読んで、書いてある諸元を取る。
      // 読めなくても一覧からは落とさない。動かせるかどうかは別の話。
      await this.#readSpec(name);
      out.push({ ref: name, sizeBytes });
    }
    return out;
  }

  /**
   * GGUF から諸元を読む。
   * 読めない・足りないときは覚えない。半端な値を残すより、
   * 名前からの推測に落ちた方がまだ筋が通る。
   */
  async #readSpec(name: string): Promise<ModelSpec | undefined> {
    const cached = this.#specs.get(name);
    if (cached) return cached;
    try {
      const file = await readGguf(join(this.#opts.modelsDir, name));
      const { spec, missing } = toModelSpec(file, basename(name, '.gguf'));
      if (!spec) {
        this.#opts.onLog?.(`${name}: 諸元を読み切れませんでした（${missing.join(' / ')}）。名前からの推測に落ちます。`);
        return undefined;
      }
      this.#specs.set(name, spec);
      return spec;
    } catch (e) {
      this.#opts.onLog?.(`${name}: GGUF を読めませんでした（${(e as Error).message}）。名前からの推測に落ちます。`);
      return undefined;
    }
  }

  /** 読み取れている諸元。一覧を取ったあとに埋まる。 */
  specFor(ref: string): ModelSpec | undefined {
    return this.#specs.get(ref);
  }

  loaded(): string[] {
    return [...this.#running.keys()];
  }

  /** プランナが計算した実行設定。起動前に利用者へ見せるためにも使う。 */
  planFor(ref: string): Plan | undefined {
    // 書いてあるもの > 登録済みの諸元 > 名前からの推測、の順で信じる。
    const name = basename(ref, '.gguf');
    const spec = this.#specs.get(ref) ?? lookupModel(name) ?? inferSpec(name);
    if (!spec) return undefined;
    return planExecution({
      model: spec,
      machine: this.#opts.machine,
      desiredContext: this.#opts.desiredContext,
    });
  }

  async ensureLoaded(ref: string, signal?: AbortSignal): Promise<LoadedModel> {
    const already = this.#running.get(ref);
    if (already) {
      return {
        baseUrl: already.baseUrl, model: ref,
        plan: already.plan, loadSeconds: already.loadSeconds,
      };
    }

    const plan = this.planFor(ref);
    if (!plan) throw new Error(`モデルの規模を判定できません: ${ref}`);

    const port = this.#nextPort++;
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    const args = this.#buildArgs(ref, plan, port);

    this.#opts.onLog?.(`起動: ${this.#opts.command} ${args.join(' ')}`);
    const startedAt = Date.now();

    // 共有ライブラリは実行ファイルの隣にある。探す場所を明示しないと、
    // 置いてあるのに「見つからない」で落ちる。
    const child = spawn(this.#opts.command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: runtimeEnv(this.#opts.command),
    });
    let exited: { code: number | null; detail: string } | undefined;
    let stderrTail = '';

    const capture = (b: Buffer) => {
      const text = b.toString();
      stderrTail = (stderrTail + text).slice(-4000);
      for (const line of text.split('\n')) if (line.trim()) this.#opts.onLog?.(line.trim());
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    child.on('error', (e) => { exited = { code: null, detail: e.message }; });
    child.on('exit', (code) => {
      if (!exited) exited = { code, detail: stderrTail.split('\n').slice(-5).join('\n') };
      this.#running.delete(ref);
    });

    try {
      await this.#waitReady(baseUrl, () => exited, signal);
    } catch (e) {
      child.kill();
      throw e;
    }

    const loadSeconds = Math.round(((Date.now() - startedAt) / 1000) * 10) / 10;
    this.#running.set(ref, { ref, child, baseUrl, port, plan, loadSeconds });
    this.#opts.onLog?.(`起動完了: ${ref} (${loadSeconds}秒)`);

    return { baseUrl, model: ref, plan, loadSeconds };
  }

  /** プランナの計算値をそのまま llama-server の引数に落とす。 */
  #buildArgs(ref: string, plan: Plan, port: number): string[] {
    const args = [
      ...this.#opts.commandArgs,
      '--model', join(this.#opts.modelsDir, ref),
      '--port', String(port),
      '--host', '127.0.0.1',
      '--n-gpu-layers', String(plan.gpuLayers),
      '--ctx-size', String(plan.contextLength * this.#opts.parallel),
      '--parallel', String(this.#opts.parallel),
    ];
    if (plan.kvCacheType !== 'f16') {
      args.push('--cache-type-k', plan.kvCacheType, '--cache-type-v', plan.kvCacheType);
    }
    if (plan.useMmap) args.push('--mmap');
    return args;
  }

  /**
   * 応答可能になるまで待つ。
   * 巨大モデルのロードは数分かかるので長く待つが、
   * プロセスが死んだ場合は待たずに即座に失敗させる。
   */
  async #waitReady(
    baseUrl: string,
    exitedRef: () => { code: number | null; detail: string } | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + this.#opts.startupTimeoutMs;
    for (;;) {
      const exited = exitedRef();
      if (exited) {
        throw new Error(
          `llama-server が起動に失敗しました (終了コード ${exited.code ?? '不明'})\n${exited.detail}`,
        );
      }
      if (signal?.aborted) throw new Error('起動が中断されました。');
      if (Date.now() > deadline) {
        throw new Error(`llama-server が ${this.#opts.startupTimeoutMs / 1000}秒 以内に応答しませんでした。`);
      }

      try {
        const res = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) return;
      } catch { /* まだ起動中 */ }

      await new Promise((r) => setTimeout(r, 250));
    }
  }

  async unload(ref: string): Promise<void> {
    const running = this.#running.get(ref);
    if (!running) return;
    this.#running.delete(ref);
    running.child.kill();
    // プロセスが消えるまで待つ。待たずに次を起動するとVRAMが足りなくなる。
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { running.child.kill('SIGKILL'); resolve(); }, 5000);
      running.child.once('exit', () => { clearTimeout(timer); resolve(); });
      if (running.child.exitCode !== null) { clearTimeout(timer); resolve(); }
    });
    this.#opts.onLog?.(`解放: ${ref}`);
  }

  async shutdown(): Promise<void> {
    await Promise.all(this.loaded().map((ref) => this.unload(ref)));
  }
}
