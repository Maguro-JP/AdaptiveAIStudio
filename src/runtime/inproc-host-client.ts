/**
 * 別のプロセスで動くモデル（inproc-host）への、こちら側の手。
 *
 * LocalRuntime の形はそのまま。中身は HTTP で子に頼むだけ。
 * 画面のプロセスは、これ越しにしかモデルに触らないので、CPU で数GBを
 * 回していても画面の口は空いている。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { AvailableModel, LoadedModel, LocalRuntime } from './local-runtime.ts';
import { listGguf, INPROC_PORT, type Backend, type GpuMode } from './inproc.ts';

export interface InProcHostOptions {
  modelsDir: string;
  port?: number;
  contextSize?: number;
  /** 並列に持つ sequence の本数（会話ごとに一本）。子へそのまま渡す。 */
  sequences?: number;
  /** GPU を使うか。子へそのまま渡す。既定 auto。 */
  gpu?: GpuMode;
  /** nvidia-smi に GPU が見えているか。子へそのまま渡す。 */
  gpuSeen?: boolean;
  onLog?: (line: string) => void;
  /** 試験用。子に読ませる偽のライブラリ（モジュールの道）。 */
  lib?: string;
  /** 子の入口。既定は隣の inproc-host.ts。 */
  entry?: string;
  /** 立ち上がるまで待つ上限。 */
  startWaitMs?: number;
}

/**
 * 子に渡す引数。
 *
 * 口（port）を渡されなければ **既定の口（INPROC_PORT）に立てる。**同じプロセスで
 * 読んでいたときと同じ。ここを 0（空いている口）にしていたので、繋ぐ側
 * （設定の baseUrl は既定の口を向く）と待つ側が別の口になり、配った形で
 * 送った最初の一言が「inproc への接続に失敗しました」で落ちた（check:bundle で
 * 見つけた）。
 */
export function hostArgs(opts: InProcHostOptions): string[] {
  const entry = opts.entry ?? fileURLToPath(new URL('./inproc-host.ts', import.meta.url));
  const args = ['--experimental-strip-types', '--no-warnings', entry, '--models-dir', opts.modelsDir,
    '--port', String(opts.port ?? INPROC_PORT)];
  if (opts.contextSize !== undefined) args.push('--context-size', String(opts.contextSize));
  if (opts.sequences !== undefined) args.push('--sequences', String(opts.sequences));
  if (opts.gpu !== undefined) args.push('--gpu', opts.gpu);
  if (opts.gpuSeen !== undefined) args.push('--gpu-seen', opts.gpuSeen ? '1' : '0');
  if (opts.lib) args.push('--lib', opts.lib);
  return args;
}

/**
 * 子の終わり方を、人の言葉に直す。
 *
 * 「落ちました（3221225477）」では、次に何をすればいいか分からない。
 * 数GBを CPU で回している途中に消える原因は、ほとんど記憶が尽きたこと。
 * linux では SIGKILL（OOM killer）、Windows では中で確保に失敗して abort（3）か
 * 0xC0000409（STATUS_STACK_BUFFER_OVERRUN、実際は fail-fast）や
 * 0xC0000005（アクセス違反）で消える。当てずっぽうで断定はしない。「多い」と言う。
 */
export function explainExit(code: number | null, signal: string | null): string {
  const how = signal ?? code ?? '理由不明';
  const oom = signal === 'SIGKILL' || code === 137 || code === 3 || code === 0xC0000409 || code === -1073740791;
  if (oom) return `${how}。記憶が尽きて止められた形が多いです。小さいモデルか、狭いコンテキストウィンドウ（contextSize）にしてください`;
  if (code === 0xC0000005 || code === -1073741819 || signal === 'SIGSEGV') {
    return `${how}。読む側（node-llama-cpp）が落ちました。モデルのファイルが途中までしか無いか、この機械の CPU に合わない版のことがあります`;
  }
  return String(how);
}

/** 止めるよう頼んで返事を待つ上限。これを過ぎたら頼んだことにして、あとは出て行くのを待ち、出なければ殺す。 */
export const SHUTDOWN_ASK_MS = 2_000;

export class InProcHost implements LocalRuntime {
  readonly id = 'inproc';
  readonly #opts: InProcHostOptions;
  #child?: ChildProcess;
  #url?: Promise<string>;
  #loaded: string[] = [];
  #windows = new Map<string, number>();
  /** こちらから止めている最中。そのときの終わりは「落ちた」ではない。 */
  #stopping = false;

