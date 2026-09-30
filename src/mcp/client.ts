/**
 * MCP の口。
 *
 * 外部ツールを、この場所のツールとして扱えるようにする。
 * GitHub も、それ用の口を書くのではなく **MCP のサーバを一つ足すだけ**にする。
 * 相手ごとに口を書いていくと、相手の数だけ保守が増える。
 *
 * やり取りは行区切りの JSON-RPC で、相手は子プロセス。
 * つまり**依存を増やさずに書ける**。ここで外の SDK を入れると、
 * 「実行時の依存はゼロ」が崩れる。
 *
 * 大事なのは、繋ぐことより**繋いだ先をどう扱うか**。
 *
 *   ・返ってきた中身は「外から入ってきたもの」。検問所を通す
 *   ・ツールは権限として配る。持っていない役職には渡らない
 *   ・立ち上がらない相手がいても、他は動く。全部を道連れにしない
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { canRun } from '../core/which.ts';
import { StringDecoder } from 'node:string_decoder';
import { envForChild } from '../core/env.ts';

/**
 * 溜めてよい上限。
 *
 * 相手が改行を一度も出さないと、溜め込みは**際限なく増える**。
 * 悪意が無くても、壊れた相手一つでこちらが落ちる。
 * 行区切りの約束を守らない相手は、そこで切る。
 */
const MAX_LINE_BYTES = 8 * 1024 * 1024;

/** こちらが話せる版。相手が別の版を返してきたら、それに合わせる。 */
export const PROTOCOL_VERSION = '2025-06-18';

export interface McpServerSpec {
  /**
   * 立ち上げるもの（手元で動かすとき）。
   * `url` を書いたときは使わない。
   */
  command?: string;
  args?: string[];
  /**
   * 遠くの相手（Streamable HTTP）。
   *
   * **いま主要なところは、ほとんどこちら。**手元で動かす形（stdio）だけだと、
   * `npx` の無い機械では一つも繋がらない。ここが在ると、node だけで繋がる。
   */
  url?: string;
  /**
   * 付ける見出し（ヘッダ）。**値ではなく名前で書く。**
   *
   *   "headersFrom": { "Authorization": "NOTION_TOKEN" }
   *
   * 値は環境から取る。`Bearer ` は、付いていなければこちらで付ける。
   */
  headersFrom?: Record<string, string>;
  /**
   * 渡す環境変数。**値ではなく名前で書く。**
   * 設定ファイルにトークンそのものを書かせない。
   */
  envFrom?: Record<string, string>;
  /** 立ち上がりを待つ上限。既定10秒 */
  startupTimeoutMs?: number;
}

