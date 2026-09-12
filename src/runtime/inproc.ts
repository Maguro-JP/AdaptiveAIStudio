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
import { DEFAULT_PRIORITY, Priority, PRIORITY_HEADER, toPriority } from '../providers/contract.ts';
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

/**
 * その口が空いているか。空いていなければ、次を探す。
 *
 * **決まった口を取り合わない。**もう一つ立ち上がっていたり、前のものが
 * 残っていたりすると、モデルの口（4177）が埋まる。そのとき出るのは
 * 「既に使われています」で、押した人には**モデルが読めない**としか見えない。
 * この機械で三度踏んだ。空いているものを選べば起きない。
 *
 * 探すのは近い番号から。**0（何でもよい）にしない。**繋ぐ側は設定から
 * 番号を組み立てるので、ここで決めた番号を設定へ書き戻す必要がある。
 */
export async function freePortFrom(
  preferred: number,
  tries = 20,
  listen: (port: number) => Promise<boolean> = probe,
): Promise<number | undefined> {
  for (let i = 0; i < tries; i += 1) {
    if (await listen(preferred + i)) return preferred + i;
  }
  return undefined;
}

/** その口で待てるかを、実際に開いて確かめる。開いたら閉じる。 */
async function probe(port: number): Promise<boolean> {
  const { createServer } = await import('node:net');
  return await new Promise<boolean>((ok) => {
    const s = createServer();
    s.once('error', () => ok(false));
    s.listen(port, '127.0.0.1', () => { s.close(() => ok(true)); });
  });
}

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
  /**
   * 並列に持つ sequence の本数。会話ごとに一本使うので、これが
   * 「同時に何人に答えられるか」になる。既定 `DEFAULT_SEQUENCES`。
   *
   * **速くはならない。止まらなくなるだけ。**CPU は分け合うので、
   * 二人に同時に答えても一人あたりは遅くなる。狙いは「一人が長く考えて
   * いる間、もう一人が待たされない」こと。
   *
   * KV は本数ぶん要る。コンテキストウィンドウ × 本数 が記憶に収まるよう、`fitWindow` が
   * 数えてコンテキストウィンドウを狭める（諸元が読めないときは 1 本に留める）。
   */
  sequences?: number;
  /**
   * 別のプロセス（inproc-host）で動かすときの、操作の口を開けるか。
   * `/control/*` で一覧・読み込み・降ろす・止めるを受ける。
   * 画面のプロセスは、これ越しにしかモデルに触らない。
   */
  control?: boolean;
  /** `/control/shutdown` で止めたあとに呼ぶ（別のプロセスなら、ここで終わる）。 */
  onExit?: () => void;
  /** 列で待つ間の `: queued` の間隔。既定 `QUEUE_HEARTBEAT_MS`。テストで短くする。 */
  queueHeartbeatMs?: number;
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
 * どの GGUF を読むか決める。
 *
 * **名前の順で先頭を掴まない。**`listGguf` は名前で並べるので、そのまま
 * 先頭を取ると、検証用に大小いくつも置いてある保存先では、**たまたま名前が
 * 前に来た大きいほう**が選ばれる。記憶に辛うじて載る大きさだと、
 * 追い出しが起きて読み込みが何十分も終わらない。**小さいものが同じ
 * フォルダに在っても見ない。**
 *
 * 決め方:
 *   1. 設定で名指しされているものが在れば、それ（利用者が決めたものが最優先）
 *   2. GPU が在るなら、載るもののうち**いちばん大きいもの**（賢い方が良い）
 *   3. GPU が無いなら、載るもののうち**いちばん小さいもの**（速い方が良い）
 *   4. どれも載らないなら、いちばん小さいものを返して、載らないと言わせる
 *
 * **「載る」を「良い」と読んでいた。**GPU の無い機械では、大きいほど
 * 読み込みも生成も遅くなるだけで、賢さは待ち時間で相殺されるどころか、
 * **返ってこないのと同じになる。**8B・4.7GB を CPU に載せると、最初の
 * 送信で何分も待つ（そのあいだ画面は何も言わない、が今日の出発点だった）。
 * 選ぶ口は設定に在るので、**大きい方を使いたい人は、そこで選べる。**
 */
