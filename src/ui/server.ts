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
import { UnfinishedWork, resumePrompt, whyText } from '../core/unfinished.ts';
import { githubLaunch } from '../core/github-mcp.ts';
import { stat } from 'node:fs/promises';
import { Goals, progressOf, isSettled } from '../core/goals.ts';
import { StrideBook, strideText } from '../agent/stride.ts';
import { decompose, stepPrompt } from '../agent/decompose.ts';
import { Conversations, ID_SHAPE } from '../core/conversations.ts';
import { writeEnvValue } from '../core/env.ts';
import { canRun } from '../core/which.ts';
import { saveMcpServer, saveWorkRoot, savedWorkRoot } from './settings.ts';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname, extname, normalize, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateDir } from '../core/autopilot-setup.ts';
import { aasHome, binDir, modelsDir, isPortable, productRoot, defaultWorkRoot } from '../core/home.ts';
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
import { expandMentions } from '../agent/mention.ts';
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
  /** やり残しの控えが動いた。画面に取り直させる。 */
  | { type: 'unfinished' }
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
  /**
   * やり残し。**ファイルに残す。**窓を閉じても、機械を落としても残る。
   * 記憶の中だけだと、いちばん続きが要るとき（長い作業の途中で落ちた）に
   * きれいに消える。
   */
  readonly #unfinished = new UnfinishedWork(join(stateDir(), 'unfinished.jsonl'));
  /** 段取り。落ちた依頼を、歩ける大きさに割って一段ずつ進む。 */
  readonly #goals = new Goals(join(stateDir(), 'goals.jsonl'));
  /** そのモデルが実際にこなせた歩幅。**言い訳ではなく、通った跡で測る。** */
  readonly #stride = new StrideBook(join(stateDir(), 'stride.json'));
  /** いま進めている段。終わったときに結果を書き戻すために持つ。 */
  #step?: { goalId: string; stepId: string; model: string };
  /** いま続きとして流しているやり残し。片づいたら外すために持つ。 */
  #resuming?: string;
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

    // **候補は `provider名:モデル名`。**名前だけを渡していたので、
    // どの provider のことか決まらず「全Providerが未登録」で即座に落ちた。
    // 画面には何も出ず、打っても返事が来ない。**それがこの穴。**
    const local = config.providers.find(
      (pr) => pr.kind === 'openai-compatible' && pr.locality === 'local',
    );
    if (!local) return config;
    // 繋いだ先の一覧にも入れる。既定の名前（qwen3.6:35b… など）のままだと、
    // 置いてある GGUF がどこにも無いことになる。
    const providers = config.providers.map((pr) => (
      pr === local ? { ...pr, models: [ref] } : pr
    ));
    return { ...config, providers, candidates: [`${local.id}:${ref}`] };
  }

  /**
   * 候補の無い土台を抱えていたら、組み直す。
   *
   * モデルを読む前に土台が組まれると（画面を開いただけでも組まれる）、
   * 候補が空のまま固定される。読み込んだ後も直らないので、
   * **打っても打っても即座に「使えるモデルがありません」で終わる。**
   */
  async #rebuildIfCandidatesMissing(): Promise<void> {
    const live = this.#session;
    if (!live || live.candidates.length > 0) return;
    if (this.#busyNow(live)) return;
    const fixed = await this.#configForSession();
    if (!fixed.candidates || fixed.candidates.length === 0) return;
    this.#session = undefined;
    await live.close().catch(() => undefined);
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
    // **思いつきを切っても、見回りは止めない。**
    // 「勝手に考え始めないでほしい」と「頼んだことを途中で放り出してよい」は
    // まったく別の話。ここを一つの栓にしていたので、思いつきを切った人は
    // やり残しの拾い上げごと失っていた。考えるかどうかは、下で決める。
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
   *   RESUMED  やり残しの続きを始めた
   *   HELD     前にモデルが無かったので、しばらく試さない
   *   MISSING  モデルが無い。次はしばらく試さない
   *   THOUGHT  考えた（考えなかったことも含む。決めるのは中のスケジューラ）
   *
   * **考える前に、モデルの支度をする。**この中で読む道では、読むまで口が
   * 立たない。支度せずに考えに行くと、30秒ごとに「繋がりません」を作る。
   */
  async idleTick(session: Session): Promise<'BUSY' | 'HELD' | 'MISSING' | 'THOUGHT' | 'RESUMED'> {
    // 作業中は考えない。人の依頼が先。支度の最中も、人の依頼のうち。
    if (this.#busyNow(session)) return 'BUSY';
    // **順番待ちがあるなら、暇ではない。**ここで考え始めると、
    // 待っている依頼が、その分だけ後ろへ押しやられる。
    if (this.#queue.length > 0) { void this.#maybeDrain(); return 'BUSY'; }

    // **やり残しが先。**考えごとより、頼まれて終わっていない方が先。
    // ここが無いと、40往復で切れた作業は、人が言い直すまで誰も続けない。
    if (await this.#resumeUnfinished(session)) return 'RESUMED';

    // 思いつきはここで切る。やり残しの拾い上げは、その手前で済んでいる。
    //
    // **既定は切る。**ローカルの小さいモデルでは、一回の思いつきが数分
    // 機械を占有する。頼んでいない仕事にそれを使われると、頼んだ仕事が
    // そのぶん待たされる。使いたい人が `initiative.enabled: true` で入れる。
    if ((this.#opts.config.initiative ?? {}).enabled !== true) return 'HELD';

    if (Date.now() < this.#idleHoldUntil) return 'HELD';
    this.#preparing = true;
    try {
      // **読み込みは始めない。**頼まれてもいないのに数GBを読むと、
      // 立ち上げて30秒後に機械が塞がる。
      const missing = await this.#readyToThink(false);
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

      // **読み込む前に組んだ土台を、抱えたままにしない。**
      // 候補が決まる前に土台が組まれると、候補が空のまま固定される。
      // 以後どれだけ打っても 0.01 秒で「使えるモデルがありません」で終わる。
      // 画面には何も出ないので、固まったようにしか見えない。
      await this.#rebuildIfCandidatesMissing();

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
        // 指名（`@道`）は、送る側で開いて中身ごと渡す。
        // 名前だけ渡すと、開かずに書き始めることがある。
        const named = await expandMentions(text, this.#workRoot()).catch(() => ({ text, reads: [] }));
        for (const r of named.reads) {
          if (!r.ok) this.broadcast({ type: 'log', level: 'warn', text: `指名を読めません ${r.path}: ${r.body}` });
        }
        const full = extra ? `${extra}\n\n${named.text}` : named.text;

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
      // **ここで落ちない。**落ちると画面は何も言わずに空欄のまま出る。
      // 利用者からは「選択肢が一つも無い」としか見えず、理由が分からない。
      try {
        return await this.#configView(res);
      } catch (e) {
        return send(res, 200, {
          path: configPath(),
          kinds: RUNTIME_KINDS.map((id) => ({ id, name: KIND_LABELS[id] })),
          kind: this.#opts.config.runtime?.kind ?? 'ollama',
          modelsDir: '',
          model: null,
          active: { kind: this.#opts.config.runtime?.kind ?? 'ollama', modelsDir: '' },
          restartNeeded: false,
          gguf: [],
          dirState: 'OK',
          error: `設定を読めませんでした: ${(e as Error).message}`,
        });
      }
    }

    if (path === '/api/config' && req.method === 'PUT') {
      return this.#saveConfig(req, res);
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
      // 起こし直してもらえない入口では、**止めない**。止めると誰も起こさない。
      if (!this.#opts.onRestart) {
        return send(res, 501, {
          error: 'この入口からは立ち上げ直せません。'
            + '窓を閉じて、AdaptiveAIStudio を開き直してください。',
        });
      }
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
        // **無ければ作る。**入れた版の既定（根の下の work）は初回には無い。
        // 会話を始める前に横の板が一覧を読むので、そこで
        // 「そんな場所は無い」が出る。開いた瞬間に赤が出るのが、いちばん困る。
        await mkdir(root, { recursive: true }).catch(() => { /* 作れないなら listDir が言う */ });
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
      // **一覧を見ただけでは作らない。**作ると、開くたびに空の会話が増える。
      if (!this.#conversationId && list.length > 0) {
        this.#conversationId = list[0]!.id;
        this.#saved = (await this.#conversations.load(this.#conversationId)).length;
      }
      return send(res, 200, { current: this.#conversationId ?? null, list });
    }

    if (path === '/api/conversations' && req.method === 'POST') {
      const session = this.#session;
      if (session && this.#busyNow(session)) {
        return send(res, 409, { error: 'いま作業中です。終わってから切り替えてください' });
      }
      // **空の会話を二つ作らない。**いま開いているものがまだ空なら、それが
      // 「新しい会話」そのもの。押すたびに増えると、一覧が空の見出しで埋まる。
      const current = this.#conversationId
        ? await this.#conversations.head(this.#conversationId).catch(() => undefined)
        : undefined;
      if (current && current.messages === 0) {
        this.#session?.reset();
        this.#saved = 0;
        return send(res, 200, { current: current.id, messages: [] });
      }
      const head = await this.#conversations.create();
      this.#conversationId = head.id;
      this.#saved = 0;
      this.#session?.reset();
      this.broadcast({ type: 'conversations' });
      return send(res, 200, { current: head.id, messages: [] });
    }

    // 段取り。**どこまで進んだかを、常に見えるところに置く。**
    // 一段ずつ進むので、見えないと「止まっている」のか
    // 「一段ずつ進んでいる」のかが区別できない。
    if (path === '/api/goals' && req.method === 'GET') {
      const list = await this.#goals.list();
      return send(res, 200, {
        list: list.map((g) => ({
          id: g.id,
          request: g.request,
          progress: progressOf(g),
          steps: g.steps.map((st) => ({ instruction: st.instruction, state: st.state, attempts: st.attempts })),
        })),
        stride: await this.#stride.all(),
      });
    }

    // やり残しの控え。**見えないところで動かさない。**
    // 知らないうちに作業場が変わるのが、いちばん怖い。見えて、やめられること。
    if (path === '/api/unfinished' && req.method === 'GET') {
      const list = await this.#unfinished.list();
      return send(res, 200, {
        list: list.map((u) => ({
          id: u.id,
          request: u.request,
          why: u.why,
          whyText: whyText(u.why),
          attempts: u.attempts,
          nextAt: u.nextAt,
          running: u.id === this.#resuming,
        })),
      });
    }

    if (path === '/api/unfinished' && req.method === 'DELETE') {
      const id = url.searchParams.get('id') ?? '';
      if (!id) return send(res, 400, { error: 'id がありません' });
      await this.#unfinished.cancel(id);
      this.broadcast({ type: 'unfinished' });
      return send(res, 200, { canceled: id });
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

    /*
     * 外の道具（MCP）。GitHub をここから繋げるようにする。
     *
     * 合言葉は**置き場の .env** に書く（設定ファイルには名前だけ）。
     * 値は返さない。**入っているかどうか**だけを返す。
     */
    if (path === '/api/mcp' && req.method === 'GET') {
      const servers = Object.entries(this.#opts.config.mcp?.servers ?? {}).map(([name, spec]) => {
        const client = this.#session?.mcpClients.find((c) => c.name === name);
        const wants = Object.values(spec.envFrom ?? {});
        return {
          name,
          command: `${spec.command} ${(spec.args ?? []).join(' ')}`.trim(),
          enabled: spec.enabled !== false,
          // 合言葉は名前だけ。値は決して出さない。
          secrets: wants.map((from) => ({ name: from, set: process.env[from] !== undefined })),
          canRun: canRun(spec.command),
          running: client?.running ?? false,
          tools: client?.tools.length ?? 0,
          failure: client?.failure ?? null,
          // **まだ試していない**のと、**試して駄目だった**のは違う。
          // 一緒にすると「つながりませんでした（理由は不明）」になる（実際になった）。
          tried: client !== undefined,
        };
      });
      return send(res, 200, { servers, envPath: join(aasHome(), '.env') });
    }

    /** GitHub を繋ぐ。合言葉を置き場へ書き、設定に一つ足す。 */
    if (path === '/api/mcp/github' && req.method === 'POST') {
      const body = await readBody(req) as { token?: unknown; enabled?: unknown };
      const token = typeof body?.token === 'string' ? body.token.trim() : '';
      const enabled = body?.enabled !== false;
      try {
        if (token) await writeEnvValue(join(aasHome(), '.env'), 'GITHUB_TOKEN', token);
        // 書いたものを、この場でも使えるようにする（立ち上げ直しを待たせない）。
        if (token) process.env.GITHUB_TOKEN = token;
        // **npx に頼らない。**npx は npm に付いてくるが、入れる版には node
        // しか入っていない。`-y` は毎回ネットから取ってくるので、外へ出られない
        // 機械では動かない。つまり「GitHub と繋ぐ」は口があるだけで、
        // **一度も繋がらなかった。**同梱してあるなら、それを直に起こす。
        const launch = githubLaunch();
        const at = await saveMcpServer('github', {
          command: launch.command,
          args: launch.args,
          envFrom: { GITHUB_PERSONAL_ACCESS_TOKEN: 'GITHUB_TOKEN' },
          enabled,
        });
        // **いまの土台を畳む。**外の道具は土台を組むときに立ち上がるので、
        // 畳まないと、繋いだのに次も繋がらない。会話は残してあるので続きから話せる。
        const live = this.#session;
        if (live && !this.#busyNow(live)) {
          this.#session = undefined;
          await live.close().catch(() => undefined);
        }
        // いま動いている設定にも入れる。次の依頼から使える。
        this.#opts.config.mcp = {
          ...this.#opts.config.mcp,
          servers: {
            ...this.#opts.config.mcp?.servers,
            github: {
              command: launch.command,
              args: launch.args,
              envFrom: { GITHUB_PERSONAL_ACCESS_TOKEN: 'GITHUB_TOKEN' },
              enabled,
            },
          },
        };
        return send(res, 200, {
          path: at,
          // **値は返さない。**入っているかどうかだけ。
          tokenSet: process.env.GITHUB_TOKEN !== undefined,
          // **起こせるかどうかを、そのまま返す。**
          // npx が在るかを見ていたので、同梱してあっても「無い」と言い、
          // 同梱していなくても npx さえ在れば「在る」と言っていた。
          canRun: launch.why === undefined,
          ...(launch.why ? { note: launch.why } : {}),
          restartNeeded: this.#session !== undefined,
        });
      } catch (e) {
        return send(res, 400, { error: (e as Error).message });
      }
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

  /**
   * 設定の見え方を組み立てる。
   *
   * **落ちる所を一箇所にまとめる。**呼ぶ側が包めるようにしておかないと、
   * 途中で落ちたときに画面が空欄のまま出て、理由が誰にも分からない。
   */
  async #configView(res: ServerResponse): Promise<void> {
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
      // 作業場。**入れた版では、これが無いと何も始まらない。**
      // 書いてなければ既定（根の下の work）が出る。
      workRoot: await savedWorkRoot(),
      workRootNow: this.#workRoot(),
    });
  }

  /** 画面から設定を書き換える。 */
  async #saveConfig(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req) as {
      kind?: string; modelsDir?: string; model?: string; workRoot?: string;
    };
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
    // 作業場。**打った場所は見るだけ。**無い場所を打っても保存はできる
    // （打ち間違いは、保存したときに言う）。
    let workNote: string | undefined;
    let workRestart = false;
    if (typeof body?.workRoot === 'string') {
      const want = body.workRoot.trim();
      const before = this.#workRoot();
      await saveWorkRoot(want);
      if (want) {
        const ok = await stat(want).then((st) => st.isDirectory()).catch(() => false);
        if (!ok) workNote = `そこは見つかりません: ${want}（保存はしました）`;
      }

      // **いま動いている設定にも入れる。**
      // ここまで、書き込むだけで動いている側を直していなかった。保存したのに
      // 画面は古い作業場を見たまま、しかも立ち上げ直しが要るとも言わない。
      // 「保存したのに変わらない」で終わる形だった。
      const agent = { ...(this.#opts.config.agent ?? {}) };
      if (want) agent.root = want;
      else delete agent.root;
      this.#opts.config.agent = agent;

      if (this.#workRoot() !== before) {
        // **いまの土台を畳む。**作業場は土台を組むときに決まるので、畳まないと
        // 変えたのに道具は前の場所を触り続ける。会話は残してあるので続きから話せる。
        const live = this.#session;
        if (live && !this.#busyNow(live)) {
          this.#session = undefined;
          await live.close().catch(() => undefined);
        } else if (live) {
          // 作業中は畳めない。**黙って効いた顔をしない。**
          workRestart = true;
        }
        this.broadcast({ type: 'log', level: 'info', text: `作業場を変えました: ${this.#workRoot()}` });
        this.broadcast({ type: 'stateChanged' });
      }
    }
    this.broadcast({ type: 'log', level: 'info', text: `設定を書きました: ${at}` });
    return send(res, 200, {
      path: at,
      saved: { kind, modelsDir: dir || null, ...(model !== undefined ? { model: model || null } : {}) },
      // 打ち間違えても保存はできる。だから**保存したときに言う。**
      dirState,
      ...(workNote ? { workNote } : {}),
      // いまどこを見ているか。**保存の返事に入れる。**入っていないと、
      // 効いたのかどうかを画面が確かめられない。
      workRootNow: this.#workRoot(),
      // 動かし方の切り替えは、立ち上げ直すまで効かない。黙って効いた顔をしない。
      restartNeeded: workRestart
        || kind !== (this.#opts.config.runtime?.kind ?? 'ollama')
        || (dir || modelsDir()) !== (this.#opts.config.runtime?.modelsDir ?? modelsDir())
        || (model !== undefined && (model || undefined) !== this.#opts.config.runtime?.model),
    });
  }

  /** いま使っている設定。検査から、同じ設定で立ち上げ直すのに要る。 */
  get config(): AasConfig { return this.#opts.config; }

  /** 作業場の根。会話の土台を組まずに知りたいときに使う。 */
  #workRoot(): string {
    return resolvePath(this.#opts.config.agent?.root ?? defaultWorkRoot());
  }

  #busyNow(session: Session): boolean {
    return session.busy || this.#thinking || this.#preparing;
  }

  /**
   * 話せる状態か。話せないなら、その理由。
   *
   * `load: false` のときは、**読み込みを始めない。**
   * 見回り（暇なときの一回分）から呼ぶときはこちら。
   *
   * ここまで、見回りからも読み込ませていた。数GBを読むあいだ機械は塞がり、
   * **利用者が何も頼んでいないのに、立ち上げて30秒後に固まる。**
   * 「起動したらずっとフリーズしている」の正体がこれ。
   * 読むのは、頼まれたときだけでよい（`/api/send` が同じ道を通る）。
   */
  async #readyToThink(load = true): Promise<string | undefined> {
    const kind = this.#opts.config.runtime?.kind ?? 'ollama';
    try {
      const runtime = await this.#localRuntime();
      const models = await runtime.list();
      if (models.length > 0) {
        if (runtime.id === 'inproc' && runtime.loaded().length === 0 && !load) {
          return 'モデルをまだ読んでいません（頼まれたときに読みます）';
        }
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

  async #drive(session: Session, text: string, resuming?: string): Promise<void> {
    this.broadcast({ type: 'busy', busy: true });
    // どう終わったか。**終わり方を見て、やり残しを控える。**
    let settled: { reason: string; verified: boolean } | undefined;
    // 道具が実際に動いたか。**一段の合否は、言葉ではなくここで見る。**
    // 「では、このあと直します」と言っただけの回を「済んだ」と数えていた。
    let didSomething = false;
    try {
      for await (const event of session.send(text)) {
        if (event.type === 'settled') settled = { reason: event.reason, verified: event.verified };
        if (event.type === 'toolEnd' && event.ok) didSomething = true;
        this.broadcast({ type: 'session', event });
      }
    } catch (e) {
      this.broadcast({ type: 'log', level: 'error', text: (e as Error).message });
    } finally {
      await this.#recordUnfinished(text, settled, resuming, didSomething);
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
   * やり残しの続きを、こちらから始める。
   *
   * **これが「自律的に進める」の中身。**控えるだけでは、人が言い直すまで
   * 動かない。手が空いた時点で、こちらから拾う。
   *
   * すぐには戻らない（`BACKOFF_MS`）。落ちた直後にそのまま戻すと、
   * 同じところで同じように落ちて、枠と電気を使うだけになる。
   *
   * 一度に一つだけ。まとめて始めると、どれが動いているのか分からなくなる。
   */
  async #resumeUnfinished(session: Session): Promise<boolean> {
    let item;
    try {
      item = await this.#unfinished.due();
    } catch { return false; }
    if (!item) return false;

    // モデルが無ければ（まだ読んでいない場合も含めて）、続けようがない。
    // **ここでも読み込みは始めない。**控えはそのまま残る。
    if (await this.#readyToThink(false)) {
      this.#idleHoldUntil = Date.now() + 10 * 60_000;
      return false;
    }

    // **黙って動き出さない。**知らないうちに作業場が変わるのが、いちばん怖い。
    this.broadcast({
      type: 'log', level: 'info',
      text: `やり残しの続きを始めます（${item.attempts + 1} 回目）: ${item.request.split('\n')[0]?.slice(0, 60) ?? ''}`,
    });
    this.#resuming = item.id;

    // **二度目からは、同じ大きさで挑まない。**
    // 一度落ちたものを、もう一度そのまま渡しても通らない。歩ける大きさに
    // 割って、一段ずつ進む。割り方は、そのモデルが実際にこなせた歩幅から決める。
    if (item.attempts >= 1) {
      const stepped = await this.#driveStep(session, item);
      if (stepped) return true;
    }
    // 元の会話へ戻して続ける。別の会話で続けると、話が二つに割れる。
    if (item.conversationId && item.conversationId !== this.#conversationId) {
      const past = await this.#conversations.load(item.conversationId).catch(() => undefined);
      if (past) {
        this.#conversationId = item.conversationId;
        this.#saved = past.length;
        session.restore(past);
        this.broadcast({ type: 'conversations' });
      }
    }
    void this.#drive(session, resumePrompt(item), item.id)
      .finally(() => { this.#resuming = undefined; });
    return true;
  }

  /**
   * 段取りを立てて、**一段だけ**進める。
   *
   * ここが「その機械のそのモデルに合わせる」の実体。
   *
   *   「src を直して」          4B には大きすぎる。読んだだけで力尽きる
   *   「src/a.ts の型を直して」 これなら通る
   *
   * 一度に一段。全部やらせない。一段ごとに通ったかを見て、
   * 通れば次へ、落ちれば**もっと小さく割り直す**。
   *
   * 割れなかったら false を返す（**割れないことは、進めない理由にならない**。
   * 呼ぶ側が、これまでどおり丸ごと渡す道へ落ちる）。
   */
  async #driveStep(session: Session, item: { id: string; request: string; note: string }): Promise<boolean> {
    const model = session.candidates[0] ?? '(不明)';
    const stride = await this.#stride.get(model, session.contextTokens);

    let goal = (await this.#goals.list()).find((g) => g.request === item.request);
    if (!goal) {
      this.broadcast({
        type: 'log', level: 'info',
        text: `一度で通らなかったので、段に割ります（歩幅: ${strideText(stride.size)}）`,
      });
      const steps = await decompose(session.orchestrator, {
        candidates: session.candidates,
        request: item.request,
        size: stride.size,
        note: item.note,
        signal: new AbortController().signal,
      });
      if (steps.length === 0) {
        this.broadcast({ type: 'log', level: 'warn', text: '段に割れませんでした。丸ごと進めます。' });
        return false;
      }
      goal = await this.#goals.open(item.request, steps);
      this.broadcast({ type: 'unfinished' });
    }

    const step = await this.#goals.next(goal.id);
    if (!step) {
      // 全部片づいた（塞がったものも含めて、もう手を付けない）。
      await this.#goals.close(goal.id);
      const p = progressOf(goal);
      const stuck = goal.steps.filter((st) => st.state === 'blocked');
      if (stuck.length === 0) {
        this.broadcast({ type: 'log', level: 'info', text: `段取りを終えました（済 ${p.done}）` });
        // 全部通った。やり残しとしても片づける。
        await this.#unfinished.done(item.id);
        this.broadcast({ type: 'unfinished' });
        this.#resuming = undefined;
        return true;
      }

      // **手が付かなかった段があるなら、丸ごと投げ直さない。**
      // 割っても通らなかったものを、まとめて渡せば通る道理がない。
      // ここで諦め、**何が出来て何が出来なかったかを言う**。
      // 黙って消すと、頼んだことが消えたようにしか見えない。
      await this.#unfinished.cancel(item.id);
      this.broadcast({
        type: 'log', level: 'warn',
        text: `${p.done} 段は出来ましたが、次の段は手が付きませんでした。ここで止めます。\n`
          + stuck.map((st) => `  ・${st.instruction}`).join('\n')
          + '\n割り直しても通らなかったので、大きさの問題ではありません。'
          + '前提が足りないか、この作業場では出来ないことのようです。',
      });
      this.broadcast({ type: 'unfinished' });
      this.#resuming = undefined;
      return true;
    }

    const p = progressOf(goal);
    this.broadcast({
      type: 'log', level: 'info',
      text: `一歩ずつ進めます（${p.done + 1}/${p.total}）: ${step.instruction}`,
    });
    this.#step = { goalId: goal.id, stepId: step.id, model };
    void this.#drive(session, stepPrompt(item.request, step.instruction, p.done + 1, p.total), item.id)
      .finally(() => { this.#resuming = undefined; this.#step = undefined; });
    return true;
  }

  /**
   * 通った段の次を、待たずに始める。
   *
   * **人の依頼が先。**作業中・支度中・順番待ちがあるなら、始めない
   * （次の見回りが拾う）。
   */
  async #continueStep(session: Session, item: { id: string; request: string; note: string }): Promise<void> {
    if (this.#busyNow(session) || this.#queue.length > 0) return;
    this.#resuming = item.id;
    const started = await this.#driveStep(session, item).catch(() => false);
    if (!started) this.#resuming = undefined;
  }

  /**
   * 一段ぶんの結果を書き戻す。**通った跡で歩幅を測る。**
   */
  async #settleStep(done: boolean, session: Session): Promise<void> {
    const at = this.#step;
    if (!at) return;
    await this.#stride.record(at.model, session.contextTokens, done).catch(() => undefined);
    if (done) {
      await this.#goals.succeed(at.goalId, at.stepId);
      this.broadcast({ type: 'unfinished' });
      return;
    }
    const action = await this.#goals.fail(at.goalId, at.stepId);
    if (action.do === 'retry') {
      this.broadcast({ type: 'log', level: 'info', text: 'この一歩は通りませんでした。もう一度試します。' });
    } else if (action.do === 'block') {
      await this.#goals.block(at.goalId, at.stepId);
      // **一段で全部を止めない。**止めると、独立して進められる残りまで道連れ。
      this.broadcast({
        type: 'log', level: 'warn',
        text: 'この一歩は、割り直しても通りませんでした。ここは手が付かないものとして、次へ進みます。',
      });
    } else {
      // **もっと小さく割り直す。**同じ大きさで挑み直しても通らない。
      const goal = (await this.#goals.list()).find((g) => g.id === at.goalId);
      const step = goal?.steps.find((s) => s.id === at.stepId);
      if (!goal || !step) return;
      const stride = await this.#stride.get(at.model, session.contextTokens);
      this.broadcast({
        type: 'log', level: 'info',
        text: `この一歩が通らないので、もっと小さく割り直します（歩幅: ${strideText(stride.size)}）`,
      });
      const smaller = await decompose(session.orchestrator, {
        candidates: session.candidates,
        request: step.instruction,
        size: stride.size,
        note: '一度で通らなかった段です。もっと細かく割ってください。',
        signal: new AbortController().signal,
      });
      if (smaller.length === 0) {
        await this.#goals.block(at.goalId, at.stepId);
        this.broadcast({ type: 'log', level: 'warn', text: '割り直せませんでした。次の段へ進みます。' });
      } else {
        await this.#goals.split(at.goalId, at.stepId, smaller);
      }
    }
    this.broadcast({ type: 'unfinished' });
  }

  /**
   * やり残しを控える／片づける。
   *
   * ここまで、40往復で切れても、押し戻しても動かなくても、**そこで終わり**
   * だった。次に人が同じことを言い直すまで、誰も続けない。
   * 「自律的に進める」と言いながら、続きは人が覚えている前提だった。
   *
   * 覚えるのはこちらの仕事。
   */
  async #recordUnfinished(
    text: string, settled: { reason: string; verified: boolean } | undefined,
    resuming?: string, didSomething = true,
  ): Promise<void> {
    const done = settled?.reason === 'completed' && settled.verified;
    try {
      // 一段ぶんを進めていたなら、その結果を先に書き戻す。
      // **通った跡で歩幅を測る。**言い訳ではなく、通ったかどうかで。
      const stepping = this.#step;
      if (stepping) {
        const session = this.#session;
        // **一段は、道具が動いていなければ済んだことにしない。**
        // 段は「やること」を渡している。喋っただけの回を済みにすると、
        // 何もしていない段取りが、順調に進んだ顔で終わる。
        if (session) await this.#settleStep(done && didSomething, session);
        // **段取りの途中は、やり残しを閉じない。**まだ段が残っている。
        const mine = (await this.#goals.list()).find((g) => g.id === stepping.goalId);
        if (resuming && mine && !isSettled(mine)) {
          this.broadcast({ type: 'unfinished' });
          // 通った段の次は、**待たずに次へ**。一段ごとに見回りを待つと、
          // 10段の段取りで待ち時間だけ5分になる。
          //
          // 落ちた段のあとだけ間を置く（次の見回りに任せる）。詰めて回すと、
          // 落ちているときに同じところを高速で叩き続けることになる。
          //
          // **人の依頼が先。**順番待ちがあるなら、そちらを先に流す
          // （この直後に #drainQueue が回る）。
          const goOn = done && didSomething && this.#queue.length === 0;
          if (goOn) {
            const session2 = this.#session;
            const item = (await this.#unfinished.list()).find((u) => u.id === resuming);
            if (session2 && item) {
              // 立て続けに始めない。この回の後始末（順番待ちの掃き出しまで）を
              // 終えてから。ここで直に呼ぶと、busy を下ろす前に次が立ち上がる。
              // この回の後始末（順番待ちの掃き出しまで）が終わってから始める。
              // 0 だと、busy を下ろし切る前に次が立ち上がって弾かれる。
              setTimeout(() => { void this.#continueStep(session2, item); }, 100);
            }
          }
          return;
        }
      }

      // 続きとして流したものが片づいたなら、控えから外す。
      if (resuming && done) {
        await this.#unfinished.done(resuming);
        this.broadcast({ type: 'log', level: 'info', text: 'やり残しが片づきました' });
        this.broadcast({ type: 'unfinished' });
        return;
      }
      if (resuming) {
        // まだ終わっていない。次はもっと後にする。
        const { gaveUp, attempts } = await this.#unfinished.bump(resuming);
        this.broadcast({
          type: 'log', level: gaveUp ? 'warn' : 'info',
          text: gaveUp
            ? `${attempts} 回試しても終わらないので、やり残しを諦めました。手で見てください。`
            : `やり残しは、しばらく置いてからまた試します（${attempts} 回目）`,
        });
        this.broadcast({ type: 'unfinished' });
        return;
      }
      if (done || !settled) return;

      const why = settled.reason === 'maxTurns' ? 'maxTurns'
        : settled.reason === 'noProgress' ? 'noProgress'
        : settled.reason === 'completed' ? 'unverified'
        : 'failed';
      const added = await this.#unfinished.add({
        request: text,
        why,
        note: settled.reason,
        ...(this.#conversationId ? { conversationId: this.#conversationId } : {}),
      });
      if (!added) return;
      // **黙って控えない。**知らないうちに勝手に動き出すのがいちばん怖い。
      this.broadcast({
        type: 'log', level: 'info',
        text: `終わっていないので、手が空いたら続きをやります（${whyText(why)}）`,
      });
      this.broadcast({ type: 'unfinished' });
    } catch (e) {
      this.broadcast({ type: 'log', level: 'error', text: `やり残しを控えられません: ${(e as Error).message}` });
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
    const named = await expandMentions(next.text, this.#workRoot()).catch(() => ({ text: next.text, reads: [] }));
    const full = extra ? `${extra}\n\n${named.text}` : named.text;
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
    // **土台の声を画面へ繋ぐ。**ここに undefined を渡していたので、
    // 2GB を読む 30〜60秒のあいだ、画面には一行も出なかった。
    // 待っているのか固まっているのかが分からない、いちばん困る形。
    // 「合う道具の呼び方が見つからない」という警告も、ここで消えていた。
    this.#runtime = await buildRuntime(
      this.#opts.config, machine,
      (text) => this.broadcast({ type: 'log', level: 'info', text }),
      this.#opts.inprocLoad ? { inprocLoad: this.#opts.inprocLoad } : {},
    );
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
