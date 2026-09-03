/**
 * 画面を出すための入れ物。
 *
 * 外に公開するものではない。手元の一台のためだけに立てる。
 * だから待つのは 127.0.0.1 だけで、認証も暗号化も入れない。
 * 入れないのではなく、**外に出さないから要らない**。
 *
 * 枠組み（React など）も持ち込まない。
 * この場所は「何年も動き続ける」ことを目的にしているので、
 * 数年で作法が変わるものに画面を預けたくない。
 * 素の HTML と ES モジュールなら、組み立ての手順すら要らない。
 */
import { listDir } from './files.ts';
import { Conversations, ID_SHAPE } from '../core/conversations.ts';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname, extname, normalize, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateDir } from '../core/autopilot-setup.ts';
import { aasHome, binDir, modelsDir, isPortable, productRoot } from '../core/home.ts';
import { currentVersion, describeVersion } from '../core/version.ts';
import { checkUpdate, applyUpdate } from '../core/update.ts';
import { findInstalled } from '../runtime/llama-install.ts';
import { findNewerOllama, findNewerGguf } from '../runtime/model-updates.ts';
import { AVAILABLE_MODELS, lookupCatalog } from '../runtime/model-catalog.ts';
import { installModel } from '../runtime/model-install.ts';
import { buildRuntime } from '../core/runtime-setup.ts';
import { MachineCache } from '../runtime/machine.ts';
import { usesGguf, type LocalRuntime } from '../runtime/local-runtime.ts';
import { pullModel } from '../runtime/ollama-pull.ts';
import { repairLayout, preset, PRESETS, PANEL_KINDS, type Layout } from './layout.ts';
import { repairTheme, baseTheme, THEMES, TOKENS, toCssVars, type Theme } from './theme.ts';
import { collectState } from './state.ts';
import { Attachments, MAX_BYTES } from './attachments.ts';
import { PreviewServer } from './preview.ts';
import { configPath, type AasConfig } from '../config.ts';
import { TaskRunner } from './tasks.ts';
import { describeServers } from '../mcp/tools.ts';
import { listenOrExplain } from '../core/listen.ts';
import { crossSiteReason } from './origin.ts';
import {
  RUNTIME_KINDS, KIND_LABELS, isRuntimeKind, readSavedRuntime, saveRuntime,
  inspectModelsDir, ensureDefaultModelsDir, savedModelsDir,
} from './settings.ts';
import { listGguf, tooBigForRam, looksLikeGguf } from '../runtime/inproc.ts';
import { totalmem } from 'node:os';
import { Session } from '../core/session.ts';
import type { ApprovalRequest } from '../agent/tools/types.ts';

/**
 * 画面から回せる点検。
 *
 * 立ち上げたあとは cmd の窓が塞がるので、そこでしか見られないものがあった。
 * **窓は入口であって、道具ではない。**道具は画面側に置く。
 *
 * ここに書いた名前だけを受け取る。package.json の scripts をそのまま
 * 実行できる作りにすると、書き換えた者が何でも走らせられる口になる。
 */
const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), 'web');
const LAYOUT_PATH = () => join(stateDir(), 'layout.json');
// 配置と見た目は分けて持つ。「配置はそのままで色だけ変えたい」が一番多いから。
const THEME_PATH = () => join(stateDir(), 'theme.json');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/**
 * 立ち上げ直したいときの終了コード。
 *
 * 画面から「立ち上げ直す」を押したら、この番号で終わる。start.cmd は
 * この番号を見たら、もう一度同じものを起こす。番号は他の失敗と
 * ぶつからないものにしてある（75 = 一時的な失敗、の慣例）。
 */
export const RESTART_EXIT = 75;

/** 一つの画面に溜めてよい未送信の量。超えたら、その相手は読んでいない。 */
export const MAX_CLIENT_BACKLOG = 4 * 1024 * 1024;

export interface UiServerOptions {
  /** 立ち上げ直しを頼まれたとき。止めて、RESTART_EXIT で終わる側が持つ。 */
  onRestart?: () => void;
  /** 入口（start.cmd）が起こし直してくれるか。画面の案内が変わる。 */
  relaunches?: boolean;
  /** モデルを読むライブラリの差し替え。試験で使う。 */
  inprocLoad?: () => Promise<unknown>;
  config: AasConfig;
  port?: number;
  host?: string;
}

/** 画面へ流す出来事。CLI 側から呼んで、動いているものを見せる。 */
export type UiEvent =
  | { type: 'log'; level: 'info' | 'warn' | 'error'; text: string }
  | { type: 'plan'; items: unknown[] }
  | { type: 'stateChanged' }
  | { type: 'themeChanged' }
  /** 対話の出来事。そのまま画面へ流す。 */
  | { type: 'session'; event: unknown }
  /** 承認待ち。答えが来るまで作業は止まっている。 */
  | { type: 'approval'; id: string; request: ApprovalRequest }
  | { type: 'approvalDone'; id: string; approved: boolean }
  | { type: 'busy'; busy: boolean }
  /** 順番待ちの数。0 なら空。 */
  | { type: 'queue'; waiting: number }
  /** 会話の一覧が変わった。画面は取り直す。 */
  | { type: 'conversations' }
  /** 暇なときの考えごと。送りは止めないが、動いていることは見せる。 */
  | { type: 'musing'; on: boolean }
  /** 分解して並列に働かせているときの出来事。 */
  | { type: 'planEvent'; event: unknown }
  /** 暇なときに考えたこと。放っておいても動いていることが見える。 */
  | { type: 'thinkEvent'; event: unknown }
  /** 点検の出来事。cmd の窓でしか見られなかったものを、画面へ出す。 */
  | { type: 'task'; name: string; text: string }
  | { type: 'taskDone'; name: string; code: number };

