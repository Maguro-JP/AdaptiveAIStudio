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
import { toolPrompt } from './tool-prompt.ts';
import { extractToolCalls, ToolTextFilter } from '../agent/tool-text.ts';
import { readGguf } from './gguf.ts';
import { extractFacts } from './gguf-spec.ts';
import { totalmem } from 'node:os';
/**
 * ライブラリの名前。文字列の変数にしておく。
 *
 * 名前を直に書くと、型検査がその場で解決しに行き、入っていない場所
 * （CI の npm ci、作業コピー）で「見つからない」と落ちる。実行時に
 * 無いときは、無いと言う道が別にある。型検査には解決させない。
 */
const LLAMA_LIB = 'node-llama-cpp';


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
   * **本物をbundle として用意できない**ので、ここを開けておく。
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

/**
 * 窓を、この機械の記憶に合わせて決める。
 *
 * **窓はそのまま記憶（KV）になる。**8B のモデルで窓を 8k から 32k へ広げると、
 * それだけで 3.4GB 増える（重み 5GB + KV 4.5GB = 9.5GB）。
 * 16GB の機械では、他が何も動かなくなる。
 *
 * 「機械が固まって、発熱して、煙をあげる」は実際に言われた形。
 * 広げるのは良いが、**広げた分を数えずに広げない。**
 *
 * 数えられないとき（ファイルから諸元が読めないとき）は、**狭めない。**
 * 分からないことを理由に絞ると、読めないモデルほど不利になる。
 */
export function fitWindow(opts: {
  /** モデルが持っている窓 */
  trained: number;
  layers?: number;
  embedding?: number;
  heads?: number;
  kvHeads?: number;
  /** 重みの大きさ（ファイルの大きさでよい） */
  weightBytes?: number;
  ramBytes: number;
  max?: number;
  /** これより狭くはしない。狭すぎると、決まりだけで溢れる。 */
  floor?: number;
}): { window: number; why?: string } {
  const want = Math.min(opts.trained, opts.max ?? MAX_WINDOW);
  const floor = opts.floor ?? 4096;
  const { layers, embedding, heads } = opts;
  if (!layers || !embedding || !heads) return { window: want };

  const headDim = Math.floor(embedding / heads);
  const kvDim = headDim * (opts.kvHeads ?? heads);
  // K と V、それぞれ 2 バイト（f16）。
  const perToken = 2 * layers * kvDim * 2;
  if (perToken <= 0) return { window: want };

  // OS と、計算に使う分を残す。全部を当てにしない。
  const budget = opts.ramBytes * 0.7 - (opts.weightBytes ?? 0);
  const allowed = Math.floor(budget / perToken);
  if (allowed >= want) return { window: want };

  const window = Math.max(floor, Math.min(want, allowed));
  const gb = (n: number) => (n / 1024 ** 3).toFixed(1);
  return {
    window,
    why: `窓を ${want} から ${window} に狭めました`
      + `（この機械の記憶 ${gb(opts.ramBytes)}GB に対して、`
      + `窓 ${want} は ${gb(want * perToken)}GB を使います）`,
  };
}

/**
 * 「合う型が見つからなかった」ときに落ちてくる先。
 *
 * ライブラリの既定の受け皿で、どのモデルでも一応動く。動くが、
 * **道具の呼び方までは合っていない。**そこを黙らせない。
 */
const GUESSED_WRAPPERS = new Set(['General', 'Llama2Chat']);

/**
 * 窓の上限。
 *
 * 窓はそのまま記憶（KV）の大きさになる。青天井にすると、
 * 大きいモデルで機械が固まる（「打っても返事が来ない」に戻る）。
 */