export interface McpToolSpec {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

/** 相手が返した中身を、読める文字列にする。 */
export function flatten(result: unknown): { text: string; isError: boolean } {
  const r = result as { content?: unknown; isError?: unknown } | null;
  const isError = r?.isError === true;
  const content = Array.isArray(r?.content) ? r.content : [];
  const parts: string[] = [];
  for (const item of content) {
    const c = item as { type?: string; text?: string; uri?: string; mimeType?: string };
    if (c?.type === 'text' && typeof c.text === 'string') parts.push(c.text);
    else if (c?.type === 'resource' && typeof c.uri === 'string') parts.push(`（資源: ${c.uri}）`);
    else if (c?.type === 'image') parts.push(`（画像: ${c.mimeType ?? '種類不明'}）`);
    else if (c?.type) parts.push(`（${c.type}）`);
  }
  if (parts.length === 0 && result !== undefined && !Array.isArray(r?.content)) {
    // 形が違っても捨てない。相手の作りは揃っていない。
    parts.push(JSON.stringify(result));
  }
  return { text: parts.join('\n'), isError };
}

/**
 * Windows では `npx` は `npx.cmd`。
 *
 * Node の spawn は PATHEXT を見ないので、`npx` と書くと Windows では
 * ENOENT で立ち上がらない。拡張子の無い名前は cmd.exe 越しに起こす。
 * 設定に `npx.cmd` と書かせない（他の機械で動かなくなる）。
 */
export function spawnPlan(command: string, platform: NodeJS.Platform): { command: string; shell: boolean } {
  if (platform === 'win32' && !/\.[a-z0-9]+$/i.test(command) && !/[\\/]/.test(command)) {
    return { command, shell: true };
  }
  return { command, shell: false };
}

/**
 * 立ち上げる相手へ渡す環境変数。**トークンは、名前を書いたものだけ。**
 *
 * ここは親の環境変数を丸ごと写していたので、`envFrom` で名前を書く仕組みに
 * 関わらず、**繋いだ相手の子プロセス全部がトークンを持っていた**（`npx` で
 * 落としてくる相手も含む）。持ち主が `.env` に置いたものと、名前がトークン
 * らしいものは外し（`envForChild`）、`envFrom` に書かれた分だけを足す。
 */
export function childEnvFor(
  spec: { envFrom?: Record<string, string> },
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env = envForChild(base);
  for (const [key, from] of Object.entries(spec.envFrom ?? {})) {
    const value = base[from];
    // 無いなら渡さない。空文字を渡すと、相手が「設定済み」と誤認する。
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export class McpClient {
  readonly name: string;
  readonly #spec: McpServerSpec;
  #child?: ChildProcess;
  /** 遠くの相手のときの、繋ぎの控え。 */
  #http?: { url: string; headers: Record<string, string>; session?: string; open: boolean };
  #buffer = '';
  /**
   * 届いた塊を文字に直すもの。
   *
   * **塊ごとに toString() しない。**日本語は1文字3バイトなので、
   * 塊の切れ目が文字の途中に来ると、そこで化ける。長い返事のときだけ
   * 壊れるので、短い試しでは気づけない。またぐ分を持ち越させる。
   */
  #decoder = new StringDecoder('utf8');
  #seq = 0;
  readonly #pending = new Map<number, Pending>();
  #tools: McpToolSpec[] = [];
  #serverVersion?: string;
  /** 立ち上げに失敗した理由。使う側が「なぜ無いのか」を言えるように残す。 */
  #failure?: string;
  /**
   * `headersFrom` に書いたのに、その名前が環境に無かったもの。
   *
   * 黙って見出し無しで繋いでいたので、人が見るのは相手の 401 だけだった。
   * **どの名前が見つからなかったか**が分からないと、`.env` の綴り違いに
   * 辿り着けない。名前だけ覚える（値は持たない）。
   */
  readonly #missingHeaders: string[] = [];
  #abort?: AbortSignal;
  /**
   * 遠くの相手へ出した問いごとの、繋ぎを切る口。止めた・時間切れの問いの返事の流れ（SSE）を、その場で閉じる。
   * 閉じないと、相手が流れを開いたまま黙っている間、繋ぎが残り続けた（読み手は次の塊が来るまで待つ）。
   */
  readonly #streams = new Map<number, AbortController>();

  constructor(name: string, spec: McpServerSpec) {
    this.name = name;
    this.#spec = spec;
  }

  get tools(): readonly McpToolSpec[] { return this.#tools; }
  get failure(): string | undefined { return this.#failure; }

  /** `headersFrom` の名前が環境に無かったもの（値は持たない）。 */
  get missingHeaders(): readonly string[] { return this.#missingHeaders; }
  get running(): boolean {
    if (this.#http) return this.#http.open;
    return this.#child !== undefined && this.#child.exitCode === null;
  }

  /** 手元で立ち上げる相手か、遠くの相手か。 */
  get remote(): boolean { return this.#spec.url !== undefined; }
  get serverVersion(): string | undefined { return this.#serverVersion; }

  /** 立ち上げて、道具の一覧まで取る。失敗しても投げない。 */
  async start(signal?: AbortSignal): Promise<boolean> {
    // 前に失敗していたら、その理由は捨てる。残すと、立ち上げ直したあとも
    // 済んだ失敗を「なぜ無いのか」として言い続ける。
    this.#failure = undefined;
    this.#buffer = '';
    this.#decoder = new StringDecoder('utf8');
    // 遠くの相手は、立ち上げるものが無い。繋いで、名乗るところから。
    if (this.#spec.url) return this.#startRemote(signal);

    if (!this.#spec.command) {
      this.#failure = '立ち上げるものも、繋ぎ先も書かれていません';
      return false;
    }

    const env = childEnvFor(this.#spec);

    // 立ち上げる前に、その命令が在るかを見る。
    // 殻（shell: true）に渡すと、無い命令でも spawn は成功し、
    // 「終了しました（コード 1）」だけが残る。**何が無いのかを言う。**
    if (!canRun(this.#spec.command)) {
      this.#failure = `その命令がありません: ${this.#spec.command}`
        + (this.#spec.command === 'npx' || this.#spec.command === 'npm'
          ? '（bundle には node だけが入っています）' : '');
      return false;
    }

    try {
      const plan = spawnPlan(this.#spec.command, process.platform);
      this.#child = spawn(plan.command, this.#spec.args ?? [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
        signal,
        ...(plan.shell ? { shell: true } : {}),
      });
    } catch (e) {
      this.#failure = `立ち上げられませんでした: ${(e as Error).message}`;
      return false;
    }

    let stderr = '';
    const errDecoder = new StringDecoder('utf8');
    this.#child.stderr?.on('data', (b: Buffer) => {
      stderr = (stderr + errDecoder.write(b)).slice(-2000);
    });
    this.#child.stdout?.on('data', (b: Buffer) => { this.#onData(this.#decoder.write(b)); });
    this.#child.on('error', (e) => { this.#fail(`落ちました: ${e.message}`); });
    // 相手が終わった直後（exit を受ける前）や、相手が入力を閉じたときに書くと EPIPE になる。聞き手が無いと、受け手の無い失敗で
    // こちらごと落ちる。相手は生きていても、もう何も届かないので止める（残すと、以後の呼び出しが毎回時間切れまで待つ）
    const child = this.#child;
    child.stdin?.on('error', (e) => {
      this.#fail(`送れませんでした: ${e.message}${stderr ? `\n${stderr.trim()}` : ''}`);
      endChild(child);
      if (this.#child === child) this.#child = undefined;
    });
    this.#child.on('exit', (code) => {
      // 待っている呼び出しを放置しない。相手が消えたら、待ち手も終わらせる。
      this.#fail(`終了しました（コード ${code ?? '不明'}）${stderr ? `\n${stderr.trim()}` : ''}`);
    });

    const timeout = this.#spec.startupTimeoutMs ?? 10_000;
    try {
      const init = await this.#call('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'AdaptiveAIStudio', version: '0.1.0' },
      }, timeout) as { protocolVersion?: string };
      this.#serverVersion = init?.protocolVersion;

      this.#notify('notifications/initialized', {});

      const listed = await this.#call('tools/list', {}, timeout) as { tools?: McpToolSpec[] };
      this.#tools = (listed?.tools ?? []).filter((t) => typeof t?.name === 'string');
      return true;
    } catch (e) {
      this.#failure = (e as Error).message;
      this.stop();
      return false;
    }
  }

  /**
   * ツールを呼ぶ。`signal`（■）で止めたら、返事を待たずに返し、相手にも取り消しを知らせる。
   * 渡していなかったので、外のツールの返事待ちの間は ■ を押しても時間切れ（既定 60 秒、設定しだいで更に長い）まで止まらなかった。
   */
  async call(tool: string, args: Record<string, unknown>, timeoutMs = 60_000, signal?: AbortSignal): Promise<{
    text: string; isError: boolean;
  }> {
    if (!this.running) {
      return { text: `${this.name} は動いていません: ${this.#failure ?? '理由は不明'}`, isError: true };
    }
    if (signal?.aborted) return { text: `${this.name}/${tool} は止めたので呼んでいません`, isError: true };
    try {
      const result = await this.#call('tools/call', { name: tool, arguments: args }, timeoutMs, signal);
      if (result === STOPPED) return { text: `${this.name}/${tool} の返事を待たずに止めました`, isError: true };
      return flatten(result);
    } catch (e) {
      return { text: `${this.name}/${tool} を呼べませんでした: ${(e as Error).message}`, isError: true };
    }
  }

  stop(): void {
    if (this.#http) {
      const http = this.#http;
      http.open = false;
      // 相手側の控えも落としてもらう。返事は待たない（切るだけ）。
      if (http.session) {
        void fetch(http.url, {
          method: 'DELETE',
          headers: { ...http.headers, 'mcp-session-id': http.session, ...this.#versionHeader() },
        }).catch(() => undefined);
      }
      this.#http = undefined;
      // 待っている呼び出しを終わらせ、返事の流れも閉じる（手元の相手が落ちたときの exit と同じ扱い。
      // 落とさないと、切った後も呼び出しが時間切れまで返らなかった）
      this.#fail('切りました');
      return;
    }
    if (this.#child) endChild(this.#child);
    this.#child = undefined;
  }

  // ---- 中身 ----------------------------------------------------

  #fail(reason: string): void {
    this.#failure ??= reason;
    for (const p of this.#pending.values()) p.reject(new Error(reason));
    this.#pending.clear();
    // 待ちが無くなった問いの流れも閉じる（開いたままだと、相手が次の塊を出すまで繋ぎが残る）
    for (const own of this.#streams.values()) own.abort();
    this.#streams.clear();
  }

  /**
   * 届いた文字を、行ごとの JSON として読む。
   *
   * 塊の途中で切れることがあるので、行が揃うまで溜める。
   * ここを雑にすると、長い返事のときだけ壊れる。
   */
  #onData(chunk: string): void {
    this.#buffer += chunk;
    if (this.#buffer.length > MAX_LINE_BYTES && !this.#buffer.includes('\n')) {
      // 溜め込みを空にしてから言う。持ったまま知らせると、
      // 待ち手を終わらせた後もこちらの手元に残り続ける。
      this.#buffer = '';
      this.#fail(`${this.name} が行区切りを守っていません（切りました）`);
      this.stop();
      return;
    }
    let index: number;
    while ((index = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      if (line.length === 0) continue;

      let msg: { id?: number | string; method?: unknown; result?: unknown; error?: { message?: string } };
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // 相手が余計なものを出すことがある。落とさず読み飛ばす
      }
      if (msg === null || typeof msg !== 'object') continue;
      // 返事の中身（result / error）を持つものは、method があっても返事として読む（問いは result・error を持たない）
      const isReply = 'result' in msg || 'error' in msg;
      if (typeof msg.method === 'string' && !isReply) {
        /*
         * 相手からの問い（method を持つ）。番号は相手が振るので、こちらの問いの番号と重なることがある。
         * 返事として読むと、こちらの待ちを相手の問いで済ませていた（結果は空）。問いには答える: ping は空で返し、
         * ほかは「持っていない」で断る（名乗りで何の力も申し出ていないので、roots や sampling は来ない約束）。
         */
        if (msg.id !== undefined && msg.id !== null) this.#answer(msg.id, msg.method);
        continue;
      }
      if (typeof msg.id !== 'number') continue; // こちらからの問いへの返事だけを見る

      const pending = this.#pending.get(msg.id);
      if (!pending) continue;
      this.#pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error.message ?? '相手が断りました'));
      else pending.resolve(msg.result);
    }
  }

  /** `optional` の知らせ（取り消し）は、届かなくても失敗にしない。失敗にすると、同じ相手に出しているほかの呼び出しまで落ちる。 */
  #send(payload: unknown, optional = false, id?: number): void {
    if (this.#http) {
      const own = id === undefined ? undefined : new AbortController();
      if (own && id !== undefined) this.#streams.set(id, own);
      // 送れなかったことは、待っている呼び出しの側で（上限で）分かる。
      // ここで投げっぱなしにすると、拾い手が居ないままプロセスが落ちる。
      void this.#post(payload, optional, id, own?.signal).catch((e: unknown) => {
        // 自分で切った繋ぎ（止めた・時間切れ）の失敗は、失敗ではない
        if (own?.signal.aborted) return;
        if (!optional) this.#fail(`送れませんでした: ${e instanceof Error ? e.message : String(e)}`);
      }).finally(() => { if (id !== undefined && this.#streams.get(id) === own) this.#streams.delete(id); });
      return;
    }
    // 行区切りなので、中に改行を入れない。
    this.#child?.stdin?.write(`${JSON.stringify(payload)}\n`);
  }

  /**
   * 遠くの相手に繋ぐ。
   *
   * 立ち上げるものが無いので、失敗するのは**繋がらない**ときだけ。
   * そのときも投げない（一つ繋がらないだけで、他のツールまで止めない）。
   */
  async #startRemote(signal?: AbortSignal): Promise<boolean> {
    const headers: Record<string, string> = {};
    this.#missingHeaders.length = 0;
    for (const [name, from] of Object.entries(this.#spec.headersFrom ?? {})) {
      const value = process.env[from];
      if (value === undefined) {
        // 黙って見出し無しで繋がない。**どの名前が無かったかを言う。**
        this.#missingHeaders.push(from);
        continue;
      }
      // トークンは、そのまま渡すと通らない相手が多い。付いていなければ付ける。
      headers[name] = name.toLowerCase() === 'authorization' && !/^\S+\s/.test(value)
        ? `Bearer ${value}`
        : value;
    }
    this.#http = { url: this.#spec.url!, headers, open: true };
    this.#abort = signal;
    this.#serverVersion = undefined; // 名乗りには版を付けない（まだ取り決めていない）

    const timeout = this.#spec.startupTimeoutMs ?? 10_000;
    try {
      const init = await this.#call('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'AdaptiveAIStudio', version: '0.1.0' },
      }, timeout) as { protocolVersion?: string };
      this.#serverVersion = init?.protocolVersion;
      this.#notify('notifications/initialized', {});
      const listed = await this.#call('tools/list', {}, timeout) as { tools?: McpToolSpec[] };
      this.#tools = (listed?.tools ?? []).filter((t) => typeof t?.name === 'string');
      return true;
    } catch (e) {
      this.#failure = (e as Error).message;
      // 立ち上げの途中で stop() されると #http はもう無い。無いのに触ると、「投げない」はずの start() が TypeError を投げた
      if (this.#http) this.#http.open = false;
      return false;
    }
  }

  /**
   * 一つ送って、返ってきたものを、同じ読み口へ流す。
   *
   * 相手は JSON でも、流れ（SSE）でも返してくる。どちらも同じ形に均す。
   */
  async #post(payload: unknown, optional = false, id?: number, own?: AbortSignal): Promise<void> {
    const http = this.#http;
    if (!http) return;
    // 自分で切った繋ぎ（止めた・時間切れ）の失敗は、失敗にしない
    const fail = (reason: string) => { if (!optional && !own?.aborted) this.#fail(reason); };
    const signals = [own, this.#abort].filter((s): s is AbortSignal => s !== undefined);
    let res: Response;
    try {
      res = await fetch(http.url, {
        method: 'POST',
        headers: {
          ...http.headers,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(http.session ? { 'mcp-session-id': http.session } : {}),
          ...this.#versionHeader(),
        },
        body: JSON.stringify(payload),
        ...(signals.length > 0 ? { signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals) } : {}),
      });
    } catch (e) {
      fail(`繋がりません: ${(e as Error).message}`);
      return;
    }
    // 繋ぎの名前をもらったら、以後は付けて出す。付けないと毎回名乗り直しになる。
    const sid = res.headers.get('mcp-session-id');
    if (sid) http.session = sid;

    if (res.status === 202 || res.status === 204) return; // 知らせだけ。返事は無い
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      fail(`${res.status} ${res.statusText}${body ? `: ${body.slice(0, 300)}` : ''}`);
      return;
    }

    const type = res.headers.get('content-type') ?? '';
    if (type.includes('text/event-stream')) {
      await this.#readEvents(res, id);
      return;
    }
    const text = await res.text();
    for (const one of splitMessages(text)) this.#onData(`${one}\n`);
  }

  /** 流れ（SSE）を読む。`data:` の行だけを拾う。 */
  async #readEvents(res: Response, id?: number): Promise<void> {
    const body = res.body;
    if (!body) return;
    const reader = body.getReader();
    const dec = new StringDecoder('utf8');
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.write(Buffer.from(value));
      let at: number;
      while ((at = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, at).trimEnd();
        buf = buf.slice(at + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        for (const one of splitMessages(data)) this.#onData(`${one}\n`);
      }
      // この問いの返事が済んだら（問いの無い流れなら、待っているものが無くなったら）、そこで切り上げる。
      // 相手は流れを開いたままにすることがあり、待つと止まって見える。
      const settled = id === undefined ? this.#pending.size === 0 : !this.#pending.has(id);
      if (settled) { void reader.cancel().catch(() => undefined); break; }
    }
  }

  /**
   * 名乗りの後の問いに付ける、取り決めた版（2025-06-18 の決まり。付けないと相手は 2025-03-26 とみなす）。
   * 相手が返した文字列が見出しに使えない形なら付けない（fetch が見出しを受け付けず、以後の問いが全部失敗するため）。
   */
  #versionHeader(): Record<string, string> {
    const v: unknown = this.#serverVersion; // JSON から来た値なので、文字列とは限らない
    return typeof v === 'string' && /^[\w.-]{1,64}$/.test(v) ? { 'mcp-protocol-version': v } : {};
  }

  /**
   * 相手からの問いに答える。遠くの相手では、答えが届かなくても失敗にしない（こちらの問いには関わらない）。
   * 手元の相手では標準入力へ書くので、入力が閉じていれば EPIPE で相手ごと止める（取り消しの知らせと同じ。閉じた相手には何も届かない）。
   */
  #answer(id: number | string, method: string): void {
    const reply = method === 'ping'
      ? { jsonrpc: '2.0', id, result: {} }
      : { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
    this.#send(reply, true);
  }

  #notify(method: string, params: unknown, optional = false): void {
    this.#send({ jsonrpc: '2.0', method, params }, optional);
  }

  /**
   * 一つ訊いて、返事を待つ。`signal` で止めたら、待ちを片づけて `STOPPED` で返し、相手へ `notifications/cancelled` を送る。
   * 知らせないと、相手は止めた仕事（外への書き込み・重い検索）を最後まで続ける。遅れて届いた返事は、待ちが無いので捨てられる。
   */
  #call(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    const id = ++this.#seq;
    return new Promise<unknown>((resolve, reject) => {
      const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
      const onAbort = () => {
        if (!this.#pending.delete(id)) return;
        done();
        // reason は相手の記録に残る機械向けの文。日本語を置かない
        this.#notify('notifications/cancelled', { requestId: id, reason: 'cancelled by user' }, true);
        this.#streams.get(id)?.abort(); // 返事の流れを閉じる（取り消しを送った後に切る）
        resolve(STOPPED);
      };
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        done();
        this.#streams.get(id)?.abort();
        reject(new Error(`${timeoutMs}ms で返事がありませんでした（${method}）`));
      }, timeoutMs);
      timer.unref?.();

      this.#pending.set(id, {
        resolve: (v) => { done(); resolve(v); },
        reject: (e) => { done(); reject(e); },
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#send({ jsonrpc: '2.0', id, method, params }, false, id);
    });
  }
}

/**
 * 止めた相手が SIGTERM を無視しても残さない。`KILL_GRACE_MS` 待って終わっていなければ SIGKILL を送る。
 * SIGTERM だけだと、無視する相手はこちらが手を放した後も生き続けた（`#child` を外すので、後から止める手も無い）。
 */
function endChild(child: ChildProcess): void {
  child.kill();
  if (child.exitCode !== null || child.signalCode !== null) return;
  const hard = setTimeout(() => { child.kill('SIGKILL'); }, KILL_GRACE_MS);
  hard.unref();
  child.once('exit', () => clearTimeout(hard));
}

/** SIGTERM から SIGKILL までの猶予。後始末（記録の書き出し等）に足りる長さ。 */
export const KILL_GRACE_MS = 3_000;

/** `#call` を止めたときの返り。相手の返事と取り違えないよう、ほかに無い値にする。 */
const STOPPED: unique symbol = Symbol('stopped');

/**
 * 返ってきたものを、一つずつの JSON にほどく。
 *
 * 相手は一つで返すことも、まとめて（配列で）返すこともある。
 * ほどかないと、まとめて返された回だけ**全部落とす**ことになる。
 */
function splitMessages(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) return parsed.map((x) => JSON.stringify(x));
    return [JSON.stringify(parsed)];
  } catch {
    // 読めないものは、そのまま渡して読み口の側で捨てさせる。
    return [trimmed];
  }
}