  constructor(opts: InProcHostOptions) { this.#opts = opts; }

  /** 子を起こして、口が開くまで待つ。二度は起こさない。 */
  #up(): Promise<string> {
    if (this.#url) return this.#url;
    this.#url = new Promise<string>((ok, ng) => {
      const child = spawn(process.execPath, hostArgs(this.#opts), { stdio: ['pipe', 'pipe', 'pipe'] });
      this.#child = child;
      // 新しい子。前の止めは、この子には関係ない。
      this.#stopping = false;
      /*
       * **諦めたら、子も落として忘れる。**断るだけだと、断った約束（#url）と動いている子が残り、
       * 以後の読み込みは子が自分で終わるまで（終わらない）全部「立ち上がりません」で即座に落ちる。
       */
      const wait = setTimeout(() => {
        this.#stopping = true; // こちらから止める。「落ちた」とは言わない
        child.kill('SIGKILL');
        if (this.#child === child) { this.#child = undefined; this.#url = undefined; }
        ng(new Error('モデルのプロセスが立ち上がりません（上限で諦めました）'));
      }, this.#opts.startWaitMs ?? 30_000);
      let buf = '';
      let got = false;
      child.stdout?.on('data', (b: Buffer) => {
        buf += b.toString('utf8');
        let at: number;
        while ((at = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, at); buf = buf.slice(at + 1);
          let msg: { url?: string; log?: string } = {};
          try { msg = JSON.parse(line) as typeof msg; } catch { this.#opts.onLog?.(line); continue; }
          if (msg.url && !got) { got = true; clearTimeout(wait); ok(msg.url.replace(/\/v1$/, '')); }
          if (msg.log) this.#opts.onLog?.(msg.log);
        }
      });
      let err = '';
      child.stderr?.on('data', (b: Buffer) => { err += b.toString('utf8'); if (err.length > 4000) err = err.slice(-4000); });
      child.on('exit', (code, signal) => {
        clearTimeout(wait);
        // 諦めて落とした古い子の終わりが、後から起こした子の記録を消さないように
        if (this.#child !== undefined && this.#child !== child) return;
        this.#child = undefined;
        this.#url = undefined;
        this.#loaded = [];
        if (!got) { ng(new Error(`モデルのプロセスが ${code} で終わりました:\n${err.trim() || '（何も言っていません）'}`)); return; }
        /*
         * **落ちたことを、落ちたと言う。**
         *
         * ここは「終わりました（null）」としか言っていなかった。数GBを CPU で
         * 回している途中に記憶が尽きて子が消えると、画面には「ストリームが
         * 中断されました」だけが出て、何が起きたか分からない。
         * 読み込んだものは消えているが、**次の送信で読み直す**（`loaded()` が
         * 空なので、送る手前で読みに行く）。それも言う。
         * こちらから止めたときは、落ちたのではない。黙る。
         */
        if (this.#stopping) return;
        this.#opts.onLog?.(`モデルのプロセスが落ちました（${explainExit(code, signal)}）。次の送信で読み直します${err.trim() ? `:\n${err.trim()}` : ''}`);
      });
      child.on('error', (e) => { clearTimeout(wait); ng(e); });
    });
    return this.#url;
  }

  async #call<T>(op: string, body?: unknown, timeoutMs?: number): Promise<T> {
    const base = await this.#up();
    const signal = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
    const r = await fetch(`${base}/control/${op}`, body === undefined
      ? { method: 'GET', ...(signal ? { signal } : {}) }
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...(signal ? { signal } : {}) });
    const j = await r.json() as T & { error?: string };
    if (!r.ok) throw new Error(j.error ?? `${op} が ${r.status} で終わりました`);
    return j;
  }

  /** 子の PID。試験で、本当に別のプロセスか・止まったかを見る。 */
  pid(): number | undefined { return this.#child?.pid; }

  /**
   * 一覧は、子を起こさずにこちらで見る。
   *
   * フォルダの .gguf を数えるだけに、プロセスを一つ起こす理由は無い。
   * 設定の頁を開いただけで子が立つと、開くたびに待たされる。
   * 子を起こすのは、読む・降ろす・止めるのときだけ。
   */
  list(): Promise<AvailableModel[]> { return listGguf(this.#opts.modelsDir); }
  loaded(): string[] { return this.#loaded; }
  windowOf(ref: string): number | undefined { return this.#windows.get(ref); }
  wrappers(): Promise<{ ref: string; wrapper: string; guessed: boolean }[]> { return this.#call('wrappers'); }
  /**
   * 読む側が実際に使う backend。子を起こす（ライブラリを起こすだけで、モデルは読まない）。
   * 一覧と違い、ここは起こしてよい。読む前に選ぶ側が見るもので、起動時の読み込みが
   * どのみち子を起こす。
   */
  backend(): Promise<Backend> { return this.#call('backend'); }

  async ensureLoaded(ref: string): Promise<LoadedModel> {
    const got = await this.#call<LoadedModel & { window?: number | null }>('load', { ref });
    if (!this.#loaded.includes(ref)) this.#loaded.push(ref);
    if (typeof got.window === 'number') this.#windows.set(ref, got.window);
    const { window: _w, ...rest } = got;
    return rest;
  }

  async unload(ref: string): Promise<void> {
    await this.#call('unload', { ref });
    this.#loaded = this.#loaded.filter((r) => r !== ref);
  }

  /** 止める。返事が無ければ殺す。親無しで残さない。 */
  async shutdown(): Promise<void> {
    const child = this.#child;
    if (!child) return;
    const gone = new Promise<void>((ok) => child.once('exit', () => ok()));
    this.#stopping = true;
    // 頼むのは短く待つだけ（子の手が塞がって返事をしないと、殺すまでの 5 秒の前に何分も待っていた）
    await this.#call('shutdown', {}, SHUTDOWN_ASK_MS).catch(() => undefined);
    const wait = new Promise<'late'>((ok) => setTimeout(() => ok('late'), 5000).unref?.());
    if (await Promise.race([gone.then(() => 'gone' as const), wait]) === 'late') child.kill('SIGKILL');
    this.#child = undefined;
    this.#url = undefined;
    this.#loaded = [];
    // #stopping はここで戻さない。返事が無くて殺したとき、exit はこの後に来る。
    // 戻してしまうと、自分で殺したものを「落ちた」と言う。次に起こすときに戻す。
  }
}
