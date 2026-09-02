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
import { listenOrExplain } from '../core/listen.ts';
import { crossSiteReason } from '../ui/origin.ts';
import { chunkReader } from '../core/text.ts';

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
   * 文脈の大きさ（トークン）。既定 8192。
   *
   * 既定の "auto" は、モデルが学習した長さ（32k〜128k）まで取りに行くことが
   * あり、その分の記憶を最初から確保する。8GB の機械ではそれだけで足りなくなる。
   * 会社の PC はそういう機械。決めておいて、要るなら設定で広げる。
   */
  contextSize?: number;
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

/**
 * 先頭が GGUF の印か。
 *
 * 名前だけ .gguf で、中身が配布元の HTML の案内（同意が要る頁）だった、
 * が実際に起きる形。読みに行くと向こうの言葉で落ちる。先に 4 バイト見る。
 */
export async function looksLikeGguf(path: string): Promise<boolean> {
  const { open } = await import('node:fs/promises');
  try {
    const fh = await open(path, 'r');
    try {
      const buf = Buffer.alloc(4);
      const { bytesRead } = await fh.read(buf, 0, 4, 0);
      return bytesRead === 4 && buf.toString('latin1') === 'GGUF';
    } finally { await fh.close(); }
  } catch { return false; }
}

/**
 * この機械の記憶に載るか。
 *
 * GGUF はほぼそのまま記憶に載る（量子化済みなので圧縮の余地は無い）。
 * 記憶より大きいものを読みに行くと、落ちるか、何十分も固まる。
 * 読む前に止めて、そう言う。少し余裕を見る（OS と文脈の分）。
 */
export function tooBigForRam(sizeBytes: number | undefined, ramBytes: number): string | undefined {
  if (!sizeBytes || !ramBytes) return undefined;
  const room = ramBytes * 0.85;
  if (sizeBytes <= room) return undefined;
  const gb = (n: number) => (n / 1024 ** 3).toFixed(1);
  return `この機械の記憶（${gb(ramBytes)}GB）に対して大きすぎます（${gb(sizeBytes)}GB）。`
    + '小さい量子化（Q4_K_M など）か、小さいモデルを置いてください。';
}

export class InProcRuntime implements LocalRuntime {
  readonly id = 'inproc';
  readonly #opts: InProcOptions;
  #server?: Server;
  #url = '';
  /** 読み込んだもの。ref ごとに一つ。 */
  readonly #sessions = new Map<string, Held>();
  /**
   * 読み込んでいる最中のもの。
   *
   * 数GBを10〜60秒かけて読む。その間に二人目が来ると、**同じものを
   * もう一度読み始める**。二重に持つので、メモリが足りない機械では
   * そこで落ちる。落ちなくても倍の時間待たされる。
   * 二人目には、一人目の約束をそのまま渡す。
   */
  readonly #loading = new Map<string, Promise<Held>>();

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
      let load = this.#loading.get(ref);
      if (!load) {
        load = this.#load(ref);
        this.#loading.set(ref, load);
        // 失敗したら覚えたままにしない。次に呼ばれたときに、
        // 済んだ失敗をもう一度返すことになる。
        load.catch(() => undefined).finally(() => { this.#loading.delete(ref); });
      }
      this.#sessions.set(ref, await load);
    }
    await this.#serve();
    return { baseUrl: this.#url, model: ref, loadSeconds: (Date.now() - began) / 1000 };
  }

  /** 実際に読む。**必ず #loading 越しに呼ぶ。** */
  async #load(ref: string): Promise<Held> {
    const lib = await this.#lib();
    // build: 'never' — 同梱の binary が無い・読めないとき、既定では
    // llama.cpp を GitHub から取ってきて手元で組もうとする（実測）。
    // 網の無い機械では固まり、あっても何十分もかかる。**組まずに、無いと言う。**
    // logLevel: 'error' — 無いときに「prebuilt binary was not found」を何行も
    // 表に出す。こちらの言葉で言い直すので、向こうの声は落とす。
    const llama = await lib.getLlama({ build: 'never', logLevel: 'error' });
    // 数GBを読むので、10〜60秒かかる。**黙って待たせない。**
    // 進み具合を出さないと、また「固まった」に見える。
    let last = -1;
    const model = await llama.loadModel({
      modelPath: join(this.#opts.modelsDir, ref),
      onLoadProgress: (done: number) => {
        const pct = Math.floor(done * 100);
        // 1% ごとに言うと流れが埋まる。10% ごとに一度。
        if (pct < last + 10) return;
        last = pct;
        this.#opts.onLog?.(`読み込み中 ${pct}%: ${ref}`);
      },
    });
    const context = await model.createContext({ contextSize: this.#opts.contextSize ?? 8192 });
    const session = new lib.LlamaChatSession({ contextSequence: context.getSequence() });
    this.#opts.onLog?.(`読み込みました: ${ref}`);
    return { context, session, turn: Promise.resolve() };
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
  async #lib(): Promise<{ getLlama: (o?: { build?: 'never'; logLevel?: 'error' }) => Promise<{ loadModel: (o: { modelPath: string }) => Promise<{ createContext: (o?: { contextSize?: number }) => Promise<{ getSequence: () => unknown; dispose?: () => Promise<void> }> }> }>; LlamaChatSession: new (o: { contextSequence: unknown }) => unknown }> {
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
    const port = this.#opts.port ?? INPROC_PORT;
    let bound: number;
    try {
      bound = await listenOrExplain(this.#server, { port, what: 'モデル' });
    } catch (e) {
      // 開かなかった器を持ったままにしない。次に呼ばれたときに
      // 「もう立てた」と勘違いして、空の宛先を返してしまう。
      this.#server = undefined;
      throw e;
    }
    this.#url = `http://127.0.0.1:${bound}/v1`;
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 画面の口と同じ。よその頁・よその名前から叩かせない。
    // 127.0.0.1 にしか開いていなくても、ブラウザは何処の頁からでも届く。
    const refused = crossSiteReason(req.headers, req.method ?? 'GET');
    if (refused) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: refused } }));
      return;
    }
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