export const MAX_WINDOW = 32_768;

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

  /**
   * 読んだものの「道具の呼び方」。当てずっぽうなら、そう分かる形で返す。
   * 画面と `doctor` から見る。**確かめる先が無いと、疑う先だけが増える。**
   */
  /**
   * 実際に開いた窓。
   *
   * **開く側と、見積もる側が別の数字を持たない。**上の層は設定から
   * 見積もっていたので、狭められたときは溢れ（返事が来なくなる）、
   * 広げたときは刈りすぎる（窓を余らせる）。
   */
  windowOf(ref: string): number | undefined {
    return this.#sessions.get(ref)?.window;
  }

  wrappers(): { ref: string; wrapper: string; guessed: boolean }[] {
    return [...this.#sessions.entries()].map(([ref, h]) => ({
      ref, wrapper: h.wrapper, guessed: GUESSED_WRAPPERS.has(h.wrapper),
    }));
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
    // gpu: false — **同梱しているのは CPU の binary だけ。**
    // 既定（auto）だと cuda → vulkan → CPU の順に探しに行き、前の二つは
    // 必ず空振りする。そのたびに
    //   「A prebuilt binary was not found, falling back to using no GPU」
    // が出る。利用者には**壊れているようにしか見えない**（実際に言われた）。
    // 無いものを探させない。探さない分、立ち上がりも速い。
    //
    // GPU を使いたくなったら、そのときは binary を同梱してから、ここを開ける。
    const llama = await lib.getLlama({ gpu: false, build: 'never', logLevel: 'error' });
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
    // **窓は、モデルが持っているぶんを使う。**
    // 8192 の決め打ちだったので、32k 使えるモデルでも 8k しか使えなかった。
    // 覚えや決まりを載せると、それだけで埋まる。切り詰める前に、窓を広げる。
    const contextSize = await this.#windowFor(ref);
    const context = await model.createContext({ contextSize });
    /*
     * **直しは、渡した中身をそのまま書き戻すことが多い。**
     *
     * `edit_file` は、ファイルの中身を渡して、その中の文字列を find/replace に
     * 書かせる。出てくるトークンの多くは、**入力に既に在る**。
     * そこを当てにいくのが token predictor（prompt lookup）で、当たった分は
     * まとめて確かめられるので、その回数ぶん速くなる。
     *
     * ライブラリ自身が用途に「modifying code」を挙げていて、
     * **出力そのものは変わらない**（当てが外れれば普通に生成し直す）と
     * 書いてある。速さだけが変わる。
     *
     * 無い版のライブラリでも動くようにする。**速さの工夫なので、
     * 無ければ無いで進む。**ただし黙らない（効いていないのに効いている
     * と思われると、遅い理由を別の所に探すことになる）。
     */
    const predictor = lib.InputLookupTokenPredictor
      ? new lib.InputLookupTokenPredictor()
      : undefined;
    if (!predictor) this.#opts.onLog?.('先読み（token predictor）が使えない版です。速さの工夫だけ効きません。');
    const sequence = context.getSequence(predictor ? { tokenPredictor: predictor } : undefined);
    const session = new lib.LlamaChatSession({ contextSequence: sequence }) as Held['session'];
    const wrapper = session.chatWrapper?.wrapperName ?? '不明';
    this.#opts.onLog?.(`読み込みました: ${ref}（道具の呼び方: ${wrapper}）`);
    if (GUESSED_WRAPPERS.has(wrapper)) {
      this.#opts.onLog?.(
        `${ref} に合う道具の呼び方が分からず、当てずっぽうの型（${wrapper}）にしました。`
        + '道具は本文で渡して、本文から拾います（型に頼りません）。'
        + '守れないモデルもあるので、うまく呼べないときは道具呼び出しを学んだモデル（Qwen など）を置いてください。',
      );
    }
    return { context, session, wrapper, window: contextSize, turn: Promise.resolve() };
  }

  /**
   * このモデルで使う窓。
   *
   * 設定が在ればそれ。無ければ **GGUF に書いてある本来の窓**を読む。
   * 読めなければ 8192（これまでと同じ）に落とす。
   *
   * 上限は置く。大きい窓は、そのぶん記憶（KV）を食う。機械が固まると
   * 「打っても返事が来ない」に戻るので、青天井にはしない。
   */
  async #windowFor(ref: string): Promise<number> {
    if (this.#opts.contextSize) return this.#opts.contextSize;
    try {
      const at = join(this.#opts.modelsDir, ref);
      const file = await readGguf(at);
      const facts = extractFacts(file);
      const trained = facts.contextLength;
      if (typeof trained === 'number' && trained >= 2048) {
        const weightBytes = await stat(at).then((x) => x.size).catch(() => undefined);
        // **広げた分を数える。**窓はそのまま記憶（KV）になる。
        const fit = fitWindow({
          trained,
          ...(facts.layers !== undefined ? { layers: facts.layers } : {}),
          ...(facts.embeddingLength !== undefined ? { embedding: facts.embeddingLength } : {}),
          ...(facts.headCount !== undefined ? { heads: facts.headCount } : {}),
          ...(facts.headCountKv !== undefined ? { kvHeads: facts.headCountKv } : {}),
          ...(weightBytes !== undefined ? { weightBytes } : {}),
          ramBytes: totalmem(),
        });
        this.#opts.onLog?.(fit.why
          ? `窓: ${fit.window}（このモデルは ${trained} まで持っています）。${fit.why}`
          : `窓: ${fit.window}（このモデルは ${trained} まで持っています）`);
        return fit.window;
      }
    } catch {
      // 読めなくても止めない。既定へ落とす。
    }
    return 8192;
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
  async #lib(): Promise<{ getLlama: (o?: { gpu?: false; build?: 'never'; logLevel?: 'error' }) => Promise<{ loadModel: (o: { modelPath: string; onLoadProgress?: (done: number) => void }) => Promise<{ createContext: (o?: { contextSize?: number }) => Promise<{ getSequence: (o?: { tokenPredictor?: unknown }) => unknown; dispose?: () => Promise<void> }> }> }>; LlamaChatSession: new (o: { contextSequence: unknown }) => unknown;
    InputLookupTokenPredictor?: new () => unknown }> {
    const load = this.#opts.load ?? (() => import(LLAMA_LIB));
    try {
      return await load() as never;
    } catch (e) {
      throw new Error(
        'モデルを読むライブラリ（node-llama-cpp）がありません。'
        + `setup.exe や portable には入っています。作業コピーで使うときは npm install してください。（${(e as Error).message}）`,
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
    const last = messages[messages.length - 1];
    // いちばん後ろが人の言葉なら、それが「いま訊いていること」。
    // そうでない（道具の結果で終わっている）なら、訊くことは無い。
    // **前の user を引っ張り出さない。**引っ張ると、道具を呼んだ跡ごと
    // 履歴から落ちて、モデルは同じ道具をもう一度呼ぶ。
    const fromUser = last?.role === 'user';
    const asked = fromUser ? last.content : CONTINUE;
    held.session.setChatHistory(toHistory(fromUser ? messages.slice(0, -1) : messages));

    // 道具。**受け口の中で止めて、呼ぼうとしたことを持ち帰る。**
    // ライブラリは受け口の返り値を答えとして続きを作るが、実際に道具を
    // 動かすのは上の層（承認も検問所もそちらに在る）。ここでは動かさない。
    const calls: { id: string; name: string; args: unknown }[] = [];
    const stop = new AbortController();
    const functions: Record<string, LibFunction> = {};

    // **型が当てずっぽうなら、道具は本文で渡す。**
    // ライブラリ経由で渡しても、その型ではモデルに何も届かない。
    // 届かないので一度も呼ばず、「動いているが何もしない」だけが残る。
    const asText = GUESSED_WRAPPERS.has(held.wrapper) && (body.tools?.length ?? 0) > 0;
    if (asText) {
      const spec = (body.tools ?? []).flatMap((t) => (t.function?.name
        ? [{
            name: t.function.name,
            ...(t.function.description ? { description: t.function.description } : {}),
            ...(t.function.parameters ? { parameters: t.function.parameters } : {}),
          }]
        : []));
      held.session.setChatHistory([
        ...toHistory(fromUser ? messages.slice(0, -1) : messages),
        { type: 'system', text: toolPrompt(spec) },
      ]);
    }

    for (const t of asText ? [] : body.tools ?? []) {
      const name = t.function?.name;
      if (!name) continue;
      functions[name] = {
        ...(t.function?.description ? { description: t.function.description } : {}),
        ...(t.function?.parameters ? { params: t.function.parameters } : {}),
        handler: (args: unknown) => {
          calls.push({ id: `call_${calls.length}`, name, args: args ?? {} });
          stop.abort();
          return '';
        },
      };
    }
    const useTools = Object.keys(functions).length > 0;

    // **窓に対して、出せる長さを決め直す。**
    //
    // 上の層は既定で 4096 を送ってくる。窓も 4096 のとき、出力だけで窓を
    // 使い切る。実際にそうなった。止まらずに 4096 まで書き続け、
    // 溢れてライブラリが落ちる。CPU で動かすと、その間ずっと 100% を使う。
    // **「打っても返事が来ない、機械が固まる」の正体がこれ。**
    //
    // 決まり（system）と履歴が入る場所を残す。残さないと、必ず溢れる。
    // **実際に開いた窓で数える。**設定の値で数えていたので、モデルの窓が
    // 広くても狭いつもりで刈っていた（逆に、狭いのに広いつもりで溢れる）。
    const room = Math.max(256, Math.floor(held.window * 0.4));
    const wanted = typeof body.max_tokens === 'number' ? body.max_tokens : room;
    const capped = Math.min(wanted, room);

    const opts: PromptOptions = {
      signal: useTools ? AbortSignal.any([signal, stop.signal]) : signal,
      ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
      maxTokens: capped,
      // 止めたときに投げられると、何を呼ぼうとしたのかが例外に化けて消える。
      ...(useTools ? { functions, stopOnAbortSignal: true } : {}),
    };

    if (body.stream === false) {
      // 道具を呼ぼうとして止めた道は、**投げて返ることがある**。
      // そのときも、呼ぼうとしたことは持ち帰る（例外に化けさせない）。
      let text = '';
      try {
        text = await held.session.prompt(asked, opts);
      } catch (e) {
        if (calls.length === 0) throw e;
      }
      // 本文で渡したときは、本文から拾う。
      if (asText) {
        const salvaged = extractToolCalls(text);
        text = salvaged.text;
        salvaged.calls.forEach((c, i) => calls.push({ id: `call_${i}`, name: c.name, args: c.args }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'inproc', object: 'chat.completion', model: ref,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: text,
            ...(calls.length > 0 ? { tool_calls: calls.map(toWire) } : {}),
          },
          finish_reason: calls.length > 0 ? 'tool_calls' : 'stop',
        }],
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
    /** 呼ぼうとした道具を流して終える。呼んでいなければ、ただ終える。 */
    const finish = () => {
      if (calls.length === 0) { chunk({}, 'stop'); return; }
      calls.forEach((c, index) => chunk({ tool_calls: [{ index, ...toWire(c) }] }));
      chunk({}, 'tool_calls');
    };
    // 呼び出しらしき記述は、確かめるまで流さない。
    // 流してしまうと、画面に生の JSON が残る。
    const filter = asText ? new ToolTextFilter() : undefined;
    try {
      chunk({ role: 'assistant' });
      await held.session.prompt(asked, {
        ...opts,
        // 一気に返さず、出来た端から流す。長い返事のときに
        // 「止まっている」ように見えるのが、いちばん困る。
        onTextChunk: (text: string) => {
          const show = filter ? filter.push(text) : text;
          if (show) chunk({ content: show });
        },
      });
      if (filter) {
        const salvaged = filter.end();
        if (salvaged.text) chunk({ content: salvaged.text });
        salvaged.calls.forEach((c, i) => calls.push({ id: `call_${i}`, name: c.name, args: c.args }));
      }
      // 切ったのは向こう。書き戻す先はもう無い。
      // **投げずに返る道**（stopOnAbortSignal）を通ることがあるので、
      // ここでも見る。見ていなかったので、やめた後に 'stop' を送っていた。
      if (signal.aborted) { res.end(); return; }
      finish();
    } catch (e) {
      if (signal.aborted) { res.end(); return; }
      // **呼ぼうとした道具を、例外に化けさせない。**
      // こちらは受け口の中で生成を止める。ライブラリがそれを「止められた」
      // として投げてくると、何を呼ぼうとしたのかが消え、画面には
      // 「止まりました」だけが出る。持っているなら、そちらを返す。
      if (filter) {
        // 途中で落ちても、溜めた分を握り潰さない。
        const salvaged = filter.end();
        if (salvaged.text) chunk({ content: salvaged.text });
        salvaged.calls.forEach((c, i) => calls.push({ id: `call_${i}`, name: c.name, args: c.args }));
      }
      if (calls.length > 0) { finish(); }
      // 途中で落ちたことを、黙って握り潰さない。
      // **`stop` で終えない。**`stop` は「言い終えた」の意味なので、上の層は
      // 成功として扱い、画面には「完了・検証済み」と出る。実際にそう出ていた。
      // 落ちたものを完了と記録するのが、いちばん質が悪い。
      else chunk({ content: `\n[止まりました: ${(e as Error).message}]` }, 'error');
    }
    res.write('data: [DONE]\n\n');
    res.end();
  }
}

/**
 * 道具の結果で終わっているときに、代わりに渡す一言。
 *
 * ライブラリの prompt() は「人が言ったこと」を必ず要る。道具の結果は
 * 履歴の側に畳んであるので、ここでは続きを促すだけにする。
 */
const CONTINUE = '道具の結果を踏まえて、続けてください。';

/** 呼び出しを OpenAI の形に直す。 */
function toWire(c: { id: string; name: string; args: unknown }): WireToolCall {
  return { id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } };
}

/** ライブラリの、こちらが使う分だけの形。 */
interface PromptOptions {
  temperature?: number;
  maxTokens?: number;
  onTextChunk?: (text: string) => void;
  /** 画面が「やめる」を押したら、生成そのものを止める。 */
  signal?: AbortSignal;
  /** 道具の一覧。名前 → 説明・引数の形・受け口。 */
  functions?: Record<string, LibFunction>;
  /**
   * 止められたときに、投げずに**そこまでを返す**。
   *
   * 道具を呼ばせるとき、こちらは受け口の中で止める。投げられると、
   * 何を呼ぼうとしたのかが例外に化けて消える。
   */
  stopOnAbortSignal?: boolean;
}

/** ライブラリに渡す道具ひとつ。 */
interface LibFunction {
  description?: string;
  params?: unknown;
  handler: (args: unknown) => unknown;
}
interface Held {
  context: { dispose?: () => Promise<void> };
  /**
   * ライブラリが選んだ「道具の呼び方」の型。
   *
   * ライブラリはモデルの中身から型を選ぶ。選び損ねると、当てずっぽうの型
   * （Llama2Chat / General）に落ちる。落ちても**文法としては成立する**ので、
   * 何も起きない。モデルはその呼び方を習っていないので、道具を一度も呼ばない。
   * 画面からは「雑談しかしない」に見える。**見えるようにする。**
   */
  wrapper: string;
  /** 実際に開いた窓。刈る量は、設定ではなくこちらで数える。 */
  window: number;
  session: {
    prompt: (text: string, opts?: PromptOptions) => Promise<string>;
    setChatHistory: (history: unknown[]) => void;
    /** ライブラリが選んだ型。試験の差し替えには無いので、あってもなくてもよい。 */
    chatWrapper?: { wrapperName?: string };
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

/** OpenAI の形の、道具の呼び出し一つ。 */
export interface WireToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}
export interface ChatMessage {
  role: string;
  content: string;
  /** assistant が呼ぼうとしたもの */
  tool_calls?: WireToolCall[];
  /** tool の返事が、どの呼び出しに対するものか */
  tool_call_id?: string;
}
interface ToolSpec {
  type?: string;
  function?: { name?: string; description?: string; parameters?: unknown };
}
interface ChatRequest {
  model?: string;
  messages?: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  /** 使ってよい道具。**無視していたので、GGUF だけでは何も出来なかった。** */
  tools?: ToolSpec[];
}

/** ライブラリの履歴の一項目。 */
export type HistoryItem =
  | { type: 'system'; text: string }
  | { type: 'user'; text: string }
  | { type: 'model'; response: (string | ModelFunctionCall)[] };

/** 履歴の中の、道具を呼んだ跡。 */
export interface ModelFunctionCall {
  type: 'functionCall';
  name: string;
  params: unknown;
  result: unknown;
}

/**
 * OpenAI の形を、ライブラリの形に直す。
 *
 * **道具のやりとりを落とさない。**ここまで assistant の中身だけを拾って
 * いたので、何を呼んで何が返ったかが履歴から消えていた。消えると、モデルは
 * 同じ道具をもう一度呼ぶ（同じところを延々と回る）。
 *
 * 呼び出しと結果は、OpenAI では二つの行に分かれて来る
 * （assistant.tool_calls と、role:'tool' の行）。ライブラリは一つの塊で
 * 持つので、id で結び直す。
 */
export function toHistory(messages: ChatMessage[]): HistoryItem[] {
  // 先に結果を引けるようにしておく。結果は呼び出しより後ろに来る。
  const results = new Map<string, string>();
  for (const m of messages) {
    if (m.role === 'tool' && m.tool_call_id) results.set(m.tool_call_id, m.content);
  }
  const out: HistoryItem[] = [];
  for (const m of messages) {
    if (m.role === 'system') { out.push({ type: 'system', text: m.content }); continue; }
    if (m.role === 'user') { out.push({ type: 'user', text: m.content }); continue; }
    // 道具の返事は、呼び出しの側に畳んである。単独では置かない。
    if (m.role === 'tool') continue;
    if (m.role !== 'assistant') continue;
    const response: (string | ModelFunctionCall)[] = [];
    if (m.content) response.push(m.content);
    for (const call of m.tool_calls ?? []) {
      const name = call.function?.name;
      if (!name) continue;
      response.push({
        type: 'functionCall',
        name,
        params: parseArgs(call.function?.arguments),
        result: call.id !== undefined ? results.get(call.id) ?? '' : '',
      });
    }
    // 空の返事は置かない（何も言わずに道具も呼んでいない行）。
    if (response.length > 0) out.push({ type: 'model', response });
  }
  return out;
}

/**
 * 引数の JSON。**壊れていても落とさない。**
 * 小さいモデルは平気で壊れた JSON を出す。ここで落とすと会話ごと終わる。
 */
function parseArgs(raw: string | undefined): unknown {
  if (!raw || !raw.trim()) return {};
  try { return JSON.parse(raw); } catch { return { __raw: raw, __parseError: true }; }
}