export function chooseModel(
  models: readonly AvailableModel[],
  ramBytes: number,
  wanted?: string,
  opts: { hasGpu?: boolean } = {},
): { chosen: AvailableModel; fits: boolean } | undefined {
  if (models.length === 0) return undefined;
  const named = wanted ? models.find((m) => m.ref === wanted) : undefined;
  if (named) return { chosen: named, fits: !tooBigForRam(named.sizeBytes, ramBytes) };

  const fitting = models.filter((m) => !tooBigForRam(m.sizeBytes, ramBytes));
  if (fitting.length > 0) {
    const size = (m: AvailableModel) => m.sizeBytes ?? 0;
    const smallest = fitting.reduce((a, b) => (size(b) < size(a) ? b : a));
    const largest = fitting.reduce((a, b) => (size(b) > size(a) ? b : a));
    return { chosen: opts.hasGpu === false ? smallest : largest, fits: true };
  }
  const smallest = models.reduce((a, b) => ((b.sizeBytes ?? 0) < (a.sizeBytes ?? 0) ? b : a));
  return { chosen: smallest, fits: false };
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
 * **数えられないときは、広げない。**
 *
 * ここは「分からないことを理由に絞ると、読めないモデルほど不利になる」として、
 * 諸元が読めないときに `trained` をそのまま通していた。だが KV の大きさが
 * 計算できないだけで、KV が要らなくなるわけではない。`contextLength` だけ
 * 読めて層数や head 数が読めない GGUF は珍しくなく（アーキテクチャごとに
 * 鍵の名前が違う）、そのとき **32768 を記憶の勘定なしで渡していた。**
 *
 * 8B のモデルなら KV だけで +4.5GB。重みと合わせて 16GB の機械の容量を越え、
 * 追い出しが始まって読み込みが終わらなくなる。
 *
 * GGUF がまったく読めないときは 8192 へ落としているのに、半端に読めたときだけ
 * 無防備、という食い違いでもあった。**分からないなら、安全な側に置く。**
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
  /** 諸元が読めないときに、これ以上は広げない。 */
  unknownCap?: number;
  /**
   * 並列に持つ sequence の本数（既定 1）。KV は本数ぶん要る。
   * コンテキストウィンドウ × 本数 が記憶に収まるよう、まずコンテキストウィンドウを狭め、それでも足りなければ本数を減らす。
   */
  sequences?: number;
}): { window: number; sequences: number; why?: string } {
  const want = Math.min(opts.trained, opts.max ?? MAX_WINDOW);
  const floor = opts.floor ?? 4096;
  const wanted = Math.max(1, Math.floor(opts.sequences ?? 1));
  const { layers, embedding, heads } = opts;
  // 一トークンあたりの KV（バイト）。K と V、それぞれ 2 バイト（f16）。
  // **諸元が欠けていても、0 でも、計算できない。**`head_count_kv` が
  // 「無い（undefined）」なら heads で代えられるが、「0 として書いてある」
  // （壊れた・読み違えた GGUF）なら代えない（`?? ` は 0 を素通しする）。
  // embedding < heads でも headDim が 0 になる。どれも perToken を 0 にする。
  const headDim = (layers && embedding && heads) ? Math.floor(embedding / heads) : 0;
  const kvDim = headDim * (opts.kvHeads || heads || 0);
  const perToken = 2 * (layers ?? 0) * kvDim * 2;
  if (perToken <= 0) {
    // **KV の大きさを計算できない。広げない。並列もしない。**
    // 数えられないコンテキストウィンドウを N 倍にするのは、数えずに広げるのと同じ
    // （壊れた GGUF で 32768 × 2 本を記憶の勘定なしに開き、機械が固まる）。
    const safe = Math.min(want, opts.unknownCap ?? SAFE_WINDOW);
    const narrowed = safe < want;
    const noParallel = wanted > 1;
    if (!narrowed && !noParallel) return { window: want, sequences: 1 };
    const why = [
      narrowed
        ? 'このモデルの諸元（層数・head 数）が読めないので、記憶に載るかを'
          + `計算できません。安全な ${safe} にしています。`
        : '',
      noParallel
        ? 'このモデルの諸元が読めないので、KV を数えられません。並列は 1 本にしています。'
        : '',
      '設定 → モデル で広げられます。',
    ].filter(Boolean).join('');
    return { window: safe, sequences: 1, why };
  }

  // OS と、計算に使う分を残す。全部を当てにしない。
  const budget = opts.ramBytes * 0.7 - (opts.weightBytes ?? 0);
  // 全 sequence ぶんで使えるトークンの総数。コンテキストウィンドウ × 本数 が、ここに収まる。
  const maxTotal = Math.floor(budget / perToken);
  const gb = (n: number) => (n / 1024 ** 3).toFixed(1);

  // コンテキストウィンドウ × 本数 が収まるなら、そのまま。
  if (want * wanted <= maxTotal) return { window: want, sequences: wanted };

  // 収まらない。**まずコンテキストウィンドウを狭める**（並列は保つ）。
  const perLane = Math.floor(maxTotal / wanted);
  if (perLane >= floor) {
    return {
      window: perLane,
      sequences: wanted,
      why: `コンテキストウィンドウを ${want} から ${perLane} に狭めました`
        + `（この機械の記憶 ${gb(opts.ramBytes)}GB に、コンテキストウィンドウ × 並列 ${wanted} 本を収めるため）`,
    };
  }
  // floor でも wanted 本は載らない。**並列を減らす。**
  // **モデルのコンテキストウィンドウ（trained）を超えない。**floor は下限だが、trained が floor より
  // 狭いモデル（2048〜4095）では、floor をそのまま返すと trained を超え、
  // 記憶の勘定も超える。so want で最後に頭を抑える（`want` は trained 由来）。
  const seq = Math.max(1, Math.floor(maxTotal / floor));
  const window = Math.min(want, Math.max(floor, Math.floor(maxTotal / seq)));
  return {
    window,
    sequences: seq,
    why: `窓を ${want} から ${window} に狭めました`
      + (seq < wanted ? `。並列も ${wanted} 本から ${seq} 本に減らしました` : '')
      + `（この機械の記憶 ${gb(opts.ramBytes)}GB に対して、`
      + `コンテキストウィンドウ ${want} × 並列 ${wanted} 本は入りません）`,
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

/**
 * 記憶に載るかを計算できないときの上限。
 *
 * GGUF がまったく読めないときに落とす先（8192）と揃える。
 * **分からないときの振る舞いを、二通りにしない。**
 */
export const SAFE_WINDOW = 8192;

/**
 * 並列に持つ sequence の既定の本数。
 *
 * **1 本だと、同時に一人にしか答えられない**（それが直したかった形）。
 * 2 本にすると、一人が長く考えている間、もう一人の依頼が待たされない。
 *
 * ここを増やすほど、コンテキストウィンドウ（一会話が覚えていられる長さ）は狭くなる
 * （KV は本数ぶん要り、記憶は決まっているため）。16GB・CPU の機械で
 * いくつが良いかは実機で測る。設定 `runtime.parallel` で変えられる。
 * **速さのための数ではない。**CPU は分け合うので、増やすと一人あたりは遅くなる。
 */
export const DEFAULT_SEQUENCES = 2;
/**
 * 列で待っている間、何 ms ごとに `: queued` を打つか。
 * 上の層は最初のトークンまでの上限（10 分）を数えているが、**並んでいる時間は停滞ではない**。
 * 打ち続ければ、上の層は待ちを延ばせる（`openai-compatible.ts`）。
 */
export const QUEUE_HEARTBEAT_MS = 15_000;

export class InProcRuntime implements LocalRuntime {
  readonly id = 'inproc';
  readonly #opts: InProcOptions;
  #server?: Server;
  #url = '';
  /** 読み込んだもの。ref ごとに一つ。 */
  readonly #sessions = new Map<string, Held>();
  /** 降ろしたあと。読み込みの途中だったものが口を立て直さないためのフラグ。 */
  #down = false;
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

  /** 口を先に立てる（読み込みはしない）。別のプロセスで動かすときの入口。 */
  async serve(): Promise<string> {
    await this.#serve();
    return this.#url;
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
      const held = await load;
      // 読んでいる最中に降ろされた。**読み終えた側が口を立て直さない。**
      // 立て直すと、止めたはずのプロセスが口を開いたまま生き続ける。
      if (this.#down) {
        await held.context.dispose?.().catch(() => undefined);
        throw new Error('止めています');
      }
      this.#sessions.set(ref, held);
    }
    if (this.#down) throw new Error('止めています');
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
    //
    // **並列に持つ本数（sequences）も、ここで決まる。**KV は本数ぶん要るので、
    // コンテキストウィンドウ × 本数 が記憶に収まるよう #windowFor（fitWindow）が数えてある。
    const { window: contextSize, sequences } = await this.#windowFor(ref);
    const context = await model.createContext({ contextSize, sequences });
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
    const hasPredictor = Boolean(lib.InputLookupTokenPredictor);
    if (!hasPredictor) this.#opts.onLog?.('先読み（token predictor）が使えない版です。速さの工夫だけ効きません。');
    /*
     * **会話ごとに一本、sequence と LlamaChatSession を持つ。**
     *
     * ここが「同時に一人にしか答えられない」を直した本体。node-llama-cpp は
     * 一つの context から sequences 本の sequence を取れて、llama.cpp が同じ
     * batch に載せて並列に評価する。LlamaChatSession は履歴を持つので、一本を
     * 二人で使うと混ざる。だから **本数ぶん別々に持ち**、依頼ごとに空いた一本を
     * 貸す（LanePool）。先読みは一本ごとに一つ（sequence ごとに状態を持つ）。
     */
    const lanes: ChatLane[] = [];
    for (let i = 0; i < sequences; i += 1) {
      const predictor = lib.InputLookupTokenPredictor ? new lib.InputLookupTokenPredictor() : undefined;
      const sequence = context.getSequence(predictor ? { tokenPredictor: predictor } : undefined);
      lanes.push(new lib.LlamaChatSession({ contextSequence: sequence }) as ChatLane);
    }
    const wrapper = lanes[0]!.chatWrapper?.wrapperName ?? '不明';
    this.#opts.onLog?.(`読み込みました: ${ref}（道具の呼び方: ${wrapper}、並列 ${sequences} 本）`);
    if (GUESSED_WRAPPERS.has(wrapper)) {
      this.#opts.onLog?.(
        `${ref} に合う道具の呼び方が分からず、当てずっぽうの型（${wrapper}）にしました。`
        + '道具は本文で渡して、本文から拾います（型に頼りません）。'
        + '守れないモデルもあるので、うまく呼べないときは道具呼び出しを学んだモデル（Qwen など）を置いてください。',
      );
    }
    return { context, wrapper, window: contextSize, lanes: new LanePool(lanes) };
  }

  /** 並列に持ちたい本数。設定が無ければ既定。 */
  #wantedSequences(): number {
    return Math.max(1, Math.floor(this.#opts.sequences ?? DEFAULT_SEQUENCES));
  }

  /**
   * このモデルで使うコンテキストウィンドウと、並列に持つ本数。
   *
   * 設定が在ればそれ（本数はそのまま honor する。コンテキストウィンドウは利用者が決めたので）。
   * 無ければ **GGUF に書いてある本来のコンテキストウィンドウ**を読み、コンテキストウィンドウ × 本数 が記憶に収まるよう
   * 数える（fitWindow）。読めなければ 8192・1 本（諸元を数えられないので広げない）。
   *
   * 上限は置く。大きい窓は、そのぶん記憶（KV）を食う。機械が固まると
   * 「打っても返事が来ない」に戻るので、青天井にはしない。
   */
  async #windowFor(ref: string): Promise<{ window: number; sequences: number }> {
    const wanted = this.#wantedSequences();
    if (this.#opts.contextSize) {
      // コンテキストウィンドウは利用者が決めた。本数はそのまま。KV は数えないが、本人の選択。
      if (wanted > 1) this.#opts.onLog?.(`コンテキストウィンドウ ${this.#opts.contextSize} × 並列 ${wanted} 本（設定のコンテキストウィンドウをそのまま使います）`);
      return { window: this.#opts.contextSize, sequences: wanted };
    }
    try {
      const at = join(this.#opts.modelsDir, ref);
      const file = await readGguf(at);
      const facts = extractFacts(file);
      const trained = facts.contextLength;
      if (typeof trained === 'number' && trained >= 2048) {
        const weightBytes = await stat(at).then((x) => x.size).catch(() => undefined);
        // **広げた分を数える。**コンテキストウィンドウはそのまま記憶（KV）になる。並列の本数ぶんも。
        const fit = fitWindow({
          trained,
          ...(facts.layers !== undefined ? { layers: facts.layers } : {}),
          ...(facts.embeddingLength !== undefined ? { embedding: facts.embeddingLength } : {}),
          ...(facts.headCount !== undefined ? { heads: facts.headCount } : {}),
          ...(facts.headCountKv !== undefined ? { kvHeads: facts.headCountKv } : {}),
          ...(weightBytes !== undefined ? { weightBytes } : {}),
          ramBytes: totalmem(),
          sequences: wanted,
        });
        this.#opts.onLog?.(fit.why
          ? `コンテキストウィンドウ: ${fit.window}・並列 ${fit.sequences} 本（このモデルは ${trained} まで持っています）。${fit.why}`
          : `コンテキストウィンドウ: ${fit.window}・並列 ${fit.sequences} 本（このモデルは ${trained} まで持っています）`);
        return { window: fit.window, sequences: fit.sequences };
      }
    } catch {
      // 読めなくても止めない。既定へ落とす。
    }
    // 諸元が読めない → KV を数えられない → 広げず、並列もしない。
    return { window: 8192, sequences: 1 };
  }

  /**
   * 操作の口。別のプロセスから、一覧・読み込み・降ろす・止める。
   * 画面のプロセスが CPU に食われて固まらないよう、モデルはこちらで動かす。
   */
  async #control(url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reply = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const readJson = async (): Promise<Record<string, unknown>> => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>; } catch { return {}; }
    };
    const op = url.pathname.slice('/control/'.length);
    try {
      if (op === 'list') return reply(200, await this.list());
      if (op === 'loaded') return reply(200, this.loaded());
      if (op === 'wrappers') return reply(200, this.wrappers());
      if (op === 'load' && req.method === 'POST') {
        const { ref } = await readJson();
        if (typeof ref !== 'string') return reply(400, { error: 'ref が要ります' });
        const got = await this.ensureLoaded(ref);
        return reply(200, { ...got, window: this.windowOf(ref) ?? null });
      }
      if (op === 'unload' && req.method === 'POST') {
        const { ref } = await readJson();
        if (typeof ref !== 'string') return reply(400, { error: 'ref が要ります' });
        await this.unload(ref);
        return reply(200, { ok: true });
      }
      if (op === 'shutdown' && req.method === 'POST') {
        reply(200, { ok: true });
        // 返事を出し切ってから止める。
        setTimeout(() => { void this.shutdown().then(() => this.#opts.onExit?.()); }, 50).unref?.();
        return;
      }
      return reply(404, { error: 'そこはありません' });
    } catch (e) {
      return reply(500, { error: (e as Error).message });
    }
  }

  async unload(ref: string): Promise<void> {
    await this.#sessions.get(ref)?.context.dispose?.().catch(() => { /* すでに解けている */ });
    this.#sessions.delete(ref);
  }

  async shutdown(): Promise<void> {
    this.#down = true;
    for (const ref of this.loaded()) await this.unload(ref);
    this.#server?.close();
    this.#server = undefined;
    this.#url = '';
  }

  /** ライブラリ。無いときは、無いとだけ言う。黙って別のことをしない。 */
  async #lib(): Promise<{ getLlama: (o?: { gpu?: false; build?: 'never'; logLevel?: 'error' }) => Promise<{ loadModel: (o: { modelPath: string; onLoadProgress?: (done: number) => void }) => Promise<{ createContext: (o?: { contextSize?: number; sequences?: number }) => Promise<{ getSequence: (o?: { tokenPredictor?: unknown }) => unknown; dispose?: () => Promise<void> }> }> }>; LlamaChatSession: new (o: { contextSequence: unknown }) => unknown;
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
    this.#server = createServer((req, res) => {
      // **拾い手のない例外で、プロセスごと落とさない。**`void` で投げっぱなし
      // にしていたので、一つの要求が失敗しただけで全体が消えた。
      this.#handle(req, res).catch((e: unknown) => {
        const why = e instanceof Error ? e.message : String(e);
        try {
          if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: why } }));
        } catch { /* もう切れている */ }
      });
    });
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
    if (this.#opts.control && url.pathname.startsWith('/control/')) return this.#control(url, req, res);
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

    // **降ろしている最中は、新しい依頼を始めない。**
    // 読み込みの入口（ensureLoaded）は #down を見るが、既に読んであるモデルへの
    // 依頼はそこを通らない。止めている最中に来た依頼をそのまま prompt に流すと、
    // 解いている最中の context の上で生成することになり、ライブラリ（C++）ごと
    // 落ちうる（JS の try では拾えない）。断る。
    if (this.#down) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"止めています"}}');
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
        // 答えている最中のものを解かない。**以後は貸さず、並んでいる人は断り**、
        // 出ている分が戻るのを待つ。「空くのを待つ」だけだと、返った口をその場で
        // 次の待ち手へ渡し、その口の上で context を解くことになる（敵対レビューで見つけた）。
        await Promise.all([...this.#sessions.values()].map((h) => h.lanes.close()));
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

    /*
     * **繋がったことを、先に返す。**
     *
     * 上の層は、ヘッダが来るまでを 10 秒で見切る（接続の失敗と区別が
     * つかないため）。順番待ちの間ヘッダを返さずにいると、前の返事が
     * 長いだけで「接続に失敗」になり、しかも再試行が同じ列に並んで
     * 3 回とも同じ理由で落ちる（33.7 秒 = 10 秒 × 3 回、と実際に出た）。
     * ヘッダを返してから並ぶ。そこから先は、上の層が長く待ってくれる。
     */
    if (body.stream !== false) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(': queued\n\n');
    }

    // 画面が「やめる」を押すと、上の層は fetch を切る。切れたら生成も止める。
    // 止めないと、誰も読まない答えを作りながら口を塞ぎ続ける。
    // 切れたことは**返す側**で分かる。req は本文を読み切った時点で
    // 閉じることがあり、切断の合図には使えない（使って空振りした）。
    const gone = new AbortController();
    const onClose = () => gone.abort();
    res.on('close', onClose);
    // **空いている口（lane）を一本借りる。**空いていなければ、空くまで待つ。
    // 一本ごとに別の LlamaChatSession なので、二人が同じ履歴を混ぜ合わない。
    // 全部塞がっていても、ヘッダは既に返してあるので上の層は待てる。
    // 待っている間に切られたら（gone）、借りずに戻る。
    // 優先度はヘッダで受ける（`x-aas-priority: 0〜4`）。無ければ中。
    // 上（最優先・優先）が待っていれば、高・中・低はその後ろ。
    const priority = toPriority(req.headers[PRIORITY_HEADER]);
    // 列で待つ間は `: queued` を打ち続ける。上の層の「最初のトークンまで 10 分」を、
    // 並んでいる時間で使い切らせないため（並んでいるのは停滞ではない）。
    const streaming = body.stream !== false;
    const beat = streaming
      ? setInterval(() => { if (!res.writableEnded) res.write(': queued\n\n'); },
        this.#opts.queueHeartbeatMs ?? QUEUE_HEARTBEAT_MS)
      : undefined;
    let lane: ChatLane | undefined;
    try {
      lane = await held.lanes.acquire({ signal: gone.signal, priority });
    } finally {
      if (beat) clearInterval(beat);
    }
    try {
      // 並んでいる間に切られた依頼は、始めない。誰も読まない答えを
      // 作りながら、口を塞ぐことになる。
      if (res.destroyed || res.writableEnded) return;
      if (!lane) {
        // 借りられなかった（切り替えで口を閉じた）。**黙って放置しない。**
        // 放置すると上の層は 10 分の停滞で落とし、やり直しもしない。
        // 落ちたと分かる形で閉じれば、上の層は unavailable としてやり直す。
        this.#refuse(res, streaming, ref);
        return;
      }
      if (streaming) res.write(': started\n\n');
      await this.#respond(held, lane, ref, body, res, gone.signal);
    } finally {
      res.off('close', onClose);
      if (lane) held.lanes.release(lane);
    }
  }

  /** 口を借りられなかった依頼を、落ちたと分かる形で閉じる。 */
  #refuse(res: ServerResponse, streaming: boolean, ref: string): void {
    if (streaming) {
      res.write(`data: ${JSON.stringify({
        id: 'inproc', object: 'chat.completion.chunk', model: ref,
        choices: [{ index: 0, delta: {}, finish_reason: 'error' }],
      })}\n\n`);
      res.end('data: [DONE]\n\n');
      return;
    }
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"切り替えています"}}');
  }

  async #respond(
    held: Held, lane: ChatLane, ref: string, body: ChatRequest,
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
    lane.setChatHistory(toHistory(fromUser ? messages.slice(0, -1) : messages));

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
      lane.setChatHistory([
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
      /*
       * **考えごと（<think>）をさせない。**
       *
       * Qwen3 は答える前に考えごとを書く。ライブラリの既定はその予算が
       * コンテキストウィンドウの 75%（32k なら 24k トークン）で、しかも考えごとは onTextChunk に
       * 流れてこない。CPU の機械で「1+1=」に 18 分かけて、画面には一文字も
       * 出ず、出力 0 で「完了」と出た（実機の記録）。
       * 考えごとは GPU の無い機械では払えない。答えだけ書かせる。
       */
      budgets: { thoughtTokens: 0 },
      // 止めたときに投げられると、何を呼ぼうとしたのかが例外に化けて消える。
      ...(useTools ? { functions, stopOnAbortSignal: true } : {}),
    };

    if (body.stream === false) {
      // 道具を呼ぼうとして止めた道は、**投げて返ることがある**。
      // そのときも、呼ぼうとしたことは持ち帰る（例外に化けさせない）。
      let text = '';
      try {
        text = await lane.prompt(asked, opts);
      } catch (e) {
        if (calls.length === 0) throw e;
      }
      // 本文で渡したときは、本文から拾う。
      if (asText) {
        const salvaged = extractToolCalls(text);
        text = salvaged.text;
        salvaged.calls.forEach((c, i) => calls.push({ id: `call_${i}`, name: c.name, args: c.args }));
      }
      if (!res.headersSent) res.writeHead(200, { 'content-type': 'application/json' });
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

    if (!res.headersSent) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
    }
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
    // **最初の 1 トークンまでの時間を測る。**
    // CPU では、入力を読む（prompt evaluation）だけで分単位かかる。
    // その間、画面には何も出ない。「遅い」のがどこかを、記録で分かるようにする。
    const started = Date.now();
    let firstAt = 0;
    try {
      chunk({ role: 'assistant' });
      let thought = 0;
      await lane.prompt(asked, {
        ...opts,
        // 考えごとの分も含めて、最初の 1 トークンを測る。本文だけ見ていると、
        // 考えごとの間は「何も出ていない」としか分からない。
        onResponseChunk: (c) => {
          if (!firstAt) {
            firstAt = Date.now();
            const seen = lane.sequence?.nextTokenIndex;
            this.#opts.onLog?.(`最初の 1 トークンまで ${((firstAt - started) / 1000).toFixed(1)} 秒`
              + (typeof seen === 'number' ? `（入力 ${seen} トークン）` : ''));
          }
          if (c.type === 'segment' && c.segmentType === 'thought') thought += c.text.length;
        },
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
      if (thought > 0) this.#opts.onLog?.(`考えごとに ${thought} 文字使いました（答えには出しません）`);
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
  /** 本文でも考えごとでも、出た端から来る。最初の 1 トークンの時間はこちらで測る。 */
  onResponseChunk?: (chunk: { type?: string; segmentType?: string; text: string }) => void;
  /** 考えごと（<think>）などに使ってよいトークン数。0 で書かせない。 */
  budgets?: { thoughtTokens?: number };
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
/**
 * 一本の口（会話一つに一本貸す）。中身は LlamaChatSession。
 *
 * LlamaChatSession は履歴を**持っている**。答えている最中に別の依頼が
 * setChatHistory を呼ぶと、いま答えているほうの足元が入れ替わる。
 * 混ざった答えが返り、しかも落ちないので気づけない。だから **一本ずつ
 * 別に持ち**、依頼ごとに空いた一本を貸して、返すまで他へ回さない（LanePool）。
 */
export interface ChatLane {
  prompt: (text: string, opts?: PromptOptions) => Promise<string>;
  setChatHistory: (history: unknown[]) => void;
  /** ライブラリが選んだ型。試験の差し替えには無いので、あってもなくてもよい。 */
  chatWrapper?: { wrapperName?: string };
  /** 読み終えた入力の数。試験のモックには無い。 */
  sequence?: { nextTokenIndex?: number };
}

/** ここから下（高・中・低）は取り分 0。上に待ち手が居ないときだけ借りる。 */
const OPPORTUNISTIC: Priority = Priority.high;

interface Waiter {
  rank: Priority;
  /** 来た順。同じ級の中では、先に来た人から。 */
  seq: number;
  give: (lane: ChatLane) => void;
  /** 貸さずに返す（切られた・閉じた）。 */
  drop: () => void;
}

/**
 * 口の貸し出し。**空いた一本を上から順に貸し、無ければ空くまで待つ。**
 *
 * 断らずに待たせる（上の層は待てる。断られると諦めてしまう）。
 * 待っている間に依頼が切られたら（signal）、貸さずに返す。
 */
export class LanePool {
  readonly #all: ChatLane[];
  readonly #free: ChatLane[];
  /** 待ち手。**級（数が小さいほど先）、同じ級なら来た順**で並べて持つ。 */
  readonly #waiters: Waiter[] = [];
  #seq = 0;
  /** 貸している口が、どの級に貸したものか。返るときに取り分の数を戻すため。 */
  readonly #lentTo = new Map<ChatLane, Priority>();
  /** 高・中・低が今いくつ借りているか。上のために空ける本数と突き合わせる。 */
  #lowHeld = 0;
  /** close() のあと。以後は貸さない。 */
  #closed = false;
  /**
   * これまでに口を返した回数。**「今この場で動いているぶんが片づくまで」を
   * 数で測る**ために持つ。全部空くのを待つと、次々に依頼が来るあいだ
   * `#free` が一度も満ちず、`whenAllIdle` が永久に返らない（切り替えが固まる）。
   */
  #released = 0;
  /** いま動いているぶんが片づくのを待っている人（`target` 回まで返るのを待つ）。 */
  #drainWaiters: Array<{ target: number; resolve: () => void }> = [];

  constructor(lanes: ChatLane[]) {
    this.#all = lanes;
    this.#free = [...lanes];
  }

  /** 何本あるか。 */
  get size(): number { return this.#all.length; }
  /** いま貸し出している本数。 */
  get busy(): number { return this.#all.length - this.#free.length; }
  /** 高・中・低が今いくつ借りているか。 */
  get lowHeld(): number { return this.#lowHeld; }
  /**
   * 上（最優先・優先）のために空けておく本数。**本数で決まる。設定ではない。**
   *
   * 2 本以上なら半分（切り上げ）。高・中・低は残りを借りる。
   * 1 本しか無ければ 0（空けると、高・中・低が永久に借りられない）。
   */
  get reserve(): number { return this.#all.length >= 2 ? Math.ceil(this.#all.length / 2) : 0; }

  /** この級が、いま一本借りてよいか。上は常に。高・中・低は取り分の内なら。 */
  #allowed(rank: Priority): boolean {
    if (rank < OPPORTUNISTIC) return true;
    return this.#lowHeld < this.#all.length - this.reserve;
  }

  #lend(lane: ChatLane, rank: Priority): ChatLane {
    this.#lentTo.set(lane, rank);
    if (rank >= OPPORTUNISTIC) this.#lowHeld += 1;
    return lane;
  }

  /**
   * 一本借りる。無ければ空くまで待つ。**上から順に回る。**
   *
   * 空いているのに借りられないのは、高・中・低が上のぶんを残しているとき
   * （その場合も待つ。断らない）。待っている間に signal が上がったら、
   * `undefined` を返す（借りない）。
   */
  acquire(
    { signal, priority = DEFAULT_PRIORITY }: { signal?: AbortSignal; priority?: Priority } = {},
  ): Promise<ChatLane | undefined> {
    if (this.#closed || signal?.aborted) return Promise.resolve(undefined);
    if (this.#free.length > 0 && this.#allowed(priority)) {
      return Promise.resolve(this.#lend(this.#free.pop()!, priority));
    }
    return new Promise<ChatLane | undefined>((resolve) => {
      const waiter: Waiter = {
        rank: priority,
        seq: this.#seq++,
        give: (lane) => { cleanup(); resolve(lane); },
        drop: () => { cleanup(); resolve(undefined); },
      };
      const onAbort = (): void => {
        const at = this.#waiters.indexOf(waiter);
        if (at >= 0) this.#waiters.splice(at, 1);
        waiter.drop();
      };
      const cleanup = (): void => signal?.removeEventListener('abort', onAbort);
      // 級の小さい順、同じ級なら来た順。後ろから見て、自分より級の大きい人を越える。
      let at = this.#waiters.length;
      while (at > 0 && this.#waiters[at - 1]!.rank > priority) at -= 1;
      this.#waiters.splice(at, 0, waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * 借りた一本を返す。**上から順に見て、いま借りてよい最初の人へ回す。**
   * 高・中・低しか待っておらず、その取り分が塞がっていれば、誰にも渡さず
   * 空けておく（上が来たら、その場で渡せるように）。
   */
  release(lane: ChatLane): void {
    const rank = this.#lentTo.get(lane);
    this.#lentTo.delete(lane);
    if (rank !== undefined && rank >= OPPORTUNISTIC) this.#lowHeld -= 1;
    // **一本返るたびに数える。**待っている切り替えは、この数で「片づいた」を見る。
    this.#released += 1;
    this.#drainWaiters = this.#drainWaiters.filter((w) => {
      if (this.#released >= w.target) { w.resolve(); return false; }
      return true;
    });
    // 閉じたあとは誰にも渡さない（待ち手は close() で全員返してある）。
    const at = this.#closed ? -1 : this.#waiters.findIndex((w) => this.#allowed(w.rank));
    if (at >= 0) {
      const [next] = this.#waiters.splice(at, 1);
      next!.give(this.#lend(lane, next!.rank));
      return;
    }
    this.#free.push(lane);
  }

  /**
   * **以後は貸さない。**並んでいる人は全員 `undefined` で返し（断る）、
   * いま出ている分が戻るのを待つ。降ろす・切り替える前に呼ぶ。
   *
   * `whenAllIdle` だけでは足りない。返った口をその場で次の待ち手へ渡すので、
   * 待っていた側が「片づいた」と受け取った直後に、その口の上で context を解くことになる。
   */
  close(): Promise<void> {
    this.#closed = true;
    for (const w of this.#waiters.splice(0)) w.drop();
    return this.whenAllIdle();
  }

  /**
   * **いま動いているぶんが片づくまで**待つ。降ろす前・切り替える前に呼ぶ。
   *
   * 「全部の口が空く」を待つと、次々に依頼が来るあいだ永久に返らない
   * （返した口がすぐ次の待ち手へ回り、`#free` が満ちない）。そこで
   * **呼んだ時点で出ている本数ぶん、返るのを待つ**。以後に来た依頼は待たない。
   */
  whenAllIdle(): Promise<void> {
    const outstanding = this.#all.length - this.#free.length;
    if (outstanding === 0) return Promise.resolve();
    const target = this.#released + outstanding;
    return new Promise<void>((resolve) => this.#drainWaiters.push({ target, resolve }));
  }
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
  /** 会話ごとに貸す口。ここが「同時に何人に答えられるか」を決める。 */
  lanes: LanePool;
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

/**
 * 開いた時点の、先の一言。
 *
 * GPU の無い機械で大きなモデルを読むと、最初の答えに何分もかかる。
 * それを**送ってから**知らせていたので、送った人には無視されたようにしか
 * 見えなかった（実機でそうなった）。開いた時点で、どれを読むか・どれだけ
 * 待つか・小さいものが在るかを言う。読み込みは始めない。
 */
export const HEAVY_ON_CPU_BYTES = 3 * 1024 ** 3;

export function headsUp(
  models: readonly AvailableModel[],
  ramBytes: number,
  wanted: string | undefined,
  hasGpu: boolean,
): string | undefined {
  if (hasGpu) return undefined;
  // 選び方は本番と同じにする（GPU なしなら小さい方）。違う選び方で脅さない。
  const picked = chooseModel(models, ramBytes, wanted, { hasGpu });
  if (!picked || !picked.fits) return undefined;
  const size = picked.chosen.sizeBytes ?? 0;
  if (size < HEAVY_ON_CPU_BYTES) return undefined;
  // 1GB 未満は MB で言う（「0.0GB」は無いのと同じに読める）。
  const gb = (n: number) => (n < 1024 ** 3 ? `${Math.round(n / 1024 ** 2)}MB` : `${(n / 1024 ** 3).toFixed(1)}GB`);
  const smaller = models
    .filter((m) => m.ref !== picked.chosen.ref && (m.sizeBytes ?? 0) < size && !tooBigForRam(m.sizeBytes, ramBytes))
    .sort((a, b) => (a.sizeBytes ?? 0) - (b.sizeBytes ?? 0))[0];
  const alt = smaller
    ? `小さいものもあります: ${smaller.ref}（${gb(smaller.sizeBytes ?? 0)}）。⚙ 設定 → モデル で選べます。`
    : '';
  return `${picked.chosen.ref}（${gb(size)}）を GPU なしで読みます。最初の答えまで数分かかることがあります。${alt}`;
}