    // 本文の上限。上の層が送るのは履歴の JSON で、数MB で十分。
    const LIMIT = 16 * 1024 * 1024;
    const raw = await new Promise<string | undefined>((resolve) => {
      let text = '';
      let total = 0;
      const read = chunkReader();
      req.on('data', (c: Buffer) => {
        total += c.length;
        // 際限なく抱えない。上限を超えたら読むのをやめて断る。
        if (total > LIMIT) { req.destroy(); resolve(undefined); return; }
        text += read(c);
      });
      req.on('end', () => resolve(text));
    });
    if (raw === undefined) {
      res.writeHead(413, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"本文が大きすぎます"}}');
      return;
    }
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
    // 置き場に在る別の GGUF を名指しされたら、そちらへ切り替える。
    // 二つ同時に持たない（数GBを二重に載せると足りない機械がある）。
    // 候補の決め方が名前で選んでいるのに、常に最初の一つで答えるのはおかしい。
    if (!held && ref && /\.gguf$/i.test(ref)) {
      const have = (await this.list()).some((m) => m.ref === ref);
      if (have) {
        // 答えている最中のものを解かない。順番待ちが空くのを待ってから。
        await Promise.all([...this.#sessions.values()].map((h) => h.turn.catch(() => undefined)));
        for (const other of this.loaded()) {
          this.#opts.onLog?.(`${other} を解いて ${ref} に切り替えます`);
          await this.unload(other);
        }
        try {
          await this.ensureLoaded(ref);
          held = this.#sessions.get(ref);
        } catch (e) {
          this.#opts.onLog?.(`${ref} を読めませんでした: ${(e as Error).message}`);
        }
      }
    }
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

    // 前の依頼が終わってから始める。setChatHistory から prompt() まで、
    // 途中で割り込まれてはいけない一続きなので、丸ごと順番待ちに入れる。
    const mine = held.turn.then(
      () => this.#answer(held!, ref, body, res),
      () => this.#answer(held!, ref, body, res),
    );
    held.turn = mine.catch(() => undefined);
    await mine;
  }

  /** 一人分の受け答え。**必ず順番待ちの中から呼ぶ。** */
  async #answer(
    held: Held, ref: string, body: ChatRequest, res: ServerResponse,
  ): Promise<void> {
    // 画面が「やめる」を押すと、上の層は fetch を切る。切れたら生成も止める。
    // 止めないと、誰も読まない答えを作りながら次の人を待たせ続ける。
    // 切れたことは**返す側**で分かる。req は本文を読み切った時点で
    // 閉じることがあり、切断の合図には使えない（使って空振りした）。
    const gone = new AbortController();
    const onClose = () => gone.abort();
    res.on('close', onClose);
    try {
      await this.#respond(held, ref, body, res, gone.signal);
    } finally {
      res.off('close', onClose);
    }
  }

  async #respond(
    held: Held, ref: string, body: ChatRequest,
    res: ServerResponse, signal: AbortSignal,
  ): Promise<void> {
    // 上の層は毎回すべての履歴を送ってくる。こちらは持ち越さず、
    // **渡されたものだけ**で組み直す。持ち越すと二重になる。
    const messages = body.messages ?? [];
    // いま訊いていること＝最後の user。それより前が履歴。
    let at = messages.length - 1;
    while (at >= 0 && messages[at]!.role !== 'user') at--;
    const asked = at >= 0 ? messages[at]!.content : '';
    held.session.setChatHistory(toHistory(messages.slice(0, Math.max(at, 0))));

    const opts: PromptOptions = {
      signal,
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
      // 切ったのは向こう。書き戻す先はもう無い。
      if (signal.aborted) { res.end(); return; }
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
  /** 画面が「やめる」を押したら、生成そのものを止める。 */
  signal?: AbortSignal;
}
interface Held {
  context: { dispose?: () => Promise<void> };
  session: {
    prompt: (text: string, opts?: PromptOptions) => Promise<string>;
    setChatHistory: (history: unknown[]) => void;
  };
  /**
   * 一つのモデルを、同時に二人で使わない約束。
   *
   * LlamaChatSession は履歴を**持っている**。答えている最中に別の依頼が
   * setChatHistory を呼ぶと、いま答えているほうの足元が入れ替わる。
   * 混ざった答えが返り、しかも落ちないので気づけない。
   * 断らずに**並べる**（上の層は待てる。断られると諦めてしまう）。
   */
  turn: Promise<unknown>;
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
