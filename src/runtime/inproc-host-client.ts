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
import { listGguf, INPROC_PORT } from './inproc.ts';

export interface InProcHostOptions {
  modelsDir: string;
  port?: number;
  contextSize?: number;
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
  if (opts.lib) args.push('--lib', opts.lib);
  return args;
}

export class InProcHost implements LocalRuntime {
  readonly id = 'inproc';
  readonly #opts: InProcHostOptions;
  #child?: ChildProcess;
  #url?: Promise<string>;
  #loaded: string[] = [];
  #windows = new Map<string, number>();

  constructor(opts: InProcHostOptions) { this.#opts = opts; }

  /** 子を起こして、口が開くまで待つ。二度は起こさない。 */
  #up(): Promise<string> {
    if (this.#url) return this.#url;
    this.#url = new Promise<string>((ok, ng) => {
      const child = spawn(process.execPath, hostArgs(this.#opts), { stdio: ['pipe', 'pipe', 'pipe'] });
      this.#child = child;
      const wait = setTimeout(() => ng(new Error('モデルのプロセスが立ち上がりません（上限で諦めました）')), this.#opts.startWaitMs ?? 30_000);
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
      child.on('exit', (code) => {
        clearTimeout(wait);
        this.#child = undefined;
        this.#url = undefined;
        this.#loaded = [];
        if (!got) ng(new Error(`モデルのプロセスが ${code} で終わりました:\n${err.trim() || '（何も言っていません）'}`));
        else this.#opts.onLog?.(`モデルのプロセスが終わりました（${code}）${err.trim() ? `:\n${err.trim()}` : ''}`);
      });
      child.on('error', (e) => { clearTimeout(wait); ng(e); });
    });
    return this.#url;
  }

  async #call<T>(op: string, body?: unknown): Promise<T> {
    const base = await this.#up();
    const r = await fetch(`${base}/control/${op}`, body === undefined
      ? { method: 'GET' }
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
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
    await this.#call('shutdown', {}).catch(() => undefined);
    const wait = new Promise<'late'>((ok) => setTimeout(() => ok('late'), 5000).unref?.());
    if (await Promise.race([gone.then(() => 'gone' as const), wait]) === 'late') child.kill('SIGKILL');
    this.#child = undefined;
    this.#url = undefined;
    this.#loaded = [];
  }
}