export class UiServer {
  readonly #opts: UiServerOptions;
  readonly #clients = new Set<ServerResponse>();
  #server?: ReturnType<typeof createServer>;
  /** 点検を回す係。状態（走っている子）はそちらが持つ。 */
  readonly #tasks = new TaskRunner({
    root: join(dirname(WEB_DIR), '..', '..'),
    onEvent: (e) => {
      this.broadcast(e.text !== undefined
        ? { type: 'task', name: e.name, text: e.text }
        : { type: 'taskDone', name: e.name, code: e.code ?? 1 });
    },
  });
  #url = '';
  #session?: Session;
  /**
   * 順番待ち。動いている間に書かれたものを、ここに積む。
   *
   * 断って書き直させない。利用者は「終わったらこれをやって」と
   * 思って書いているので、預かって順に流すのが素直。
   */
  readonly #queue: Array<{ text: string; attached: string[] }> = [];
  /**
   * 残してある会話。**窓を閉じても消えないように。**
   * ここまでメモリの中だけだったので、立ち上げ直すと無かったことになっていた。
   */
  readonly #conversations = new Conversations(join(stateDir(), 'conversations'));
  /** いま話している会話。最初の依頼のときに決まる。 */
  #conversationId?: string;
  /** どこまで残したか。ここから先を足す。 */
  #saved = 0;
  #idleTimer?: ReturnType<typeof setInterval>;
  #thinking = false;
  /**
   * 受け付けてから走り出すまでの間。
   *
   * `session.busy` を見てから実際に走り出すまでに、モデルの読み込みで
   * 数十秒空くことがある。その間はまだ busy ではないので、二つ目の
   * 依頼が**同じ関門を通り抜ける**。押しても何も起きないように見えて、
   * 実は二つ走っている。見てから走り出すまでを、ここで塞ぐ。
   */
  #preparing = false;
  /** モデルの土台。要るときに一度だけ組み立てる。 */
  #runtime?: LocalRuntime;
  /** 承認待ちの返事先。画面が答えるまで、ここで待っている。 */
  readonly #pending = new Map<string, (ok: boolean) => void>();
  /** 渡されたファイルの預かり所。 */
  readonly #attachments = new Attachments();
  /** 作っているものを見せる口。操作用とは**別の口**にする。 */
  #preview?: PreviewServer;
  #seq = 0;

  constructor(opts: UiServerOptions) {
    this.#opts = opts;
  }

  get url(): string { return this.#url; }

  /** 画面へ流す。誰も見ていなくても落ちない。 */
  broadcast(event: UiEvent): void {
    const line = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of this.#clients) {
      // 読まない相手に溜め続けない。閉じたタブや固まった頁があると、
      // その分の出来事が本体の記憶に積み上がる。4MB 溜まったら切る。
      if (res.writableLength > MAX_CLIENT_BACKLOG) {
        this.#clients.delete(res);
        try { res.destroy(); } catch { /* もう切れている */ }
        continue;
      }
      try { res.write(line); } catch { this.#clients.delete(res); }
    }
  }

  /** 繋がっている画面の数。読まない相手を切ったことを検査で見るため。 */
  get clientCount(): number { return this.#clients.size; }

  async start(): Promise<string> {
    const host = this.#opts.host ?? '127.0.0.1';
    const port = this.#opts.port ?? 4174;
    const server = createServer((req, res) => {
      this.#handle(req, res).catch((e: unknown) => {
        // 画面の不具合で本体を落とさない。
        if (e instanceof BodyTooLarge) return send(res, 413, { error: e.message });
        send(res, 500, { error: e instanceof Error ? e.message : String(e) });
      });
    });
    this.#server = server;

    // 0 を渡すと空いている口を選ぶ。実際に決まった番号を使う。
    // 塞がっていたら、番号だけでなく**次の一手**まで言う。
    const actual = await listenOrExplain(server, { port, host, what: '画面' });
    this.#url = `http://${host}:${actual}/`;
    // 前に渡された添付を片づける。その依頼が終われば要らない。
    // 溜めない。消したら、消した量を言う（黙って消さない）。
    void this.#attachments.sweep().then((freed) => {
      if (freed > 0) this.broadcast({ type: 'log', level: 'info', text: `前の添付を片づけました（${Math.round(freed / 1024)} KB）` });
    }).catch(() => undefined);
    return this.#url;
  }

  /**
   * 対話の本体を用意する。
   * 承認は画面へ投げて、答えが返るまで待つ。
   * 誰も見ていない画面へ投げっぱなしにならないよう、待ち時間には上限を置く。
   */
  async session(): Promise<Session> {
    if (this.#session) return this.#session;
    this.#session = await Session.create(await this.#configForSession(), {
      approve: (req) => this.#ask(req),
      onLog: (level, text) => this.broadcast({ type: 'log', level, text }),
    });
    // 続きから話す。**土台は作り直しても、話は続ける。**
    const id = await this.#currentConversation();
    const past = await this.#conversations.load(id);
    this.#session.restore(past);
    this.#saved = past.length;
    this.#startThinking(this.#session);
    return this.#session;
  }

  /**
   * 会話の土台に渡す設定。
   *
   * この中で読む道では、**いま読んでいるものを、そのまま候補にする。**
   * 名前から規模を当てる仕組みしか無いと、`tiny.gguf` のような名前で
   * 「使えるモデルがありません」と言って 500 で止まる（実際に止まった）。
   * 読めている以上、使えるかどうかを名前で決め直す必要はない。
   */
  async #configForSession(): Promise<AasConfig> {
    const config = this.#opts.config;
    if (config.candidates && config.candidates.length > 0) return config;
    if ((config.runtime?.kind ?? 'ollama') !== 'inproc') return config;
    const loaded = this.#runtime?.id === 'inproc' ? this.#runtime.loaded() : [];
    const ref = loaded[0];
    if (!ref) return config;
    return { ...config, candidates: [ref] };
  }

  /**
   * いま話している会話。
   *
   * 立ち上げ直した直後は、**いちばん新しいものを続きとして開く。**
   * 毎回まっさらから始めると、閉じただけで話が消えたように見える。
   * 一つも無ければ、そこで作る。
   */
  async #currentConversation(): Promise<string> {
    if (this.#conversationId) return this.#conversationId;
    const [newest] = await this.#conversations.list();
    if (newest) {
      this.#conversationId = newest.id;
      this.#saved = (await this.#conversations.load(newest.id)).length;
      return this.#conversationId;
    }
    this.#conversationId = (await this.#conversations.create()).id;
    this.#saved = 0;
    return this.#conversationId;
  }

  /**
   * 済んだ分を残す。
   *
   * **一往復ごとに書く。**終わりにまとめて書くと、途中で落ちたときに
   * その回のやりとりが丸ごと消える。道具の呼び出しと結果も残す
   * （続きを話すときに、その対応が要る）。
   */
  async #persist(session: Session): Promise<void> {
    const id = await this.#currentConversation();
    const fresh = session.history.slice(this.#saved);
    if (fresh.length === 0) return;
    await this.#conversations.append(id, fresh).catch((e: unknown) => {
      this.broadcast({ type: 'log', level: 'error', text: `会話を残せませんでした: ${(e as Error).message}` });
    });
    this.#saved = session.history.length;
    const firstAsked = fresh.find((m) => m.role === 'user');
    if (firstAsked) await this.#conversations.titleIfUnset(id, firstAsked.content).catch(() => undefined);
    this.broadcast({ type: 'conversations' });
  }

  /**
   * 暇なら考える。
   *
   * 画面を開いたまま席を立っても、この場所は動き続ける。
   * 何を考えるかも、考えてよいかも、核の中のスケジューラが決める。
   * ここがやるのは「そろそろどうか」と声をかけることだけ。
   */
  #startThinking(session: Session): void {
    const cfg = this.#opts.config.initiative ?? {};
    if (cfg.enabled === false) return;
    const every = Math.max(5, cfg.idleSeconds ?? 30) * 1000;

    this.#idleTimer = setInterval(() => { void this.idleTick(session); }, every);
    this.#idleTimer.unref?.();
  }

  /** モデルが無くて考えられなかったとき、次に試すまで待つ間。 */
  #idleHoldUntil = 0;

  /**
   * 暇なときの一回分。
   *
   * 何をしたかを符丁で返す（検査で見るため）。
   *   BUSY     作業中か支度中。人の依頼が先
   *   HELD     前にモデルが無かったので、しばらく試さない
   *   MISSING  モデルが無い。次はしばらく試さない
   *   THOUGHT  考えた（考えなかったことも含む。決めるのは中のスケジューラ）
   *
   * **考える前に、モデルの支度をする。**この中で読む道では、読むまで口が
   * 立たない。支度せずに考えに行くと、30秒ごとに「繋がりません」を作る。
   */
  async idleTick(session: Session): Promise<'BUSY' | 'HELD' | 'MISSING' | 'THOUGHT'> {
    // 作業中は考えない。人の依頼が先。支度の最中も、人の依頼のうち。
    if (this.#busyNow(session)) return 'BUSY';
    // **順番待ちがあるなら、暇ではない。**ここで考え始めると、
    // 待っている依頼が、その分だけ後ろへ押しやられる。
    if (this.#queue.length > 0) { void this.#maybeDrain(); return 'BUSY'; }
    if (Date.now() < this.#idleHoldUntil) return 'HELD';
    this.#preparing = true;
    try {
      const missing = await this.#readyToThink();
      if (missing) {
        // 10分は黙る。30秒ごとに同じことを言われても、置き場は変わらない。
        this.#idleHoldUntil = Date.now() + 10 * 60_000;
        return 'MISSING';
      }
      this.#thinking = true;
      // 暇なときの考えごとも、動いていることに変わりはない。**黙って動かない。**
      // ただし送りは止めない（人の依頼はいつでも受ける）。
      this.broadcast({ type: 'musing', on: true });
      try {
        for await (const event of session.think()) {
          this.broadcast({ type: 'thinkEvent', event });
        }
      } catch { /* 考えに失敗しても、この場所は止まらない */ }
      return 'THOUGHT';
    } finally {
      this.#thinking = false;
      this.#preparing = false;
      this.broadcast({ type: 'musing', on: false });
      // **手が空いたら、待っているものを流す。**
      // ここを忘れると、考えごとの最中に来た依頼が、誰にも拾われない。
      await this.#maybeDrain();
    }
  }

  /** 手が空いていて、待っているものがあれば流す。 */
  async #maybeDrain(): Promise<void> {
    const session = this.#session;
    if (!session || this.#queue.length === 0) return;
    if (this.#busyNow(session)) return;
    await this.#drainQueue(session);
  }

  #ask(req: ApprovalRequest): Promise<boolean> {
    const approval = this.#opts.config.agent?.approval ?? 'autoEdit';
    // 協議は自動承認の対象にしない。重大な変更は必ず人の目を通す。
    if (approval === 'auto' && req.kind !== 'deliberation') return Promise.resolve(true);
    if (approval === 'autoEdit' && req.kind === 'write') return Promise.resolve(true);

    const id = `a${++this.#seq}`;
    return new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        this.#pending.delete(id);
        this.broadcast({ type: 'approvalDone', id, approved: ok });
        resolve(ok);
      };
      this.#pending.set(id, finish);
      this.broadcast({ type: 'approval', id, request: req });
      // 誰も答えないまま待ち続けない。返事が無いことは、許可ではない。
      const timer = setTimeout(() => finish(false), 10 * 60_000);
      timer.unref?.();
    });
  }

  async stop(): Promise<void> {
    if (this.#idleTimer) clearInterval(this.#idleTimer);
    // 待っている承認は、答えが無いまま終わる。許可はしない。
    for (const finish of this.#pending.values()) finish(false);
    this.#pending.clear();
    await this.#session?.close().catch(() => undefined);
    // 自分の中に立てた口（inproc）も閉じる。閉じないと、画面を止めても
    // プロセスが生き続ける（検査が終わらないことで気づいた）。
    const runtime = this.#runtime as { shutdown?: () => Promise<void> } | undefined;
    await runtime?.shutdown?.().catch(() => undefined);
    this.#runtime = undefined;
    for (const res of this.#clients) { try { res.end(); } catch { /* 切れている */ } }
    this.#clients.clear();
    await new Promise<void>((resolve) => this.#server?.close(() => resolve()) ?? resolve());
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    // よその頁から叩かれた要求は、口に入る前に断る。中身は読まない。
    if (path.startsWith('/api/')) {
      const refused = crossSiteReason(req.headers, req.method ?? 'GET', {
        ownHosts: this.#opts.host ? [this.#opts.host] : [],
      });
      if (refused) return send(res, 403, { error: refused });
    }

    if (path === '/api/layout' && req.method === 'GET') {
      const { layout, repairs } = await loadLayout();
      return send(res, 200, { layout, repairs, presets: PRESETS.map((p) => ({ id: p.id, name: p.name })), kinds: PANEL_KINDS });
    }

    if (path === '/api/layout' && req.method === 'PUT') {
      const body = await readBody(req);
      // 送られてきた配置も必ず直してから保存する。
      // 壊れたまま保存すると、次の起動で画面が出なくなる。
      const { layout, repairs } = repairLayout(body);
      await saveLayout(layout);
      this.broadcast({ type: 'stateChanged' });
      return send(res, 200, { layout, repairs });
    }

    if (path === '/api/layout/preset' && req.method === 'POST') {
      const body = await readBody(req) as { id?: string };
      const layout = preset(String(body?.id ?? ''));
      await saveLayout(layout);
      this.broadcast({ type: 'stateChanged' });
      return send(res, 200, { layout, repairs: [] });
    }

    // 渡されたファイルを預かる。
    // 中身はそのまま body に流す（多分割の解析器を持ち込まないため。
    // 名前は問い合わせ部分で渡す）。
    // 見る口の場所。まだ立ち上げていなければ、ここで立ち上げる。
    // 使わない人のために口を開けっぱなしにしない。
    if (path === '/api/preview' && req.method === 'GET') {
      const session = await this.session();
      if (!this.#preview) {
        this.#preview = new PreviewServer({ root: session.root });
        await this.#preview.start();
      }
      return send(res, 200, { url: this.#preview.url, root: session.root });
    }

    if (path === '/api/attach' && req.method === 'POST') {
      const name = url.searchParams.get('name') ?? 'file';
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of req) {
        total += (chunk as Buffer).length;
        // 上限を超えたら、最後まで受け取ってから断らない。読むのをやめる。
        if (total > MAX_BYTES) {
          req.destroy();
          return send(res, 413, { error: `大きすぎます（${MAX_BYTES / 1024 / 1024}MB まで）` });
        }
        chunks.push(chunk as Buffer);
      }
      try {
        const item = await this.#attachments.add(name, Buffer.concat(chunks));
        return send(res, 200, {
          id: item.id, name: item.name, bytes: item.bytes, kind: item.kind,
        });
      } catch (e) {
        return send(res, 400, { error: (e as Error).message });
      }
    }

    if (path === '/api/attach' && req.method === 'DELETE') {
      const id = url.searchParams.get('id') ?? '';
      return send(res, 200, { dropped: await this.#attachments.drop(id) });
    }

    if (path === '/api/send' && req.method === 'POST') {
      const body = await readBody(req) as { text?: string; attachments?: unknown };
      const text = typeof body?.text === 'string' ? body.text.trim() : '';
      const attached = Array.isArray(body?.attachments)
        ? body.attachments.filter((a): a is string => typeof a === 'string')
        : [];
      if (!text && attached.length === 0) return send(res, 400, { error: '指示が空です' });

      // **モデルの有無を、いちばん先に見る。**
      // 会話の土台を組む段でも候補を決めるので、モデルが無いと
      // そこで落ちて 500 になる。利用者には「サーバの不具合」に見えるが、
      // 実際は「まだ置いていない」だけ。順番を逆にすると、そう言えなくなる。
      this.#preparing = true;
      try {
        const notReady = await this.#readyToThink();
        if (notReady) return send(res, 503, { error: notReady });
      } finally {
        this.#preparing = false;
      }

      const session = await this.session();
      // **断らない。**書いたものを突き返されるのがいちばん不快で、
      // しかも書き直させることになる。動いている間は順番に積む。
      if (this.#busyNow(session)) {
        this.#queue.push({ text, attached });
        this.broadcast({ type: 'queue', waiting: this.#queue.length });
        return send(res, 202, { queued: this.#queue.length });
      }

      this.#preparing = true;
      try {

        // 添付は依頼の前に置く。後ろに置くと、長い中身のせいで
        // 肝心の指示が末尾に押しやられて、モデルが取りこぼす。
        const extra = attached.length > 0 ? await this.#attachments.describe(attached) : '';
        const full = extra ? `${extra}\n\n${text}` : text;

        // 受け取ったことだけ先に返し、続きは出来事として流す。
        send(res, 202, { accepted: true });
        void this.#drive(session, full);
      } finally {
        this.#preparing = false;
      }
      return;
    }

    if (path === '/api/plan' && req.method === 'POST') {
      const body = await readBody(req) as { text?: string };
      const text = typeof body?.text === 'string' ? body.text.trim() : '';
      if (!text) return send(res, 400, { error: '依頼が空です' });

      const session = await this.session();
      if (this.#busyNow(session)) return send(res, 409, { error: 'いま別の作業をしています' });

      this.#preparing = true;
      try {
        // **先に確かめる。**モデルが無いまま送ると、繋ぎ先を待ち続けて
        // 画面は「考え中」のまま止まる。利用者からは固まったようにしか見えない。
        const missing = await this.#readyToThink();
        if (missing) return send(res, 503, { error: missing });

        send(res, 202, { accepted: true });
        void this.#drivePlan(session, text);
      } finally {
        this.#preparing = false;
      }
      return;
    }

    if (path === '/api/proposals' && req.method === 'GET') {
      const session = await this.session();
      return send(res, 200, {
        open: session.proposals.open(),
        duties: session.duties.status(Date.now()),
        due: session.duties.due(Date.now()).map((d) => d.duty.codename),
        idle: session.idle.stats(),
        spent: session.idle.spentThisHour(Date.now()),
      });
    }

    if (path === '/api/proposal' && req.method === 'POST') {
      const body = await readBody(req) as { id?: string; verdict?: string };
      const verdict = body?.verdict === 'rejected' ? 'rejected' as const : 'accepted' as const;
      const session = await this.session();
      const target = await session.decide(String(body?.id ?? ''), verdict);
      if (!target) return send(res, 404, { error: 'その提案は見つかりません' });
      this.broadcast({ type: 'stateChanged' });
      // 採用したなら、その内容をそのまま依頼として流す。
      if (verdict === 'accepted' && !this.#busyNow(session)) void this.#drive(session, target.suggestedAction);
      return send(res, 200, { proposal: target });
    }

    // 更新は「見てから押す」の2段。押した瞬間に取ってくると、
    // 何が入るのか分からないまま新しくなる。
    // モデルの面倒。端末でしかできない状態だと、
    // 画面から使う人はモデルを用意することも乗り換えることもできない。
    if (path === '/api/models' && req.method === 'GET') {
      const session = await this.session();
      const runtime = await this.#localRuntime();
      const [installed, llama] = await Promise.all([
        runtime.list().catch(() => []),
        findInstalled(),
      ]);
      return send(res, 200, {
        runtime: runtime.id,
        installed: installed.map((m) => ({ ref: m.ref, sizeBytes: m.sizeBytes })),
        llamaServer: llama ?? null,
        // どこを見ているか。「置いたのに出ない」を、画面の上で切り分けられる。
        modelsDir: this.#opts.config.runtime?.modelsDir ?? modelsDir(),
        catalog: AVAILABLE_MODELS.map((m) => ({
          id: m.id, note: m.note, approxGB: m.approxGB,
          // GGUF を自分で置く道（llamacpp / inproc）では、置き場に入れる元を出す。
          // Ollama の名前を出しても、そちらでは使えない。
          ref: runtime.id === 'ollama' ? m.ollama : m.repo,
        })),
      });
    }

    if (path === '/api/models/newer' && req.method === 'GET') {
      const session = await this.session();
      const runtime = await this.#localRuntime();
      const installed = (await runtime.list().catch(() => [])).map((m) => m.ref);
      if (installed.length === 0) return send(res, 200, { findings: [] });
      try {
        // GGUF の名前で Ollama に訊いても、何も出ない。置き場に合わせて訊く先を変える。
        const findings = usesGguf(runtime.id)
          ? await findNewerGguf({ installed })
          : await findNewerOllama({ installed });
        return send(res, 200, { findings });
      } catch (e) {
        return send(res, 502, { error: e instanceof Error ? e.message : String(e) });
      }
    }

    if (path === '/api/models/get' && req.method === 'POST') {
      const session = await this.session();
      if (this.#busyNow(session)) return send(res, 409, { error: 'いま作業中です。終わってからにしてください' });
      const body = await readBody(req) as { id?: string };
      const id = String(body?.id ?? '');
      if (!id) return send(res, 400, { error: '名前がありません' });

      // 数GBかかるので、待たせずに始めて、進み具合は流し込む。
      void this.#fetchModel(session, id);
      return send(res, 202, { started: id });
    }

    if (path === '/api/update' && req.method === 'GET') {
      return send(res, 200, await checkUpdate((await this.session()).root));
    }

    if (path === '/api/update' && req.method === 'POST') {
      const session = await this.session();
      // 作業中に足元のコードを入れ替えない。
      if (this.#busyNow(session)) return send(res, 409, { error: 'いま作業中です。終わってから更新してください' });
      const result = await applyUpdate(session.root);
      return send(res, result.ok ? 200 : 409, result);
    }

    if (path === '/api/think' && req.method === 'POST') {
      const session = await this.session();
      if (this.#busyNow(session)) return send(res, 409, { error: 'いま別の作業をしています' });
      send(res, 202, { accepted: true });
      this.#thinking = true;
      void (async () => {
        try {
          for await (const event of session.think()) this.broadcast({ type: 'thinkEvent', event });
        } catch { /* 考えに失敗しても止まらない */ } finally {
          this.#thinking = false;
          this.broadcast({ type: 'stateChanged' });
        }
      })();
      return;
    }

    if (path === '/api/abort' && req.method === 'POST') {
      this.#session?.abort();
      return send(res, 200, { ok: true });
    }

    if (path === '/api/approve' && req.method === 'POST') {
      const body = await readBody(req) as { id?: string; approved?: boolean };
      const resolveIt = this.#pending.get(String(body?.id ?? ''));
      if (!resolveIt) return send(res, 404, { error: 'その承認は既に終わっています' });
      resolveIt(body?.approved === true);
      return send(res, 200, { ok: true });
    }

    if (path === '/api/theme' && req.method === 'GET') {
      const { theme, repairs } = await loadTheme();
      return send(res, 200, {
        theme, repairs, vars: toCssVars(theme), tokens: TOKENS,
        themes: THEMES.map((t) => ({ id: t.id, name: t.name, scheme: t.scheme })),
      });
    }

    if (path === '/api/theme' && req.method === 'PUT') {
      const { theme, repairs } = repairTheme(await readBody(req));
      await saveTheme(theme);
      this.broadcast({ type: 'themeChanged' });
      return send(res, 200, { theme, repairs, vars: toCssVars(theme) });
    }

    if (path === '/api/theme/preset' && req.method === 'POST') {
      const body = await readBody(req) as { id?: string };
      const theme = baseTheme(String(body?.id ?? ''));
      await saveTheme(theme);
      this.broadcast({ type: 'themeChanged' });
      return send(res, 200, { theme, repairs: [], vars: toCssVars(theme) });
    }

    if (path === '/api/config' && req.method === 'GET') {
      // **保存してあるもの**を読む。立ち上げたときのものを見せると、
      // 保存した直後に古い値が出て「効いていない」ように見える。
      const saved = await readSavedRuntime();
      const active = this.#opts.config.runtime ?? {};
      // 書いてあるものが無ければ、いま読み込んだ既定（設定が無ければ inproc）を見せる。
      // ここだけ 'ollama' と決め打つと、既定で動いているものと画面の表示が食い違う。
      const kind = String(saved.kind ?? this.#opts.config.runtime?.kind ?? 'ollama');
      const dir = await savedModelsDir();
      return send(res, 200, {
        path: configPath(),
        kinds: RUNTIME_KINDS.map((id) => ({ id, name: KIND_LABELS[id] })),
        kind,
        modelsDir: dir,
        // 使うと決めた GGUF。無ければ置き場の最初の一つを読む。
        model: typeof saved.model === 'string' ? saved.model : null,
        // いま動いているもの。保存したものと違えば、立ち上げ直しが要る。
        active: { kind: active.kind ?? 'ollama', modelsDir: active.modelsDir ?? modelsDir() },
        restartNeeded: kind !== (active.kind ?? 'ollama')
          || dir !== (active.modelsDir ?? modelsDir()),
        // 置き場にある GGUF。「置いたのに認識しない」を画面で確かめられるように。
        // 記憶に載らないものは、載らないと添える。読む前に分かるように。
        gguf: await Promise.all((await listGguf(dir)).map(async (m) => ({
          ...m,
          tooBig: tooBigForRam(m.sizeBytes, totalmem()) ?? null,
          // 名前だけ .gguf の別物も、一覧で分かるように。
          notGguf: !(await looksLikeGguf(join(dir, m.ref))),
        }))),
        // GGUF が0件のとき、置き場そのものが無いのか、空なのかで打つ手が違う。
        dirState: await inspectModelsDir(dir),
      });
    }

    if (path === '/api/config' && req.method === 'PUT') {
      const body = await readBody(req) as { kind?: string; modelsDir?: string; model?: string };
      const kind = body?.kind;
      if (!isRuntimeKind(kind)) return send(res, 400, { error: 'そういう動かし方はありません' });
      const dir = typeof body?.modelsDir === 'string' ? body.modelsDir.trim() : '';
      // 使う GGUF。名前に道を混ぜさせない（置き場の中の名前だけ）。
      const model = typeof body?.model === 'string' ? body.model.trim() : undefined;
      if (model && /[\\/]/.test(model)) return send(res, 400, { error: 'モデルは置き場の中の名前で指定してください' });
      // 打った場所は見るだけ。既定の場所は、無ければ作る。
      // 「GGUF を置くだけ」と言っておいて置き場が無いのは、案内になっていない。
      const dirState = dir
        ? await inspectModelsDir(dir)
        : await ensureDefaultModelsDir(modelsDir());
      const at = await saveRuntime(kind, dir, model);
      this.broadcast({ type: 'log', level: 'info', text: `設定を書きました: ${at}` });
      return send(res, 200, {
        path: at,
        saved: { kind, modelsDir: dir || null, ...(model !== undefined ? { model: model || null } : {}) },
        // 打ち間違えても保存はできる。だから**保存したときに言う。**
        dirState,
        // 動かし方の切り替えは、立ち上げ直すまで効かない。黙って効いた顔をしない。
        restartNeeded: kind !== (this.#opts.config.runtime?.kind ?? 'ollama')
          || (dir || modelsDir()) !== (this.#opts.config.runtime?.modelsDir ?? modelsDir())
          || (model !== undefined && (model || undefined) !== this.#opts.config.runtime?.model),
      });
    }

    if (path === '/api/info' && req.method === 'GET') {
      // cmd の窓でしか見られなかったものを、画面から見られるようにする。
      // 版が分からないまま検証すると、古いものを新しいと思って確かめてしまう。
      const v = await currentVersion();
      return send(res, 200, {
        version: describeVersion(v),
        node: process.version,
        platform: `${process.platform} ${process.arch}`,
        portable: isPortable(),
        productRoot: productRoot(),
        home: aasHome(),
        stateDir: stateDir(),
        modelsDir: modelsDir(),
        binDir: binDir(),
        url: this.#url,
        runtime: this.#opts.config.runtime?.kind ?? '未設定',
        // 外の道具（MCP）。繋がらなかったものを黙らせない。
        mcp: this.#session
          ? describeServers(this.#session.mcpClients)
          : '（最初の依頼のときに立ち上がります）',
        // 決めていなくても、この中で読んでいるなら「いま読んでいるもの」を出す。
        // 「—」だけだと、動いているのに何も無いように見える。
        model: this.#opts.config.runtime?.model
          ?? (this.#runtime?.id === 'inproc' ? this.#runtime.loaded()[0] : undefined)
          ?? '—',
      });
    }

    if (path === '/api/restart' && req.method === 'POST') {
      const session = this.#session;
      if (session && this.#busyNow(session)) {
        return send(res, 409, { error: 'いま作業中です。終わってから立ち上げ直してください' });
      }
      if (!this.#opts.onRestart) return send(res, 501, { error: 'この入口からは立ち上げ直せません' });
      const relaunches = this.#opts.relaunches === true;
      this.broadcast({ type: 'log', level: 'info', text: '立ち上げ直します' });
      send(res, 200, { restarting: true, relaunches });
      // 返事を出し切ってから止める。先に止めると、押した側に何も返らない。
      setTimeout(() => this.#opts.onRestart?.(), 200).unref?.();
      return;
    }

    if (path === '/api/tasks' && req.method === 'GET') {
      return send(res, 200, { tasks: TaskRunner.list(), running: this.#tasks.running ?? null });
    }

    if (path === '/api/task' && req.method === 'POST') {
      const body = await readBody(req) as { name?: string };
      const name = String(body?.name ?? '');
      const refused = this.#tasks.start(name);
      if (refused) return send(res, refused.includes('ありません') ? 400 : 409, { error: refused });
      return send(res, 200, { started: name });
    }

    if (path === '/api/task' && req.method === 'DELETE') {
      return send(res, 200, { stopped: this.#tasks.stop() ?? null });
    }

    // 作業場の中身。**横の板に出すため。**どこで何を触っているのかが
    // 見えないまま指示を書くのは、暗い所で手探りをするのと同じ。
    if (path === '/api/files' && req.method === 'GET') {
      // **会話の土台を組まない。**組むとモデルの用意まで要ることになり、
      // モデルが無い機械では、ただの一覧が 500 で返る。
      const root = this.#workRoot();
      const asked = url.searchParams.get('path') ?? '';
      try {
        const entries = await listDir(root, asked);
        return send(res, 200, { root, path: asked, entries });
      } catch (e) {
        return send(res, 400, { error: (e as Error).message });
      }
    }

    // 会話。**残してあるものを出して、開き直せるようにする。**
    if (path === '/api/conversations' && req.method === 'GET') {
      const list = await this.#conversations.list();
      // 続きがあるなら、画面が開いた時点で決めておく。
      // 「どれを開いているのか」が空のままだと、消えたように見える。
      if (!this.#conversationId && list.length > 0) await this.#currentConversation();
      return send(res, 200, { current: this.#conversationId ?? null, list });
    }

    if (path === '/api/conversations' && req.method === 'POST') {
      const session = this.#session;
      if (session && this.#busyNow(session)) {
        return send(res, 409, { error: 'いま作業中です。終わってから切り替えてください' });
      }
      const head = await this.#conversations.create();
      this.#conversationId = head.id;
      this.#saved = 0;
      this.#session?.reset();
      this.broadcast({ type: 'conversations' });
      return send(res, 200, { current: head.id, messages: [] });
    }

    if (path === '/api/conversations/select' && req.method === 'POST') {
      const body = await readBody(req) as { id?: unknown };
      const id = typeof body?.id === 'string' ? body.id : '';
      if (!ID_SHAPE.test(id)) return send(res, 400, { error: '会話の名前が正しくありません' });
      const session = this.#session;
      if (session && this.#busyNow(session)) {
        return send(res, 409, { error: 'いま作業中です。終わってから切り替えてください' });
      }
      const past = await this.#conversations.load(id);
      this.#conversationId = id;
      this.#saved = past.length;
      // 土台があるなら、その場で積み直す。無ければ次に作るときに積む。
      session?.restore(past);
      this.broadcast({ type: 'conversations' });
      return send(res, 200, { current: id, messages: past });
    }

    if (path === '/api/conversations' && req.method === 'DELETE') {
      const id = url.searchParams.get('id') ?? '';
      if (!ID_SHAPE.test(id)) return send(res, 400, { error: '会話の名前が正しくありません' });
      const session = this.#session;
      if (id === this.#conversationId && session && this.#busyNow(session)) {
        return send(res, 409, { error: 'いま作業中です。終わってから消してください' });
      }
      await this.#conversations.remove(id);
      if (id === this.#conversationId) {
        this.#conversationId = undefined;
        this.#saved = 0;
        this.#session?.reset();
      }
      this.broadcast({ type: 'conversations' });
      return send(res, 200, { removed: id });
    }

    if (path === '/api/conversations/messages' && req.method === 'GET') {
      const id = url.searchParams.get('id') ?? '';
      if (!ID_SHAPE.test(id)) return send(res, 400, { error: '会話の名前が正しくありません' });
      return send(res, 200, { id, messages: await this.#conversations.load(id) });
    }

    if (path === '/api/state' && req.method === 'GET') {
      return send(res, 200, await collectState(this.#opts.config));
    }

    if (path === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(': つながりました\n\n');
      this.#clients.add(res);
      req.on('close', () => this.#clients.delete(res));
      return;
    }

    return this.#static(path, res);
  }

  /**
   * モデルが使えるか。使えないなら、その理由と次の一手を返す。
   *
   * 無いことを黙って待たない。**待っている間、利用者は何も分からない。**
   * 繋ぎ先の応答待ちは数十秒になることがあり、その間ずっと「考え中」になる。
   */
  /** いま何かしているか。走り出す前の支度も「している」に数える。 */
  /** いま使っている設定。検査から、同じ設定で立ち上げ直すのに要る。 */
  get config(): AasConfig { return this.#opts.config; }

  /** 作業場の根。会話の土台を組まずに知りたいときに使う。 */
  #workRoot(): string {
    return resolvePath(this.#opts.config.agent?.root ?? process.cwd());
  }

  #busyNow(session: Session): boolean {
    return session.busy || this.#thinking || this.#preparing;
  }

  async #readyToThink(): Promise<string | undefined> {
    const kind = this.#opts.config.runtime?.kind ?? 'ollama';
    try {
      const runtime = await this.#localRuntime();
      const models = await runtime.list();
      if (models.length > 0) {
        // この中で読む道では、**読むまで口が立たない。**
        // 先に読ませておかないと、上の層は繋がらない先を叩くことになる。
        if (runtime.id === 'inproc' && runtime.loaded().length === 0) {
          // 設定で決めた名前（runtime.model）が置き場に在れば、それ。無ければ最初の一つ。
          // 情報の板は runtime.model を「使うモデル」と見せているので、読む側も同じにする。
          const wanted = this.#opts.config.runtime?.model;
          const chosen = (wanted ? models.find((m) => m.ref === wanted) : undefined) ?? models[0]!;
          const ref = chosen.ref;
          // 記憶に載らないものを読みに行かない。落ちるか、何十分も固まる。
          const big = tooBigForRam(chosen.sizeBytes, totalmem());
          if (big) return `${ref}: ${big}`;
          // 名前だけ .gguf で中身が別物（配布元の HTML の案内など）を、読みに行かない。
          // 一覧と同じ場所（動いている側の置き場）を見る。保存側を見ると、
          // 立ち上げ直す前の設定とずれて「読めない」と嘘をつく。
          if (!(await looksLikeGguf(join(this.#opts.config.runtime?.modelsDir ?? modelsDir(), ref)))) {
            return `${ref} は GGUF として読めません（先頭に GGUF の印がありません）。`
              + '配布元の同意頁の HTML を落としてしまった形が多いです。ブラウザで開き直して、本物を置いてください。';
          }
          this.broadcast({ type: 'log', level: 'info', text: `モデルを読み込んでいます: ${ref}` });
          const began = Date.now();
          await runtime.ensureLoaded(ref);
          this.broadcast({
            type: 'log', level: 'info',
            text: `読み込みました: ${ref}（${((Date.now() - began) / 1000).toFixed(1)} 秒）`,
          });
        }
        return undefined;
      }
    } catch (e) {
      return `モデルの一覧を取れません（${kind}）: ${(e as Error).message}\n`
        + '設定 → モデル で、動かし方を選び直せます。';
    }
    if (kind === 'ollama') {
      return 'モデルがまだありません。\n'
        + '設定 → モデル で「この中で読む」を選ぶと、GGUF を1つ置くだけで動きます。\n'
        + 'Ollama を使うなら `ollama serve` を立ち上げてください。';
    }
    return `${this.#opts.config.runtime?.modelsDir ?? modelsDir()} に GGUF がありません。\n`
      + '設定 → モデル に、いま見ている置き場が出ています。そこへ .gguf を1つ置いてください。';
  }

  async #drive(session: Session, text: string): Promise<void> {
    this.broadcast({ type: 'busy', busy: true });
    try {
      for await (const event of session.send(text)) {
        this.broadcast({ type: 'session', event });
      }
    } catch (e) {
      this.broadcast({ type: 'log', level: 'error', text: (e as Error).message });
    } finally {
      // **残してから、次へ進む。**先に次を流すと、落ちたときに
      // その回のやりとりが消える。
      await this.#persist(session);
      this.broadcast({ type: 'busy', busy: false });
      // 作業で記憶やファイルが動いている。画面の材料を取り直させる。
      this.broadcast({ type: 'stateChanged' });
      await this.#drainQueue(session);
    }
  }

  /**
   * 順番待ちを、前から1つ流す。
   *
   * **一度に1つだけ。**残りは、その仕事が終わったあとの `#drive` が続ける。
   * ここで全部回すと、途中で中断されても止まらない。
   */
  async #drainQueue(session: Session): Promise<void> {
    const next = this.#queue.shift();
    this.broadcast({ type: 'queue', waiting: this.#queue.length });
    if (!next) return;
    const extra = next.attached.length > 0
      ? await this.#attachments.describe(next.attached).catch(() => '')
      : '';
    const full = extra ? `${extra}\n\n${next.text}` : next.text;
    this.broadcast({ type: 'log', level: 'info', text: `順番待ちから続けます: ${next.text.split('\n')[0]?.slice(0, 60) ?? ''}` });
    void this.#drive(session, full);
  }

  async #drivePlan(session: Session, text: string): Promise<void> {
    this.broadcast({ type: 'busy', busy: true });
    try {
      for await (const event of session.plan(text)) {
        this.broadcast({ type: 'planEvent', event });
      }
    } catch (e) {
      this.broadcast({ type: 'log', level: 'error', text: (e as Error).message });
    } finally {
      this.broadcast({ type: 'busy', busy: false });
      this.broadcast({ type: 'stateChanged' });
    }
  }

  /** モデルの土台。画面から用意や乗り換えをするのに要る。 */
  async #localRuntime(): Promise<LocalRuntime> {
    if (this.#runtime) return this.#runtime;
    const machine = await new MachineCache(join(stateDir(), 'machine.json')).get();
    this.#runtime = await buildRuntime(this.#opts.config, machine, undefined,
      this.#opts.inprocLoad ? { inprocLoad: this.#opts.inprocLoad } : {});
    return this.#runtime;
  }

  /**
   * モデルを取ってくる。数GBかかるので、待たせずに進み具合を流す。
   */
  async #fetchModel(session: Session, id: string): Promise<void> {
    const runtime = await this.#localRuntime();
    const entry = lookupCatalog(id);
    const log = (text: string) => this.broadcast({ type: 'log', level: 'info', text });

    try {
      if (usesGguf(runtime.id)) {
        // 画面の一覧と同じ場所へ落とす。動いている側の置き場に落とすと、
        // 保存を変えた直後に「取ってきたのに出ない」になる。
        const dir = await savedModelsDir();
        await installModel({
          entry: entry ?? {
            id, repo: id, quant: 'q4_k_m', ollama: '', approxGB: 0, note: '', license: '',
          },
          modelsDir: dir,
          onProgress: log,
        });
      } else {
        await pullModel({
          baseUrl: this.#opts.config.providers.find(
            (p) => p.kind === 'openai-compatible' && p.locality === 'local',
          )?.baseUrl ?? 'http://localhost:11434/v1',
          ref: entry?.ollama ?? id,
          onProgress: log,
        });
      }
      log(`用意できました: ${id}`);
    } catch (e) {
      this.broadcast({
        type: 'log', level: 'error',
        text: `取ってこられませんでした: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
    this.broadcast({ type: 'stateChanged' });
  }

  async #static(path: string, res: ServerResponse): Promise<void> {
    const rel = path === '/' ? 'index.html' : normalize(path).replace(/^([/\\.]+)/, '');
    const file = join(WEB_DIR, rel);
    // 画面の置き場より外は読ませない。
    if (!file.startsWith(WEB_DIR)) return send(res, 403, { error: 'その場所は読めません' });
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      send(res, 404, { error: `見つかりません: ${rel}` });
    }
  }
}

export async function loadLayout(): Promise<{ layout: Layout; repairs: { detail: string }[] }> {
  try {
    return repairLayout(JSON.parse(await readFile(LAYOUT_PATH(), 'utf8')));
  } catch {
    // まだ配置を決めていないだけ。既定から始める。
    return { layout: preset('command'), repairs: [] };
  }
}

export async function loadTheme(): Promise<{ theme: Theme; repairs: { detail: string }[] }> {
  try {
    return repairTheme(JSON.parse(await readFile(THEME_PATH(), 'utf8')));
  } catch {
    // まだ選んでいないだけ。既定から始める。
    return { theme: baseTheme('slate'), repairs: [] };
  }
}

export async function saveTheme(theme: Theme): Promise<void> {
  const path = THEME_PATH();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(theme, null, 2) + '\n', 'utf8');
}

export async function saveLayout(layout: Layout): Promise<void> {
  const path = LAYOUT_PATH();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(layout, null, 2) + '\n', 'utf8');
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(text);
}

/** JSON の本文の上限。添付は別の口（/api/attach）で、それ自身の上限を持つ。 */
export const MAX_JSON_BODY = 16 * 1024 * 1024;

export class BodyTooLarge extends Error {
  constructor(limit: number) { super(`本文が大きすぎます（${Math.round(limit / 1024 / 1024)}MB まで）`); }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    total += (c as Buffer).length;
    // 際限なく抱えない。上限を超えたら読むのをやめて断る。
    if (total > MAX_JSON_BODY) { req.destroy(); throw new BodyTooLarge(MAX_JSON_BODY); }
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return undefined; // 直す側が既定に落としてくれる
  }
}
