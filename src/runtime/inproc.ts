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
 * **上の層は必ず `stream: true` で呼ぶ**（src/providers/openai-compatible.ts）。
 * 普通の JSON を返すと一度も動かない。だから SSE で返す。
 * ここを合わせないまま「動くはず」と言いかけた。呼ぶ側を読んでから書く。
 *
 * GGUF は同梱しない。数GBあり、数か月で新しいものが出る。
 * 置き場に置いてあるものを読むだけにする。
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AvailableModel, LoadedModel, LocalRuntime } from './local-runtime.ts';

/**
 * 待つ口。**決め打ちにする。**
 *
 * 空いている口を勝手に使うと、上の層（provider）が繋ぎ先を知る術がない。
 * 設定に書こうにも、毎回変わるので書けない。だから決めておいて、
 * 設定を読むところで同じ番号を入れる（src/config.ts）。
 *
 * 4174 は画面、4175/4176 は preview などに使う。離してある。
 */
export const INPROC_PORT = 4177;

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
  readonly #sessions = new Map<string, Held>();

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
    await this.#sessions.get(ref)?.context.dispose?.().catch(() => { /* すでに解けている */ });
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
      this.#server!.listen(this.#opts.port ?? INPROC_PORT, '127.0.0.1', resolve);
    });
    const addr = this.#server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    this.#url = `http://127.0.0.1:${port}/v1`;
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname.endsWith('/models')) {
      // 繋がるかの確認に使われる。読み込んでいるものを答える。
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list',
        data: this.loaded().map((id) => ({ id, object: 'model' })),
      }));
      return;
    }
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
    let body: ChatRequest;
    try {
      body = JSON.parse(raw || '{}') as ChatRequest;
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end('{"error":"読めない中身です"}');
      return;
    }

    // 上の層が言ってくる名前は、候補の決め方によって GGUF の名前と
    // 一致しないことがある。読んでいるものが一つしか無いなら、それを使う。
    // **黙って替えない。**替えたことは記録に出す。
    let ref = body.model ?? '';
    let held = this.#sessions.get(ref);
    if (!held && this.loaded().length === 1) {
      const only = this.loaded()[0]!;
      if (ref && ref !== only) this.#opts.onLog?.(`${ref} は無いので ${only} で答えます`);
      ref = only;
      held = this.#sessions.get(ref);
    }
    if (!held) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        error: { message: `読み込んでいません: ${body.model ?? '(名前なし)'}` },
      }));
      return;
    }

    // 上の層は毎回すべての履歴を送ってくる。こちらは持ち越さず、
    // **渡されたものだけ**で組み直す。持ち越すと二重になる。
    const messages = body.messages ?? [];
    // いま訊いていること＝最後の user。それより前が履歴。
    let at = messages.length - 1;
    while (at >= 0 && messages[at]!.role !== 'user') at--;
    const asked = at >= 0 ? messages[at]!.content : '';
    held.session.setChatHistory(toHistory(messages.slice(0, Math.max(at, 0))));

    const opts = {
      ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
      ...(typeof body.max_tokens === 'number' ? { maxTokens: body.max_tokens } : {}),
    };

    if (body.stream === false) {
      const text = await held.session.prompt(asked, opts);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'inproc', object: 'chat.completion', model: ref,
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      }));
      return;
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const chunk = (delta: Record<string, unknown>, finish: string | null = null) => {
      res.write(`data: ${JSON.stringify({
        id: 'inproc', object: 'chat.completion.chunk', model: ref,
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`);
    };
    try {
      chunk({ role: 'assistant' });
      await held.session.prompt(asked, {
        ...opts,
        // 一気に返さず、出来た端から流す。長い返事のときに
        // 「止まっている」ように見えるのが、いちばん困る。
        onTextChunk: (text: string) => chunk({ content: text }),
      });
      chunk({}, 'stop');
    } catch (e) {
      // 途中で落ちたことを、黙って握り潰さない。
      chunk({ content: `\n[止まりました: ${(e as Error).message}]` }, 'stop');
    }
    res.write('data: [DONE]\n\n');
    res.end();
  }
}

/** ライブラリの、こちらが使う分だけの形。 */
interface PromptOptions {
  temperature?: number;
  maxTokens?: number;
  onTextChunk?: (text: string) => void;
}
interface Held {
  context: { dispose?: () => Promise<void> };
  session: {
    prompt: (text: string, opts?: PromptOptions) => Promise<string>;
    setChatHistory: (history: unknown[]) => void;
  };
}

interface ChatMessage { role: string; content: string }
interface ChatRequest {
  model?: string;
  messages?: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
}

/**
 * OpenAI の形を、ライブラリの形に直す。
 *
 * 最後の user は履歴に入れない（それが「いま訊いていること」で、
 * prompt() に渡すもの）。入れると同じことを二度言うことになる。
 */
export function toHistory(messages: ChatMessage[]): { type: string; text?: string; response?: string[] }[] {
  const out: { type: string; text?: string; response?: string[] }[] = [];
  for (const m of messages) {
    if (m.role === 'system') out.push({ type: 'system', text: m.content });
    else if (m.role === 'user') out.push({ type: 'user', text: m.content });
    else if (m.role === 'assistant') out.push({ type: 'model', response: [m.content] });
  }
  return out;
}
