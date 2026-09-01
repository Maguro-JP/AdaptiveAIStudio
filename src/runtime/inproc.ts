/**
 * モデルをこのプログラムの中で動かす。
 *
 * これまでは llama-server を**別の実行ファイルとして起こして**いた。
 * 会社の PC では、そこで止まる。置けるのはアプリ自身の土台
 * （node.exe / node.bin）だけで、二つ目の実行ファイルは置けない。
 *
 * だから、起こすのをやめて **読む**。node-llama-cpp が持っているのは
 * `.dll` と `.node` で、`.exe` は一つも無い。増えるのはライブラリだけ。
 *
 * 上の層（Provider）は OpenAI 互換の口だけを見る作りなので、
 * その口を**自分の中に立てる**。外に出る口は増えない（127.0.0.1 のみ）。
 * こうすると、上の層を一行も変えずに済む。
 *
 * GGUF は同梱しない。数GBあり、数か月で新しいものが出る。
 * 置き場に置いてあるものを読むだけにする。
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AvailableModel, LoadedModel, LocalRuntime } from './local-runtime.ts';

export interface InProcOptions {
  /** GGUF の置き場 */
  modelsDir: string;
  /** 待つ口。0 なら空いているものを使う。 */
  port?: number;
  onLog?: (line: string) => void;
  /**
   * ライブラリの読み込み。試験では差し替える。
   * **本物を配布物として用意できない**ので、ここを開けておく。
   */
  load?: () => Promise<unknown>;
}

/** 置き場にある GGUF。名前は問わない。 */
export async function listGguf(dir: string): Promise<AvailableModel[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const out: AvailableModel[] = [];
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.gguf')) continue;
    const info = await stat(join(dir, name)).catch(() => undefined);
    out.push({ ref: name, ...(info ? { sizeBytes: info.size } : {}) });
  }
  return out.sort((a, b) => a.ref.localeCompare(b.ref));
}

export class InProcRuntime implements LocalRuntime {
  readonly id = 'inproc';
  readonly #opts: InProcOptions;
  #server?: Server;
  #url = '';
  /** 読み込んだもの。ref ごとに一つ。 */
  readonly #sessions = new Map<string, { context: unknown; session: unknown }>();

  constructor(opts: InProcOptions) {
    this.#opts = opts;
  }

  list(): Promise<AvailableModel[]> {
    return listGguf(this.#opts.modelsDir);
  }

  loaded(): string[] {
    return [...this.#sessions.keys()];
  }

  async ensureLoaded(ref: string): Promise<LoadedModel> {
    const began = Date.now();
    if (!this.#sessions.has(ref)) {
      const lib = await this.#lib();
      const llama = await lib.getLlama();
      const model = await llama.loadModel({ modelPath: join(this.#opts.modelsDir, ref) });
      const context = await model.createContext();
      const session = new lib.LlamaChatSession({ contextSequence: context.getSequence() });
      this.#sessions.set(ref, { context, session });
      this.#opts.onLog?.(`読み込みました: ${ref}`);
    }
    await this.#serve();
    return { baseUrl: this.#url, model: ref, loadSeconds: (Date.now() - began) / 1000 };
  }

  async unload(ref: string): Promise<void> {
    const held = this.#sessions.get(ref) as { context?: { dispose?: () => Promise<void> } } | undefined;
    await held?.context?.dispose?.().catch(() => { /* すでに解けている */ });
    this.#sessions.delete(ref);
  }

  async shutdown(): Promise<void> {
    for (const ref of this.loaded()) await this.unload(ref);
    this.#server?.close();
    this.#server = undefined;
    this.#url = '';
  }

  /** ライブラリ。無いときは、無いとだけ言う。黙って別のことをしない。 */
  async #lib(): Promise<{ getLlama: () => Promise<{ loadModel: (o: { modelPath: string }) => Promise<{ createContext: () => Promise<{ getSequence: () => unknown; dispose?: () => Promise<void> }> }> }>; LlamaChatSession: new (o: { contextSequence: unknown }) => unknown }> {
    const load = this.#opts.load ?? (() => import('node-llama-cpp'));
    try {
      return await load() as never;
    } catch (e) {
      throw new Error(
        'モデルを読むライブラリ（node-llama-cpp）がありません。'
        + `配布物には入っています。作業コピーで使うときは npm install してください。（${(e as Error).message}）`,
      );
    }
  }

  /** OpenAI 互換の口を、自分の中に立てる。外へは出さない。 */
  async #serve(): Promise<void> {
    if (this.#server) return;
    this.#server = createServer((req, res) => { void this.#handle(req, res); });
    await new Promise<void>((resolve) => {
      this.#server!.listen(this.#opts.port ?? 0, '127.0.0.1', resolve);
    });
    const addr = this.#server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    this.#url = `http://127.0.0.1:${port}/v1`;
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (!url.pathname.endsWith('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"そこはありません"}');
      return;
    }
    const raw = await new Promise<string>((resolve) => {
      let text = '';
      req.on('data', (c: Buffer) => { text += c.toString(); });
      req.on('end', () => resolve(text));
    });
    let body: { model?: string; messages?: { role: string; content: string }[] };
    try {
      body = JSON.parse(raw || '{}') as typeof body;
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end('{"error":"読めない中身です"}');
      return;
    }
    const ref = body.model ?? this.loaded()[0] ?? '';
    const held = this.#sessions.get(ref) as { session: { prompt: (t: string) => Promise<string> } } | undefined;
    if (!held) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `読み込んでいません: ${ref}` }));
      return;
    }
    const prompt = (body.messages ?? []).map((m) => m.content).join('\n\n');
    const text = await held.session.prompt(prompt);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'inproc', object: 'chat.completion', model: ref,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    }));
  }
}
