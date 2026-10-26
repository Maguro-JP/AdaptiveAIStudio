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
import { describeFailure } from './llama-diagnosis.ts';
import { readdir, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { planExecution, type Plan } from './planner.ts';
import { inferSpec } from './infer.ts';
import { lookupModel } from './catalog.ts';
import { readGguf } from './gguf.ts';
import { toModelSpec } from './gguf-spec.ts';
import type { MachineSpec, ModelSpec } from './spec.ts';
import type { AvailableModel, LoadedModel, LocalRuntime } from './local-runtime.ts';
import { lineReader } from '../core/text.ts';
import { alsoModelDirs, modelPath } from '../core/home.ts';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

/**
 * llama-server を付き添い越しに起こすか（Windows 以外）。
 *
 * Windows でも付き添いを通し、止めるのを taskkill /T に頼る形を試したが戻した。taskkill が使えない・失敗したときに
 * llama-server が親無しで残り、しかも止まったものとして次のモデルを起こす。付き添いを挟まなければ、`child.kill()` が
 * llama-server そのものを TerminateProcess するので、外のツールに頼らず確実に止まる。代わりに、コンソールの Ctrl-C が
 * llama-server にも届く・親が後始末をせずに消えると残る、の二つは Windows で残る（実機で確かめられる形ができてから直す）
 */
const GUARDED = process.platform !== 'win32';
const GUARD = fileURLToPath(new URL('./llama-guard.ts', import.meta.url));

/**
 * 止める。付き添い越しなら、付き添いのグループごと落とす（付き添いだけ落とすと、llama-server が親無しで残る）。
 * 付き添いを挟まない Windows では、子が llama-server そのものなので `child.kill()` で落ちる。
 */
function killTree(child: ChildProcess, signal: 'SIGTERM' | 'SIGKILL'): void {
  // 既に終わった子には何もしない（その番号が別のプロセスに振り直されていれば、無関係なものを落とす）
  if (child.exitCode !== null || child.signalCode !== null) return;
  // 付き添いを挟まない（Windows）なら、子は llama-server そのもの
  if (!GUARDED || child.pid === undefined) { child.kill(signal); return; }
  if (signal === 'SIGTERM') { child.kill('SIGTERM'); return; } // 付き添いが llama-server へ渡し、5 秒で落とす
  try { process.kill(-child.pid, 'SIGKILL'); return; } catch { /* 既に居ない */ }
  child.kill('SIGKILL');
}

/** その口が空いているか（127.0.0.1 で開けてみて、閉じる）。 */
function portFree(port: number): Promise<boolean> {
  return new Promise((ok) => {
    const s = createServer();
    s.once('error', () => ok(false));
    s.listen(port, '127.0.0.1', () => { s.close(() => ok(true)); });
  });
}

/** 起こしている最中のモデル。待っている人の数と、中断の無い待ち手が居るかを持つ。 */
interface Loading {
  promise: Promise<LoadedModel>;
  controller: AbortController;
  /** 中断を持って待っている人の数 */
  waiting: number;
  /** 中断の無い待ち手が居る */
  silent: boolean;
}

/** 埋まっている口を飛ばして試す数。 */
const PORT_TRIES = 20;
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
  /** 起こしたが、まだ答えられるようになっていないもの。止めるときに、これも落とす。 */
  readonly #starting = new Set<ChildProcess>();
  /**
   * 起こしている最中のモデル。同じモデルを二本同時に起こすと、後の記録が前を上書きし、前の子は止める対象から外れて
   * 残った（VRAM を二重に使い、Windows では残り続ける）。起こしている最中なら、その起動を待って同じものを返す。
   */
  readonly #loading = new Map<string, Loading>();
  /** 止めた回数。起こす手前で変わっていたら起こさない（口を探している間に止められると、止めた後に子が起きて残った）。 */
  #stops = 0;
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
    // ディレクトリが無いのは異常ではない。共有の保存先なら、前の保存先に残ったものも出す（同じ名前は渡された保存先の方）
    const entries = new Set<string>();
    for (const from of [this.#opts.modelsDir, ...alsoModelDirs(this.#opts.modelsDir)]) {
      for (const n of await readdir(from).catch(() => [] as string[])) entries.add(n);
    }
    const out: AvailableModel[] = [];
    for (const name of entries) {
      if (!name.toLowerCase().endsWith('.gguf')) continue;
      let sizeBytes: number | undefined;
      try {
        sizeBytes = (await stat(modelPath(this.#opts.modelsDir, name))).size;
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
      const file = await readGguf(modelPath(this.#opts.modelsDir, name));
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
      // `--ctx-size` は会話の数ぶん確保するので、KVもその数ぶんで見積もる
      sequences: this.#opts.parallel,
      // 読むのはファイルそのもの。量子化を下げた計画にしても、下げたファイルは無い
      allowQuantDowngrade: false,
    });
  }

  /**
   * 起こす。同じモデルを起こしている最中なら、その起動を待つ。
   *
   * 中断は頼んだ人ごとに効く。自分の ■ で自分の待ちはすぐやめるが、起動そのものを止めるのは、待っている全員が
   * やめたときだけ（中断の無い待ち手が居れば止めない）。最初の人の中断をそのまま起動に渡すと、後から来た人の ■ が効かず、
   * 逆の順では、ほかの人の起動まで落としていた。
   */
  ensureLoaded(ref: string, signal?: AbortSignal): Promise<LoadedModel> {
    if (signal?.aborted) return Promise.reject(new Error('起動が中断されました。'));
    let entry = this.#loading.get(ref);
    if (!entry) {
      const controller = new AbortController();
      const created: Loading = {
        controller, waiting: 0, silent: false,
        promise: this.#load(ref, controller.signal).finally(() => {
          if (this.#loading.get(ref) === created) this.#loading.delete(ref);
        }),
      };
      entry = created;
      this.#loading.set(ref, entry);
    }
    const shared = entry;
    // 中断の無い待ち手（事前読み込み）が一人でも居れば、ほかの全員がやめても起動は続ける
    if (!signal) { shared.silent = true; return shared.promise; }
    shared.waiting += 1;
    return new Promise<LoadedModel>((resolve, reject) => {
      const onAbort = () => {
        shared.waiting -= 1;
        if (shared.waiting === 0 && !shared.silent) {
          shared.controller.abort();
          // 止める途中の起動に、後から来た人を相乗りさせない（止めていない人まで「中断されました」で落ちていた）。後の人は起こし直す
          if (this.#loading.get(ref) === shared) this.#loading.delete(ref);
        }
        reject(new Error('起動が中断されました。'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      shared.promise.then(
        (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
        (e: unknown) => { signal.removeEventListener('abort', onAbort); reject(e); },
      );
    });
  }

  async #load(ref: string, signal?: AbortSignal): Promise<LoadedModel> {
    const already = this.#running.get(ref);
    if (already) {
      return {
        baseUrl: already.baseUrl, model: ref,
        plan: already.plan, loadSeconds: already.loadSeconds,
      };
    }

    const plan = this.planFor(ref);
    if (!plan) throw new Error(`モデルの規模を判定できません: ${ref}`);

    /*
     * **埋まっている口に起こさない。**埋まっていると、起こした llama-server は口を取れずに落ちるが、
     * 下の待ちは**先に居る誰か**（前に残った llama-server、もう一つの AAS）の返事を「準備できた」と読む。
     * 違うモデルが答え、しかもそれは止める対象に入らない。
     * 埋まっていたら次の番号を試す（前は投げていたので、前の llama-server が 18080 を握ったままだと、起動のたびに落ちた）。
     * 空いている口を選ぶので、違うモデルが答える心配は無い。
     */
    const stops = this.#stops;
    const first = this.#nextPort;
    let port = this.#nextPort++;
    while (!(await portFree(port))) {
      if (port - first >= PORT_TRIES - 1) {
        throw new Error(`口 ${first}〜${port} はどれも使われています。前の llama-server が残っているか、別のプログラムが使っています。`
          + 'タスク マネージャーで llama-server を終わらせるか、設定の runtime.basePort を変えてください。');
      }
      port = this.#nextPort++;
    }
    // 口を探している間に止められたら起こさない（起こすと、止めた後に llama-server が残る）
    if (this.#stops !== stops || signal?.aborted) throw new Error('起動が中断されました。');
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    const args = this.#buildArgs(ref, plan, port);

    this.#opts.onLog?.(`起動: ${this.#opts.command} ${args.join(' ')}`);
    const startedAt = Date.now();

    // 共有ライブラリは実行ファイルの隣にある。探す場所を明示しないと、
    // 置いてあるのに「見つからない」で落ちる。
    //
    // Windows 以外は付き添い（`llama-guard.ts`）を挟み、別のプロセスグループで起こす。端末の Ctrl-C（生成だけを止める合図）で
    // llama-server まで落ちない。親が居なくなったら付き添いが止める（標準入力を開けたままにしておくのは、そのため）。
    // Windows のコンソールの Ctrl-C は別の仕組みで届くので、ここでは変えない（確かめていない）
    const child = GUARDED
      ? spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', GUARD, this.#opts.command, ...args], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: runtimeEnv(this.#opts.command),
        detached: true,
      })
      : spawn(this.#opts.command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: runtimeEnv(this.#opts.command),
      });
    this.#starting.add(child);
    let exited: { code: number | null; detail: string } | undefined;
    let stderrTail = '';

    // 塊の切れ目は、文字の切れ目でも行の切れ目でもない。
    // そのまま split すると、一行が二行に割れて流れに出る。
    const capture = (lines: ReturnType<typeof lineReader>) => (b: Buffer) => {
      for (const line of lines.push(b)) {
        stderrTail = (stderrTail + line + '\n').slice(-4000);
        if (line.trim()) this.#opts.onLog?.(line.trim());
      }
    };
    child.stdout?.on('data', capture(lineReader()));
    child.stderr?.on('data', capture(lineReader()));
    child.on('error', (e) => { exited = { code: null, detail: e.message }; });
    // 末尾5行では足りない。llama.cpp は原因が何であれ最後は
    // 「failed to load model」で終わり、**決め手はその手前にある**。
    // 実測では、ファイルが無い/GGUF でない を分ける行が6行目より前だった。
    const settle = (code: number | null): void => {
      if (!exited) exited = { code, detail: stderrTail.split('\n').slice(-20).join('\n') };
    };
    child.on('exit', (code) => {
      this.#starting.delete(child);
      // **自分の記録だけを消す。**止めるのに 5 秒以上かかった古い子の終わりが、読み直した新しい子の記録を消していた
      if (this.#running.get(ref)?.child === child) this.#running.delete(ref);
      // 出力は 'exit' の後に届くことがある（付き添いが書いた「起こせなかった理由」など）。管が閉じるのを待って見立てる。
      // 閉じなければ（付き添いだけが落ち、llama-server が管を握ったまま）、少し待って今ある分で見立てる
      setTimeout(() => settle(code), 1000).unref?.();
    });
    child.on('close', (code) => settle(code));

    try {
      await this.#waitReady(baseUrl, () => exited, signal);
    } catch (e) {
      this.#starting.delete(child);
      killTree(child, 'SIGTERM');
      throw e;
    }
    this.#starting.delete(child);

    const loadSeconds = Math.round(((Date.now() - startedAt) / 1000) * 10) / 10;
    this.#running.set(ref, { ref, child, baseUrl, port, plan, loadSeconds });
    this.#opts.onLog?.(`起動完了: ${ref} (${loadSeconds}秒)`);

    return { baseUrl, model: ref, plan, loadSeconds };
  }

  /** プランナの計算値をそのまま llama-server の引数に落とす。 */
  #buildArgs(ref: string, plan: Plan, port: number): string[] {
    const args = [
      ...this.#opts.commandArgs,
      '--model', modelPath(this.#opts.modelsDir, ref),
      '--port', String(port),
      '--host', '127.0.0.1',
      '--n-gpu-layers', String(plan.gpuLayers),
      '--ctx-size', String(plan.contextLength * this.#opts.parallel),
      '--parallel', String(this.#opts.parallel),
    ];
    // KV を下げるのは K だけ。V を下げると、flash attention を付けない限り context を作れずに落ちる版がある（固定の b4585 は既定で付けない）。
    // flash attention の付け方は版で違う（素の `-fa` と `--flash-attn on`）ので、付けずに済む K だけにする
    if (plan.kvCacheType !== 'f16') args.push('--cache-type-k', plan.kvCacheType);
    // mmap は llama-server の既定で有効。`--mmap` を知らない版（固定の b4585 は `--no-mmap` だけ）に渡すと、引数の誤りで起動ごと落ちていた。
    // 載せる計画（useMmap: true）は既定のままで叶うので、何も渡さない
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
        // 終了コードだけでは、人にできることが無い。見立てまで付ける。
        throw new Error(describeFailure(exited.code, exited.detail));
      }
      if (signal?.aborted) throw new Error('起動が中断されました。');
      if (Date.now() > deadline) {
        throw new Error(`llama-server が ${this.#opts.startupTimeoutMs / 1000}秒 以内に応答しませんでした。`);
      }

      try {
        // 準備は根の `/health` で見る（`/v1` の下には無い）。読み込み中は 503 で、読み終えて 200 になる。`/models` は新しい版では読み込み中も 200 を返し、
        // 読み終える前に「起動完了」と言って、最初の依頼を 503 で落としていた
        const res = await fetch(new URL('/health', baseUrl), { signal: AbortSignal.timeout(2000) });
        if (res.ok) return;
      } catch { /* まだ起動中 */ }

      await new Promise((r) => setTimeout(r, 250));
    }
  }

  async unload(ref: string): Promise<void> {
    const running = this.#running.get(ref);
    if (!running) return;
    this.#running.delete(ref);
    killTree(running.child, 'SIGTERM');
    // プロセスが消えるまで待つ。待たずに次を起動するとVRAMが足りなくなる。
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { killTree(running.child, 'SIGKILL'); resolve(); }, 5000);
      running.child.once('exit', () => { clearTimeout(timer); resolve(); });
      if (running.child.exitCode !== null) { clearTimeout(timer); resolve(); }
    });
    this.#opts.onLog?.(`解放: ${ref}`);
  }

  async shutdown(): Promise<void> {
    this.#stops += 1;
    // 読み込み中のもの（まだ #running に無い）も落とす。落とさないと、止めた後に llama-server が残る
    for (const child of this.#starting) killTree(child, 'SIGTERM');
    this.#starting.clear();
    await Promise.all(this.loaded().map((ref) => this.unload(ref)));
  }
}
