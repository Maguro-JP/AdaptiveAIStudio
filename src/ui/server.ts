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
import { listDir, resolveInside } from './files.ts';
import { UnfinishedWork, resumePrompt, whyText } from '../core/unfinished.ts';
import { githubLaunch } from '../core/github-mcp.ts';
import { CATALOG, BUILTIN, findEntry, specFrom, needsNpx } from '../mcp/catalog.ts';
import { connectService, disconnectService } from '../core/mcp-connect.ts';
import { stat } from 'node:fs/promises';
import { Goals, progressOf, isSettled } from '../core/goals.ts';
import { StrideBook, strideText } from '../agent/stride.ts';
import { decompose, stepPrompt } from '../agent/decompose.ts';
import { Conversations, ID_SHAPE } from '../core/conversations.ts';
import { loadJournals, type Journals } from '../core/journals.ts';
import { UndoStore } from '../core/undo.ts';
import { unifiedDiff, diffStat } from '../agent/diff.ts';
import { revertLines, type RevertPick } from '../agent/hunks.ts';
import { buildCompletionInput, cleanCompletion } from '../core/completion.ts';
import { writeEnvValue } from '../core/env.ts';
import { canRun } from '../core/which.ts';
import { saveMcpServer, saveWorkRoot, savedWorkRoot } from './settings.ts';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { revealCommand } from '../core/opener.ts';
import { join, dirname, extname, normalize, resolve as resolvePath, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateDir } from '../core/autopilot-setup.ts';
import { aasHome, binDir, modelsDir, isPortable, productRoot, installRoot, defaultWorkRoot } from '../core/home.ts';
import { currentVersion, describeVersion } from '../core/version.ts';
import { LogFile } from '../core/logfile.ts';
import { checkUpdate, applyUpdate } from '../core/update.ts';
import { findInstalled } from '../runtime/llama-install.ts';
import { findNewerOllama, findNewerGguf } from '../runtime/model-updates.ts';
import { AVAILABLE_MODELS, lookupCatalog, STARTER_ID } from '../runtime/model-catalog.ts';
import { installModel, describeFetch, type FetchStatus } from '../runtime/model-install.ts';
import { buildRuntime } from '../core/runtime-setup.ts';
import { MachineCache } from '../runtime/machine.ts';
import { usesGguf, type LocalRuntime } from '../runtime/local-runtime.ts';
import { realSafeResolve } from '../agent/tools/paths.ts';
import { pullModel } from '../runtime/ollama-pull.ts';
import { repairLayout, preset, PRESETS, PANEL_KINDS, type Layout, DEFAULT_LAYOUT_ID } from './layout.ts';
import { repairTheme, baseTheme, THEMES, TOKENS, toCssVars, type Theme } from './theme.ts';
import { collectState } from './state.ts';
import { Attachments, MAX_BYTES } from './attachments.ts';
import { expandMentions, mentionBudget } from '../agent/mention.ts';
import { expandCommand, listCommands } from '../agent/commands.ts';
import { buildReport } from '../cli/report.ts';
import { saveReport } from '../cli/report-file.ts';
import { PreviewServer } from './preview.ts';
import { configPath, wireInProc, type AasConfig } from '../config.ts';
import { TaskRunner } from './tasks.ts';
import { describeServers } from '../mcp/tools.ts';
import { listenOrExplain } from '../core/listen.ts';
import { crossSiteReason } from './origin.ts';
import {
  RUNTIME_KINDS, KIND_LABELS, isRuntimeKind, readSavedRuntime, saveRuntime,
  inspectModelsDir, ensureDefaultModelsDir, savedModelsDir,
} from './settings.ts';
import {
  listGguf, chooseModel, tooBigForRam, looksLikeGguf, freePortFrom, INPROC_PORT, headsUp, CHOICE_WHY,
  type Backend,
} from '../runtime/inproc.ts';
import { totalmem } from 'node:os';
import { Session } from '../core/session.ts';
import type { ApprovalRequest, ApprovalAnswer } from '../agent/tools/types.ts';

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

/**
 * 本体が持っておく記録の行数。画面は開いたときにここから取り直す。
 *
 * 行を画面の DOM にしか持っていなかったので、配置を変える・パネルを出し入れする・
 * 設定を閉じる（描き直す）たびに全部消えた。既定の配置にログのパネルは無いので、
 * 後から開いても空だった（実機でそうなった）。ファイル（ui.log）には在るが、
 * 画面はそこを読まない。**本体が最近の分を持ち、画面はそれを取り直す。**
 */
export const RECENT_LOGS = 500;

export interface UiServerOptions {
  /** 立ち上げ直しを頼まれたとき。止めて、RESTART_EXIT で終わる側が持つ。 */
  onRestart?: () => void;
  /** 入口（start.cmd）が起こし直してくれるか。画面の案内が変わる。 */
  relaunches?: boolean;
  /** モデルを読むライブラリの差し替え。試験で使う。 */
  inprocLoad?: () => Promise<unknown>;
  /**
   * モデルを取ってくるときの通信の差し替え。試験で使う。
   *
   * **画面から押して、落ちて、置かれて、使えるところまで**を通すのに要る。
   * ここまで installModel 単体しか確かめておらず、**画面から押す道は
   * 誰も通していなかった。**
   */
  modelFetch?: typeof fetch;
  /** 困ったときの報告の中身を作る係のモック。試験で使う（本物は doctor を回して分単位）。 */
  buildReport?: () => Promise<string>;
  /** OS でファイルやフォルダを見せる係。試験でモックにできる（本物は explorer / open / xdg-open）。 */
  opener?: (command: string, args: string[]) => Promise<void>;
  config: AasConfig;
  port?: number;
  host?: string;
}

/** 画面へ流す出来事。CLI 側から呼んで、動いているものを見せる。 */
export type UiEvent =
  /** 記録の一行。seq は本体が振る（過去分の取り直しと、届いた分を重ねないため）。 */
  | { type: 'log'; level: 'info' | 'warn' | 'error'; text: string; seq?: number; at?: string }
  | { type: 'report'; state: 'running' | 'done' | 'failed' }
  | { type: 'plan'; items: unknown[] }
  | { type: 'stateChanged' }
  | { type: 'themeChanged' }
  /** 対話の出来事。そのまま画面へ流す。 */
  | { type: 'session'; event: unknown; conversationId?: string; seq?: number }
  /** 承認待ち。答えが来るまで作業は止まっている。 */
  | { type: 'approval'; id: string; request: ApprovalRequest }
  | { type: 'approvalDone'; id: string; approved: boolean }
  | { type: 'busy'; busy: boolean; conversationId?: string }
  /** 順番待ちの数。0 なら空。 */
  | { type: 'queue'; waiting: number }
  /** 会話の一覧が変わった。画面は取り直す。 */
  | { type: 'conversations' }
  /** やり残しの控えが動いた。画面に取り直させる。 */
  | { type: 'unfinished' }
  /** 戻り先が増えた・減った。画面の一覧を取り直させる。 */
  | { type: 'undo' }
  /** 暇なときの考えごと。送りは止めないが、動いていることは見せる。 */
  | { type: 'musing'; on: boolean }
  /** 分解して並列に働かせているときの出来事。 */
  | { type: 'planEvent'; event: unknown }
  /** 暇なときに考えたこと。放っておいても動いていることが見える。 */
  | { type: 'thinkEvent'; event: unknown }
  /** 点検の出来事。cmd の窓でしか見られなかったものを、画面へ出す。 */
  | { type: 'task'; name: string; text: string }
  | { type: 'taskDone'; name: string; code: number }
  /** 裏で動いているものの、いまの状態（流れではなく、状態そのもの）。 */
  | { type: 'jobs'; jobs: Job[] };

/**
 * 裏で動いているもの一つ。**最新の状態だけ。**
 *
 * 取得の進み具合は 1.5 秒ごとに記録へ流れていて、記録が埋まって読めなかった（実機）。
 * 仕事ごとに一つの状態を持ち、変わったときに全部を流す。画面は並べるだけ。
 */
export interface Job {
  kind: 'fetch' | 'load' | 'task' | 'report' | 'resume';
  id: string;
  title: string;
  state: 'running' | 'done' | 'failed';
  /** 最新の一言。 */
  detail: string;
  /** 始めた時刻（ISO）。経った秒は画面が数える。 */
  startedAt?: string;
  progress?: { pct: number };
}

export class UiServer {
  readonly #opts: UiServerOptions;
  readonly #clients = new Set<ServerResponse>();
  /** 最近の記録。画面が開き直したときに取り直す分。`RECENT_LOGS` 行まで。 */
  readonly #recentLogs: Array<{ seq: number; level: 'info' | 'warn' | 'error'; text: string; at: string }> = [];
  #logSeq = 0;
  #server?: ReturnType<typeof createServer>;
  /** 点検を回す係。状態（走っている子）はそちらが持つ。 */
  /** 記録をファイルにも残す。困ったときの報告に、ここから直近を入れる。 */
  readonly #logFile = new LogFile(join(stateDir(), 'logs', 'ui.log'));
  readonly #tasks = new TaskRunner({
    root: join(dirname(WEB_DIR), '..', '..'),
    reportsDir: join(stateDir(), 'reports'),
    onEvent: (e) => {
      this.broadcast(e.text !== undefined
        ? { type: 'task', name: e.name, text: e.text }
        : { type: 'taskDone', name: e.name, code: e.code ?? 1 });
      if (e.text === undefined) this.#jobsChanged();
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
  readonly #queue: Array<{ text: string; attached: string[]; conversationId: string }> = [];
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
  /** 画面が見ている会話。動いている会話とは別に持つ。 */
  #conversationId?: string;
  /**
   * いま本体（session）の履歴に載っている会話。
   *
   * 見ている会話と、動いている会話を分けた。前は一つの id しか無く、動いて
   * いる間は別の会話へ切り替えられなかった（「終わってから」と断っていた）。
   * 手が一つしか無いのは、使う側からすると有り得ない。
   * 履歴の載せ替えは、手が空いているときにだけやる。
   */
  #loadedId?: string;
  /** いま動いている会話。動いていなければ undefined。 */
  #runningId?: string;
  /**
   * 動いている一言の、ここまで。
   *
   * 動いている間に別の会話を見て戻ってくると、途中までの答えが**無かった**。
   * 出来事は見ている会話のものしか描かないので、離れていた間の分が消える。
   * 終わるまで「hi」だけが並び、終わった瞬間に答えが出る。
   * 戻ったとき（と、開き直したとき）にここを写す。`seq` は写した分と、
   * その後に流れてくる分を二度描かないための番号。
   */
  #inFlight?: { conversationId: string | undefined; asked: string; text: string; seq: number };
  /** どこまで残したか。ここから先を足す。 */
  #saved = 0;

  /**
   * 続きから読むときに、後ろから読む量。
   *
   * 半年ひとつの会話を続けると 16MB になる。丸ごと読むと 137ms かかり、
   * 10,800 通を抱えたまま動くことになるが、**窓に入るのは数十通**。
   * 残りは読んでも刈られて捨てられる。窓がいちばん広い形（32k）でも
   * 2MB あれば足りる。
   */
  static readonly RESTORE_TAIL = 2 * 1024 * 1024;
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
  /**
   * 止めたあとは、裏で動いていたものがセッションを作り直さない。
   *
   * 読み込みの最中に止めると、読み終えた側が `session()` から新しい
   * セッション（inproc の口）を立てて、止めたはずのプロセスが生き続けた
   * （テストの走りが終わらないことで見つけた）。
   */
  #stopped = false;

  /**
   * 起動したときに始めた読み込み。
   *
   * 送るときに読み始めると、最初の送信で数分待つ（CPU で本物を読むと
   * それだけかかる）。**起動したら裏で読んでおく。**その間も画面は使える。
   * 送りが来たらこれを待ってから答える。二重には読まない。
   */
  #preloading?: Promise<void>;
  /** いま読んでいるモデル。画面が後から繋いでも「読んでいる」と出せるように持つ。 */
  #loading?: { ref: string; began: number };

  /**
   * 裏でモデルを読んでおく（常時ロード）。
   *
   * `runtime.warm.enabled: false` なら読まない。この中で読む道（inproc）だけ。
   * 読めなかった理由は流れに出し、送ったときにもう一度、会話に出る。
   */
  async preload(): Promise<void> {
    if (this.#opts.config.runtime?.warm?.enabled === false) return;
    if ((this.#opts.config.runtime?.kind ?? 'inproc') !== 'inproc') return;
    if (this.#preloading) return this.#preloading;
    const run = this.#readyToThink(true)
      .then((notReady) => {
        if (notReady && notReady !== NOT_LOADED_YET) {
          this.broadcast({ type: 'log', level: 'warn', text: `先に読んでおけませんでした: ${notReady.split('\n')[0]}` });
        }
      })
      .catch((e: unknown) => {
        this.broadcast({ type: 'log', level: 'warn', text: `先に読んでおけませんでした: ${e instanceof Error ? e.message : String(e)}` });
      })
      .finally(() => { this.#preloading = undefined; });
    this.#preloading = run;
    return run;
  }
  /** モデルの土台。要るときに一度だけ組み立てる。 */
  #runtime?: LocalRuntime;
  /** 承認待ちの返事先。画面が答えるまで、ここで待っている。 */
  readonly #pending = new Map<string, (ok: ApprovalAnswer) => void>();
  /** 渡されたファイルの預かり所。 */
  readonly #attachments = new Attachments();
  /** 作っているものを見せる口。操作用とは**別の口**にする。 */
  #preview?: PreviewServer;
  #seq = 0;

  constructor(opts: UiServerOptions) {
    this.#opts = opts;
  }

  get url(): string { return this.#url; }

  /**
   * 待たずに走らせるものを、受け止める。
   *
   * **`void this.#drive(...)` と書いていた。**返事を待たない代わりに、
   * そこで例外が出たときの受け手も居ない。Node は拾い手のない例外で
   * プロセスごと落とすので、**書き込みが一度失敗しただけで画面が消える。**
   * `#drive` の中の `finally`（やり残しの控え・保存）は try の外なので、
   * 保存が失敗すれば必ずここへ抜けてくる。
   *
   * 落とさず、黙らせもしない。画面に理由を出して、走り続ける。
   */
  #bg(work: Promise<unknown>, what: string): void {
    void work.catch((e: unknown) => {
      const why = e instanceof Error ? e.message : String(e);
      this.broadcast({ type: 'log', level: 'error', text: `${what}: ${why}` });
    });
  }

  /** 画面へ流す。誰も見ていなくても落ちない。 */
  broadcast(event: UiEvent): void {
    // 画面に流すものの一部を、ファイルにも残す（記録・会話の終わり・落ちた理由）。
    if (event.type === 'log') {
      void this.#logFile.append(`[${event.level}] ${event.text}`).catch(() => undefined);
      // 番号を振って持っておく。画面は開いたとき取り直し、届いた分は番号で重ねない。
      const seq = ++this.#logSeq;
      const kept = { seq, level: event.level, text: event.text, at: new Date().toISOString() };
      this.#recentLogs.push(kept);
      if (this.#recentLogs.length > RECENT_LOGS) this.#recentLogs.splice(0, this.#recentLogs.length - RECENT_LOGS);
      event = { ...event, seq, at: kept.at };
    } else if (event.type === 'session') {
      const ev = event.event as { type?: string };
      if (ev.type === 'log' || ev.type === 'settled' || ev.type === 'finished') {
        void this.#logFile.append(`[session ${ev.type}] ${JSON.stringify(event.event).slice(0, 2000)}`).catch(() => undefined);
      }
    }
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
    await this.#pickInProcPort();
    // 前に渡された添付を片づける。その依頼が終われば要らない。
    // 溜めない。消したら、消した量を言う（黙って消さない）。
    void this.#attachments.sweep().then((freed) => {
      if (freed > 0) this.broadcast({ type: 'log', level: 'info', text: `前の添付を片づけました（${Math.round(freed / 1024)} KB）` });
    }).catch(() => undefined);
    return this.#url;
  }

  /**
   * モデルの口を、**始める前に決める。**
   *
   * この中で読む道は 4177 で待つ。もう一つ立ち上がっていたり、前のものが
   * 残っていたりすると埋まっていて、**モデルを読むところで初めて失敗する。**
   * 押した人には「モデルが読めない」としか見えない（この機械で三度踏んだ）。
   *
   * 空いている番号をここで選び、**設定へ書き戻す。**繋ぐ側は設定から
   * 組み立てるので、書き戻さないと待つ側と繋ぐ側が別の番号を向く。
   */
  async #pickInProcPort(): Promise<void> {
    const rc = this.#opts.config.runtime;
    if (rc?.kind !== 'inproc') return;
    const preferred = rc.basePort ?? INPROC_PORT;
    const free = await freePortFrom(preferred);
    if (free === undefined || free === preferred) return;
    rc.basePort = free;
    wireInProc(this.#opts.config);
    this.broadcast({
      type: 'log', level: 'info',
      text: `モデルの口 ${preferred} が埋まっていたので、${free} で待ちます`,
    });
  }

  /**
   * 対話の本体を用意する。
   * 承認は画面へ投げて、答えが返るまで待つ。
   * 誰も見ていない画面へ投げっぱなしにならないよう、待ち時間には上限を置く。
   */
  /**
   * 溜めておくもの（提案・当番・暇の配分）。**セッションより先に持つ。**
   *
   * 画面はこれを読むためだけに `session()` を呼んでいた。呼ぶと、モデルの
   * 一覧を取り・MCP の相手を起こし・先読みを始め・記憶を読み込む。
   * **利用者は画面を開いただけで、何も頼んでいない。**
   * MCP の相手が立ち上がらなければ 1 台につき最大 20 秒、その間この
   * やりとりを受ける入口が全部止まる。
   */
  #journals?: Journals;

  async journals(): Promise<Journals> {
    // セッションが在るなら、そちらと同じものを使う（二つ持つと食い違う）。
    if (this.#session) {
      return {
        proposals: this.#session.proposals,
        idle: this.#session.idle,
        duties: this.#session.duties,
      };
    }
    this.#journals ??= await loadJournals(this.#opts.config);
    return this.#journals;
  }

  async session(): Promise<Session> {
    if (this.#session) return this.#session;
    if (this.#stopped) throw new Error('止めています');
    this.#session = await Session.create(await this.#configForSession(), {
      journals: await this.journals(),
      approve: (req) => this.#ask(req),
      onLog: (level, text) => this.broadcast({ type: 'log', level, text }),
    });
    // 続きから話す。**土台は作り直しても、話は続ける。**
    const id = await this.#currentConversation();
    const past = await this.#conversations.load(id, { tailBytes: UiServer.RESTORE_TAIL });
    this.#session.restore(past);
    this.#loadedId = id;
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
    if ((config.runtime?.kind ?? 'inproc') !== 'inproc') return config;
    const loaded = this.#runtime?.id === 'inproc' ? this.#runtime.loaded() : [];
    const ref = loaded[0];
    if (!ref) return config;

    // **候補は `provider名:モデル名`。**名前だけを渡していたので、
    // どの provider のことか決まらず「全Providerが未登録」で即座に落ちた。
    // 画面には何も出ず、打っても返事が来ない。**それがこの不具合。**
    const local = config.providers.find(
      (pr) => pr.kind === 'openai-compatible' && pr.locality === 'local',
    );
    if (!local) return config;
    // 繋いだ先の一覧にも入れる。既定の名前（qwen3.6:35b… など）のままだと、
    // 置いてある GGUF がどこにも無いことになる。
    const providers = config.providers.map((pr) => (
      pr === local ? { ...pr, models: [ref] } : pr
    ));
    // **実際に開いた窓を渡す。**設定から見積もらせない。
    // 狭められたときは溢れ（返事が来なくなる）、広げたときは刈りすぎる。
    const window = this.#runtime?.windowOf?.(ref);
    const runtime = window
      ? { ...config.runtime, kind: 'inproc' as const, contextSize: window }
      : config.runtime;
    return { ...config, providers, candidates: [`${local.id}:${ref}`], runtime };
  }

  /**
   * 候補の無い土台を抱えていたら、組み直す。
   *
   * モデルを読む前に土台が組まれると（画面を開いただけでも組まれる）、
   * 候補が空のまま固定される。読み込んだ後も直らないので、
   * **打っても打っても即座に「使えるモデルがありません」で終わる。**
   */
  /** この会話で動いている一言の、ここまで。動いていなければ null。 */
  #inFlightFor(id: string): { asked: string; text: string; seq: number } | null {
    const f = this.#inFlight;
    return f && f.conversationId === id ? { asked: f.asked, text: f.text, seq: f.seq } : null;
  }

  /**
   * 受け取ったあとの続き。読んでいなければ読み、セッションを組み直し、走らせる。
   * 読んでいる間は #preparing で「手が塞がっている」ことにする（次の送信は積まれる）。
   */
  async #loadThenDrive(text: string, attached: string[], conversationId: string): Promise<void> {
    this.#preparing = true;
    try {
      const notReady = await this.#readyToThink();
      if (notReady) {
        // 会話にも出す。流れ（log）のパネルは既定の配置に無い。
        this.broadcast({ type: 'log', level: 'error', text: notReady });
        this.broadcast({ type: 'session', event: { type: 'log', level: 'error', text: notReady }, conversationId });
        this.broadcast({ type: 'stateChanged' });
        return;
      }
      // **読み込む前に組んだセッションを、抱えたままにしない。**
      // 候補が決まる前に組まれると、候補が空のまま固定される。
      // 以後どれだけ打っても 0.01 秒で「使えるモデルがありません」で終わる。
      await this.#rebuildIfCandidatesMissing();
      const session = await this.session();
      await this.#loadInto(session, conversationId);
      // 添付は依頼の前に置く。後ろに置くと、長い中身のせいで
      // 肝心の指示が末尾に押しやられて、モデルが取りこぼす。
      const full = await this.#compose(session, text, attached);
      this.#bg(this.#drive(session, full), '依頼の実行が落ちました');
    } finally {
      this.#preparing = false;
    }
  }

  async #rebuildIfCandidatesMissing(): Promise<void> {
    const live = this.#session;
    if (!live || live.candidates.length > 0) return;
    // 走っている・考えている間は組み直さない（#preparing は読んでいるだけなので構わない）。
    if (live.busy || this.#thinking) return;
    const fixed = await this.#configForSession();
    if (!fixed.candidates || fixed.candidates.length === 0) return;
    this.#session = undefined;
    await live.close().catch(() => undefined);
  }

  /**
   * いま話している会話。
   *
   * **開いた直後は、どれも開いていない（トップ）。**書き始めた時点で、
   * その一言のために新しい会話ができる。
   *
   * 前は、立ち上げ直すといちばん新しいものを勝手に続きとして開いていた。
   * 話しかけると、意図しない古い話の続きとして繋がる。**別の話を始める
   * ための場所が、どこにも無かった。**（横の一覧に古いものは並んでいるので、
   * 続きから話したいときは、そこから開く）
   */
  async #currentConversation(): Promise<string> {
    if (this.#conversationId) return this.#conversationId;
    this.#conversationId = (await this.#conversations.create()).id;
    return this.#conversationId;
  }

  /**
   * 本体の履歴に、その会話を載せる。**手が空いているときにだけ呼ぶ。**
   * 既に載っていれば何もしない。
   */
  async #loadInto(session: Session, id: string): Promise<void> {
    if (this.#loadedId === id) return;
    const past = await this.#conversations.load(id, { tailBytes: UiServer.RESTORE_TAIL });
    session.restore(past);
    this.#loadedId = id;
    this.#saved = past.length;
  }

  /**
   * 済んだ分を残す。
   *
   * **一往復ごとに書く。**終わりにまとめて書くと、途中で落ちたときに
   * その回のやりとりが丸ごと消える。道具の呼び出しと結果も残す
   * （続きを話すときに、その対応が要る）。
   */
  async #persist(session: Session): Promise<void> {
    // 残す先は、**本体に載っている会話**。画面が見ている会話ではない
    // （動いている間に別の会話を見に行けるので、二つは別）。
    const id = this.#loadedId ?? await this.#currentConversation();
    this.#loadedId = id;
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

    this.#idleTimer = setInterval(() => { this.#bg(this.idleTick(session), '手すきの見回りが落ちました'); }, every);
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
    if (this.#queue.length > 0) { this.#bg(this.#maybeDrain(), '順番待ちの取り出しが落ちました'); return 'BUSY'; }

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

  /**
   * この依頼のあいだ、書き込みをもう訊かない。
   *
   * 一度「残りも全部通す」と答えたら、その依頼が終わるまで立つ。
   * **依頼が変わったら倒す**（`#drive` の頭）。次の依頼まで持ち越さない。
   */
  #allWrites = false;

  #ask(req: ApprovalRequest): Promise<ApprovalAnswer> {
    const approval = this.#opts.config.agent?.approval ?? 'autoEdit';
    // 協議は自動承認の対象にしない。重大な変更は必ず人の目を通す。
    if (approval === 'auto' && req.kind !== 'deliberation') return Promise.resolve(true);
    if (approval === 'autoEdit' && req.kind === 'write') return Promise.resolve(true);
    /*
     * **一度そう言われたら、同じ依頼のあいだは訊き直さない。**
     *
     * 5 ファイル直すと 5 回訊かれる。1 回目で中身を見て納得しているのに、
     * 残り 4 回も同じ手を動かすことになる。人はそこで中身を見ずに押す
     * ようになり、承認そのものが形だけになる。
     *
     * 効くのは書き込みだけ。コマンドも、外へ出るのも、協議も、毎回訊く。
     */
    if (req.kind === 'write' && this.#allWrites) {
      this.broadcast({
        type: 'log', level: 'info',
        text: `${req.path} を書きました（この依頼のあいだは訊かない、を選んでいます）`,
      });
      return Promise.resolve(true);
    }

    const id = `a${++this.#seq}`;
    return new Promise<ApprovalAnswer>((resolve) => {
      let done = false;
      const finish = (ok: ApprovalAnswer) => {
        if (done) return;
        done = true;
        // 「残りも全部」を受け取ったら、ここで旗を立てる。返す答えは通常の許可。
        if (ok === 'all') { this.#allWrites = true; ok = true; }
        this.#pending.delete(id);
        this.broadcast({ type: 'approvalDone', id, approved: ok !== false });
        resolve(ok);
      };
      this.#pending.set(id, finish);
      this.broadcast({ type: 'approval', id, request: req });
      // 誰も答えないまま待ち続けない。返事が無いことは、許可ではない。
      const timer = setTimeout(() => finish(false), 10 * 60_000);
      timer.unref?.();
    });
  }

  /**
   * 止める。
   *
   * **どの段で時間がかかったかを言う。**止まらないときに黙っていると、
   * 「Ctrl-C が効かない」としか見えない（check:bundle が最後で固まって、
   * 何を待っているのか分からなかった）。2 秒を超えた段だけ名前を出す。
   */
  async stop(say: (line: string) => void = () => undefined): Promise<void> {
    this.#stopped = true;
    if (this.#idleTimer) clearInterval(this.#idleTimer);
    // 待っている承認は、答えが無いまま終わる。許可はしない。
    for (const finish of this.#pending.values()) finish(false);
    this.#pending.clear();
    const timed = async (what: string, run: () => Promise<unknown>) => {
      const began = Date.now();
      await run().catch(() => undefined);
      const took = Date.now() - began;
      if (took > 2000) say(`${what}に ${(took / 1000).toFixed(1)} 秒かかりました`);
    };
    await timed('会話を閉じるの', async () => this.#session?.close());
    // 自分の中に立てた口（inproc）も閉じる。閉じないと、画面を止めても
    // プロセスが生き続ける（検査が終わらないことで気づいた）。
    const runtime = this.#runtime as { shutdown?: () => Promise<void> } | undefined;
    await timed('モデルを降ろすの', async () => runtime?.shutdown?.());
    this.#runtime = undefined;
    for (const res of this.#clients) { try { res.end(); } catch { /* 切れている */ } }
    this.#clients.clear();
    // 開いたままの繋ぎ（keep-alive）も切る。close() は新しい繋ぎを断るだけで、
    // 残っている繋ぎが終わるまで返らない。
    this.#server?.closeAllConnections?.();
    await timed('口を閉じるの', () => new Promise<void>((resolve) => this.#server?.close(() => resolve()) ?? resolve()));
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
      // **作業場の根を知るためだけに、セッションを作らない。**
      const root = this.#workRoot();
      if (!this.#preview) {
        this.#preview = new PreviewServer({ root });
        await this.#preview.start();
      }
      return send(res, 200, { url: this.#preview.url, root });
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
      const typed = typeof body?.text === 'string' ? body.text.trim() : '';
      const attached = Array.isArray(body?.attachments)
        ? body.attachments.filter((a): a is string => typeof a === 'string')
        : [];
      if (!typed && attached.length === 0) return send(res, 400, { error: '指示が空です' });

      // 打ち込みのコマンド（/fix …）と作業場の skill。指示に置き換えてから送る。
      // 知らない名前は送らない。打ち間違いを、そのままモデルに渡さない。
      const expanded = await expandCommand(typed, this.#workRoot());
      if (expanded.kind === 'unknown') {
        return send(res, 400, {
          error: `コマンドがありません: /${expanded.name}（使えるのは ${expanded.known.map((n) => `/${n}`).join(' ')}）`,
        });
      }
      const text = expanded.text;
      if (expanded.kind === 'command') {
        const where = expanded.command.source === 'skill' ? `（${expanded.command.path}）` : '';
        this.broadcast({ type: 'log', level: 'info', text: `/${expanded.command.name} を使います${where}` });
      }

      // **モデルの有無を、いちばん先に見る。**
      // 会話の土台を組む段でも候補を決めるので、モデルが無いと
      // そこで落ちて 500 になる。利用者には「サーバの不具合」に見えるが、
      // 実際は「まだ置いていない」だけ。順番を逆にすると、そう言えなくなる。
      /*
       * **読み込みを待たせない。**
       *
       * ここは返事を返す前にモデルを読んでいた（`#readyToThink()`）。CPU で本物を
       * 読むと分単位かかり、送った側は 60 秒で時間切れになる（Windows の smoke で
       * 「送ったときの返り方」が落ちた）。読まないと分からないこと（GGUF が無い、
       * 載らない、別物）だけは先に見て 503 で断り、読むこと自体は受け取ってから
       * 裏でやる。進み具合は流れに出て、読めなければ会話に理由が出る。
       */
      this.#preparing = true;
      let mustLoad = false;
      try {
        const notReady = await this.#readyToThink(false);
        if (notReady && notReady !== NOT_LOADED_YET) return send(res, 503, { error: notReady });
        mustLoad = notReady === NOT_LOADED_YET;
      } finally {
        this.#preparing = false;
      }

      // どの会話への依頼か。トップからなら、ここで新しい会話ができる。
      // 見出しは**送った時点で**最初の一言から付ける。答えが返るまで
      // 「新しい会話」のまま並ぶと、どれがどれか分からない。
      const conversationId = await this.#currentConversation();
      if (typed) await this.#conversations.titleIfUnset(conversationId, typed).catch(() => undefined);
      this.broadcast({ type: 'conversations' });
      // **断らない。**書いたものを突き返されるのがいちばん不快で、
      // しかも書き直させることになる。動いている間は順番に積む。
      // 別の会話への依頼も積める（手が一つでも、口は会話ごと）。
      const live = this.#session;
      if (live && this.#busyNow(live)) {
        this.#queue.push({ text, attached, conversationId });
        this.broadcast({ type: 'queue', waiting: this.#queue.length });
        return send(res, 202, { queued: this.#queue.length, conversationId });
      }

      if (mustLoad) {
        // 受け取ったことだけ先に返し、読み込みと答えは出来事として流す。
        send(res, 202, { accepted: true, conversationId, loading: true });
        this.#bg(this.#loadThenDrive(text, attached, conversationId), '依頼の実行が落ちました');
        return;
      }

      this.#preparing = true;
      try {
        await this.#rebuildIfCandidatesMissing();
        const session = await this.session();
        await this.#loadInto(session, conversationId);
        // 添付は依頼の前に置く。後ろに置くと、長い中身のせいで
        // 肝心の指示が末尾に押しやられて、モデルが取りこぼす。
        const full = await this.#compose(session, text, attached);
        // 受け取ったことだけ先に返し、続きは出来事として流す。
        send(res, 202, { accepted: true, conversationId, loading: false });
        this.#bg(this.#drive(session, full), '依頼の実行が落ちました');
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
        this.#bg(this.#drivePlan(session, text), '段取りが落ちました');
      } finally {
        this.#preparing = false;
      }
      return;
    }

    if (path === '/api/proposals' && req.method === 'GET') {
      // **ここでセッションを作らない。**画面が開いた直後に読む所で、
      // 中身はどれもファイルから読めるもの。モデルは要らない。
      const { proposals, duties, idle } = await this.journals();
      return send(res, 200, {
        open: proposals.open(),
        duties: duties.status(Date.now()),
        due: duties.due(Date.now()).map((d) => d.duty.codename),
        idle: idle.stats(),
        spent: idle.spentThisHour(Date.now()),
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
      // 提案の実行文は、モデルが書いたもの。利用者の言葉として判じない。
      if (verdict === 'accepted' && !this.#busyNow(session)) {
        this.#bg(this.#drive(session, target.suggestedAction, undefined, { fromUser: false }), '提案の実行が落ちました');
      }
      return send(res, 200, { proposal: target });
    }

    // 更新は「見てから押す」の2段。押した瞬間に取ってくると、
    // 何が入るのか分からないまま新しくなる。
    // モデルの面倒。端末でしかできない状態だと、
    // 画面から使う人はモデルを用意することも乗り換えることもできない。
    if (path === '/api/models' && req.method === 'GET') {
      /*
       * **ここで session を作らない。**
       *
       * `session()` は、使えるモデルが一つも無いと投げる。この板は
       * **モデルが無いときにこそ開く板**なので、そこで 500 を返していた。
       * しかも session は、この先で一度も使っていなかった。
       *
       * 今までは、繋がらない Ollama の名前が「モデルがある」ことにして
       * いたので、この道が通らなかった。名前を消したら出てきた。
       */
      const runtime = await this.#localRuntime();
      const [installed, llama] = await Promise.all([
        runtime.list().catch(() => []),
        findInstalled(),
      ]);
      const dir = this.#opts.config.runtime?.modelsDir ?? modelsDir();
      return send(res, 200, {
        runtime: runtime.id,
        // GGUF を置く道では、絶対の道も返す。画面で開く・コピーするため（Ollama にはファイルが無い）。
        installed: installed.map((m) => ({ ref: m.ref, sizeBytes: m.sizeBytes, ...(usesGguf(runtime.id) ? { path: join(dir, m.ref) } : {}) })),
        llamaServer: llama ?? null,
        // どこを見ているか。「置いたのに出ない」を、画面の上で切り分けられる。
        modelsDir: dir,
        // 取ってきている最中か、失敗したか。**押した板に出すために返す。**
        fetching: this.#fetching ?? null,
        catalog: AVAILABLE_MODELS.map((m) => ({
          id: m.id, note: m.note, approxGB: m.approxGB,
          // GGUF を自分で置く道（llamacpp / inproc）では、置き場に入れる元を出す。
          // Ollama の名前を出しても、そちらでは使えない。
          ref: runtime.id === 'ollama' ? m.ollama : m.repo,
        })),
      });
    }

    if (path === '/api/models/newer' && req.method === 'GET') {
      // ここでも session を作らない。使っていないうえに、作ると外の
      // ツールまで立ち上がる。**新しい版が出ていないか訊くだけで、
      // そこまでしない。**
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
      // **セッションが無いなら、何も動いていない。**取ってくるために作らない。
      const live = this.#session;
      if (live && this.#busyNow(live)) {
        return send(res, 409, { error: 'いま作業中です。終わってからにしてください' });
      }
      const session = live ?? await this.session();
      const body = await readBody(req) as { id?: string };
      const id = String(body?.id ?? '');
      if (!id) return send(res, 400, { error: '名前がありません' });

      // 数GBかかるので、待たせずに始めて、進み具合は流し込む。
      this.#bg(this.#fetchModel(session, id), 'モデルの取得が落ちました');
      return send(res, 202, { started: id });
    }

    if (path === '/api/update' && req.method === 'GET') {
      // 新しい版が出ていないか見るだけ。**セッションは要らない。**
      return send(res, 200, await checkUpdate(this.#workRoot()));
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
      const body = await readBody(req) as { id?: string; approved?: boolean; hunks?: unknown; all?: boolean };
      const resolveIt = this.#pending.get(String(body?.id ?? ''));
      if (!resolveIt) return send(res, 404, { error: 'その承認は既に終わっています' });
      // 一部だけ通すときは、通す塊の番号が来る。
      const picked = Array.isArray(body?.hunks)
        ? body.hunks.filter((n): n is number => typeof n === 'number')
        : undefined;
      // 「この依頼のあいだは訊かない」。書き込みだけに効く。
      if (body?.approved === true && (body as { all?: unknown }).all === true) resolveIt('all');
      else if (body?.approved === true && picked && picked.length > 0) resolveIt({ hunks: picked });
      else resolveIt(body?.approved === true);
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

    /*
     * 話せる状態か。**開いた時点で訊けるようにする。**
     *
     * ここまで、モデルが無い機械では、送って初めて 503 の一行が返っていた。
     * 開いた人からは、書いて、送って、はじめて「まだ使えません」と分かる。
     * 開いた時点で手を引く。読み込みは始めない（頼まれるまで起こさない）。
     */
    if (path === '/api/ready' && req.method === 'GET') {
      const missing = await this.#readyToThink(false).catch(
        (e: unknown) => `見に行けませんでした: ${(e as Error).message}`);
      /*
       * **「まだ読んでいない」は、使えないことではない。**
       *
       * モデルは頼まれたときに読む（立ち上げた直後に数GBを読むと、何も
       * 頼んでいないのに機械が塞がる）。その状態をここで「まだ話せません」
       * として出していたので、**モデルを置いてある機械でも、開くたびに
       * 使えないと言われる。**言われた側は、置いたはずのものを疑いに行く。
       */
      const notReady = missing === NOT_LOADED_YET ? undefined : missing;
      // 読む前に、どれをどれだけ待って読むかを言う（GPU なしで大きいときだけ）。
      const heads = missing === NOT_LOADED_YET ? await this.#headsUp().catch(() => undefined) : undefined;
      /*
       * **初めて開いた人が、その場で使い始められるようにする。**
       *
       * 既定は「この中で読む」で、GGUF が一つも無ければ話せない。
       * 「設定 → モデル で決めてください」と言うだけでは、何を置けばいいか
       * 分からない。取ってこられるもの（最初の一つ）を一緒に返し、
       * 画面は一押しで取ってこられる形で出す。
       */
      const kindNow = this.#opts.config.runtime?.kind ?? 'inproc';
      const starter = lookupCatalog(STARTER_ID);
      const canFetch = notReady && kindNow === 'inproc' && starter
        ? {
          id: starter.id, approxGB: starter.approxGB,
          fetching: this.#fetching?.state === 'running',
          // 取ってきている最中なら、最新の一言も。押しボタンにそのまま出す。
          message: this.#fetching?.state === 'running' ? this.#fetching.message : '',
          // 取ってこられなかったなら、その理由と置き方も一緒に。ログを開かなくても分かるように。
          failed: this.#fetching?.state === 'failed' ? this.#fetching.message : '',
        }
        : null;
      return send(res, 200, { ready: !notReady, why: notReady ?? '', heads: heads ?? '', canFetch });
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
          kind: this.#opts.config.runtime?.kind ?? 'inproc',
          modelsDir: '',
          model: null,
          active: { kind: this.#opts.config.runtime?.kind ?? 'inproc', modelsDir: '' },
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
        // 読んでいる最中なら、その名前と経った秒数。画面はこれを帯に出す。
        // 流れの合図だけだと、繋ぐ前に流れた分は見えない（起動時の読み込みで実際にそうなる）。
        ...(this.#loading
          ? { loading: { ref: this.#loading.ref, seconds: Math.round((Date.now() - this.#loading.began) / 1000) } }
          : {}),
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
        // **なぜそれなのかも出す。**速い方へ勝手に乗り換える作りなので、
        // 名前だけ出しても「いつのまにか変わっている」に見える。
        why: this.#session?.modelReason ?? '',
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

    if (path === '/api/report' && req.method === 'GET') {
      return send(res, 200, { report: this.#report ?? null });
    }

    if (path === '/api/report' && req.method === 'POST') {
      if (this.#report?.state === 'running') return send(res, 409, { error: 'いま、まとめています' });
      this.#bg(this.#makeReport(), '報告のまとめが落ちました');
      return send(res, 202, { started: true });
    }

    if (path === '/api/commands' && req.method === 'GET') {
      const list = await listCommands(this.#workRoot());
      return send(res, 200, {
        commands: list.map((c) => ({ name: c.name, description: c.description, source: c.source, ...(c.path ? { path: c.path } : {}) })),
      });
    }

    if (path === '/api/jobs' && req.method === 'GET') {
      // 裏で動いているもの。開いた瞬間に、いまの状態が分かる（流れを遡らない）。
      return send(res, 200, { jobs: this.#jobs() });
    }

    if (path === '/api/logs' && req.method === 'GET') {
      // 最近の記録。画面のログのパネルが開いたときに取り直す。`after` より新しい分だけも取れる。
      const after = Number(url.searchParams.get('after') ?? '0');
      return send(res, 200, { lines: this.#recentLogs.filter((l) => l.seq > after) });
    }

    if (path === '/api/tasks' && req.method === 'GET') {
      // running は動いているものの名前の一覧（同じ名前は二重に回さない）。
      return send(res, 200, { tasks: TaskRunner.list(), running: this.#tasks.running });
    }

    if (path === '/api/task' && req.method === 'POST') {
      const body = await readBody(req) as { name?: string };
      const name = String(body?.name ?? '');
      const refused = this.#tasks.start(name);
      if (refused) return send(res, refused.includes('ありません') ? 400 : 409, { error: refused });
      this.#jobsChanged();
      // モデルが答えている最中に回すと、どちらも遅くなる（CPU は一つ）。
      // 診断の側は CPU を譲る（tasks.ts）。黙って遅くなるより、そう言う。
      const live = this.#session;
      if ((live && this.#busyNow(live)) || this.#preloading) {
        this.broadcast({ type: 'task', name, text: '（モデルが動いている最中です。診断は CPU を譲るので、いつもより時間がかかります）\n' });
      }
      return send(res, 200, { started: name });
    }

    if (path === '/api/task' && req.method === 'DELETE') {
      // 名前を渡せばそれだけ止める。渡さなければ全部（今までどおり）。
      const name = url.searchParams.get('name');
      return send(res, 200, { stopped: this.#tasks.stop(name ?? undefined) });
    }

    // 作業場の中身。**横の板に出すため。**どこで何を触っているのかが
    // 見えないまま指示を書くのは、暗い所で手探りをするのと同じ。
    /*
     * 画面の中でファイルを開いて、直して、保存する。
     *
     * ここまでは「ファイルは指示を通してだけ触る」と決めていた。触るのは
     * モデルで、人は見るだけ、という作りは、**直したい一行のために依頼を
     * 書かせる。**Cursor はその場で直せる。並べて劣る所を、そのまま残さない。
     *
     * 手で直したものも、モデルが直したものと同じ扱いにする。戻り先に残し、
     * 差分を「変更したファイル」へ出す。
     */
    if (path === '/api/file' && req.method === 'GET') {
      const asked = url.searchParams.get('path') ?? '';
      const real = await resolveInside(this.#workRoot(), asked);
      if (!real) {
        // 中を指しているが無い（404）のと、外を指している（400）のは別のこと。
        const lexical = relative(this.#workRoot(), resolvePath(this.#workRoot(), asked));
        const inside = asked !== '' && !isAbsolute(asked) && !lexical.startsWith('..') && !isAbsolute(lexical);
        return inside
          ? send(res, 404, { error: 'そのファイルはありません' })
          : send(res, 400, { error: '作業場の外は開けません' });
      }
      const info = await stat(real).catch(() => undefined);
      if (!info || !info.isFile()) return send(res, 404, { error: 'そのファイルはありません' });
      if (info.size > EDIT_MAX_BYTES) {
        return send(res, 413, { error: `大きすぎて画面では開けません（${Math.round(info.size / 1024)} KB。上限 ${EDIT_MAX_BYTES / 1024} KB）` });
      }
      const bytes = await readFile(real);
      // 途中に NUL があるものは文字のファイルではない。開いても壊すだけ。
      if (bytes.subarray(0, 8192).includes(0)) return send(res, 415, { error: '文字のファイルではないので、画面では開けません' });
      return send(res, 200, { path: asked, content: bytes.toString('utf8'), bytes: info.size });
    }

    if (path === '/api/file' && req.method === 'PUT') {
      const body = await readBody(req) as { path?: unknown; content?: unknown };
      const asked = typeof body?.path === 'string' ? body.path : '';
      const content = typeof body?.content === 'string' ? body.content : undefined;
      if (!asked || content === undefined) return send(res, 400, { error: 'path と content が要ります' });
      /*
       * **まだ無いファイルも書ける。**
       *
       * `resolveInside` は実体（realpath）で比べるので、まだ無い道は必ず「外」になり、
       * 新しいファイルを保存すると「作業場の外には書けません」と嘘を言っていた。
       * 無い道は、在る所まで遡って実体を見る（`realSafeResolve`。モデル側の write_file と同じ）。
       */
      const real = await this.#writablePath(asked);
      if (!real) return send(res, 400, { error: '作業場の外には書けません' });
      const session = this.#session;
      if (session && this.#busyNow(session)) {
        return send(res, 409, { error: 'いま作業中です。終わってから保存してください' });
      }
      const before = await readFile(real, 'utf8').catch(() => undefined);
      if (before === content) return send(res, 200, { saved: false, path: asked });
      const { added, removed } = await this.#writeByHand(asked, real, before, content, `手で直した: ${asked}`);
      return send(res, 200, { saved: true, path: asked, added, removed });
    }

    /*
     * Tab 補完。
     *
     * エディタで手が止まったら、前後を渡して続きを数行もらう。
     * **読み込んでいないモデルを、補完のために読みに行かない**（数GBを
     * 読むのに何分もかかる。それは頼まれたときにやる）。作業中も出さない
     * （同じモデルを取り合う）。一度に一つだけ。上限で諦めて、そこまでを返す。
     */
    if (path === '/api/complete' && req.method === 'POST') {
      const body = await readBody(req) as { path?: unknown; prefix?: unknown; suffix?: unknown };
      const asked = typeof body?.path === 'string' ? body.path : '';
      const prefix = typeof body?.prefix === 'string' ? body.prefix : '';
      const suffix = typeof body?.suffix === 'string' ? body.suffix : '';
      if (!asked) return send(res, 400, { error: 'path が要ります' });
      const missing = await this.#readyToThink(false).catch((e: unknown) => `見に行けませんでした: ${(e as Error).message}`);
      if (missing) return send(res, 200, { text: '', why: missing === NOT_LOADED_YET ? 'モデルをまだ読んでいません（一度話しかけると読みます）' : missing });
      const session = await this.session();
      if (this.#busyNow(session)) return send(res, 200, { text: '', why: '作業中です' });
      if (this.#completing) return send(res, 200, { text: '', why: '前の補完を待っています' });
      this.#completing = true;
      const ac = new AbortController();
      const giveUp = setTimeout(() => ac.abort(), UiServer.COMPLETE_WAIT_MS);
      let raw = '';
      let model = '';
      try {
        const input = buildCompletionInput(asked, prefix, suffix);
        for await (const ev of session.orchestrator.run({
          candidates: session.candidates, system: input.system, messages: input.messages,
          temperature: 0, maxTokens: 96,
        }, ac.signal)) {
          if (ev.type === 'text') raw += ev.delta;
          else if (ev.type === 'done') model = ev.modelId;
          else if (ev.type === 'failed') return send(res, 200, { text: '', why: ev.error.message });
          // 空行が来たら、そこで切って待たない。
          if (/\n\s*\n/.test(raw)) ac.abort();
        }
      } catch (e) {
        if (!ac.signal.aborted) return send(res, 200, { text: '', why: (e as Error).message });
      } finally {
        clearTimeout(giveUp);
        this.#completing = false;
      }
      return send(res, 200, { text: cleanCompletion(prefix, raw), model });
    }

    /*
     * 当てた変更を、塊ごと・行ごとに戻す。
     *
     * 「戻す」は 1 ターンまるごとしか戻せなかった。半分は良くて半分は要らない、
     * が扱えない。Cursor は当てたあとに Reject できる。差分の札から、
     * その塊・その行だけを戻す。
     */
    if (path === '/api/revert' && req.method === 'POST') {
      const body = await readBody(req) as { path?: unknown; diff?: unknown; picks?: unknown };
      const asked = typeof body?.path === 'string' ? body.path : '';
      const diff = typeof body?.diff === 'string' ? body.diff : '';
      const picks = Array.isArray(body?.picks)
        ? body.picks.filter((p): p is RevertPick => typeof p === 'object' && p !== null && typeof (p as { hunk?: unknown }).hunk === 'number')
        : [];
      if (!asked || !diff || picks.length === 0) return send(res, 400, { error: 'path・diff・picks が要ります' });
      const real = await resolveInside(this.#workRoot(), asked);
      if (!real) return send(res, 400, { error: '作業場の外には書けません' });
      const session = this.#session;
      if (session && this.#busyNow(session)) {
        return send(res, 409, { error: 'いま作業中です。終わってから戻してください' });
      }
      const current = await readFile(real, 'utf8').catch(() => undefined);
      if (current === undefined) return send(res, 404, { error: 'そのファイルはもうありません' });
      const after = revertLines(current, diff, picks);
      if (after === undefined) {
        return send(res, 409, { error: 'その後に中身が変わっているので、この差分では戻せません（エディタで直してください）' });
      }
      if (after === current) return send(res, 200, { reverted: false, path: asked });
      const { added, removed } = await this.#writeByHand(asked, real, current, after, `戻した: ${asked}`);
      return send(res, 200, { reverted: true, path: asked, added, removed });
    }

    /*
     * 道を OS で開く。
     *
     * 画面に道は出ていたが、開いて確かめる手が無く、打ち直すか貼り直すかしか
     * 無かった。開けるのは**このプログラムが使っている場所の中**だけ（作業場・モデル・
     * 記録・プログラム）。外の道を渡されても開かない（画面の口は、よその頁から
     * 叩けないようにしてあるが、それでも何でも開く口は作らない）。
     */
    if (path === '/api/open' && req.method === 'POST') {
      const body = await readBody(req) as { path?: unknown };
      const asked = typeof body?.path === 'string' ? body.path.trim() : '';
      if (!asked) return send(res, 400, { error: 'path が要ります' });
      if (foreignPath(asked) || !isAbsolute(asked)) return send(res, 400, { error: `この機械の絶対の道だけ開けます: ${asked}` });
      let real: string;
      try { real = await realpath(asked); } catch { return send(res, 404, { error: `ありません: ${asked}` }); }
      const roots = await Promise.all([
        this.#workRoot(), this.#opts.config.runtime?.modelsDir ?? modelsDir(), stateDir(), aasHome(), productRoot(), installRoot(),
      ].map((r) => realpath(r).catch(() => undefined)));
      const within = (root: string) => {
        const rel = relative(root, real);
        return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
      };
      if (!roots.some((r) => r !== undefined && within(r))) {
        return send(res, 403, { error: '開けるのは、このプログラムが使っている場所（作業場・モデル・記録・プログラム）の中だけです' });
      }
      const isDir = (await stat(real)).isDirectory();
      const { command, args } = revealCommand(process.platform, real, isDir);
      if (!this.#opts.opener && !canRun(command)) {
        return send(res, 501, { error: `この機械には開く命令（${command}）がありません。道をコピーして、手で開いてください` });
      }
      try {
        await (this.#opts.opener ?? revealWithOs)(command, args);
      } catch (e) {
        return send(res, 500, { error: `開けませんでした: ${(e as Error).message}` });
      }
      return send(res, 200, { opened: real, dir: isDir });
    }

    /*
     * 横の一覧から、ファイル・フォルダを作る。
     *
     * 作る道が無かった。エディタで新しい名前を保存しても「作業場の外」と断られ、
     * 画面からは一つも作れなかった。ファイルは空で作って、戻り先（undo）に
     * 「元々無かった」と控える（戻せば消える）。フォルダは戻り先に載らない
     * （空のフォルダを消すだけなので、消し方は普通のファイル操作に任せる）。
     */
    if (path === '/api/files/new' && req.method === 'POST') {
      const body = await readBody(req) as { path?: unknown; kind?: unknown };
      const asked = typeof body?.path === 'string' ? body.path.trim().replace(/\\/g, '/') : '';
      const kind = body?.kind === 'dir' ? 'dir' : body?.kind === 'file' ? 'file' : undefined;
      if (!asked || !kind) return send(res, 400, { error: 'path と kind（file か dir）が要ります' });
      if (asked.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) {
        return send(res, 400, { error: `その名前では作れません: ${asked}` });
      }
      const real = await this.#writablePath(asked);
      if (!real) return send(res, 400, { error: '作業場の外には作れません' });
      const session = this.#session;
      if (session && this.#busyNow(session)) {
        return send(res, 409, { error: 'いま作業中です。終わってから作ってください' });
      }
      if (await stat(real).then(() => true, () => false)) return send(res, 409, { error: `既にあります: ${asked}` });
      if (kind === 'dir') {
        await mkdir(real, { recursive: true });
        this.broadcast({ type: 'stateChanged' });
        return send(res, 200, { created: asked, kind });
      }
      await this.#writeByHand(asked, real, undefined, '', `作った: ${asked}`);
      return send(res, 200, { created: asked, kind });
    }

    if (path === '/api/files' && req.method === 'GET') {
      // **会話の土台を組まない。**組むとモデルの用意まで要ることになり、
      // モデルが無い機械では、ただの一覧が 500 で返る。
      const root = this.#workRoot();
      const asked = url.searchParams.get('path') ?? '';
      try {
        /*
         * **その機械のものでない道を、名前として作らない。**
         *
         * `C:\\Users\\...` のような Windows の道を linux で `resolve` すると、
         * 絶対の道ではなく**そういう名前のフォルダ**になる。無ければ作る、が
         * ここで効いて、いま居る所に `C:\\Users\\...` という名前のフォルダが
         * 出来た（実際に作った）。作った本人にも、何が起きたか分からない。
         */
        if (foreignPath(this.#opts.config.agent?.root)) {
          return send(res, 400, {
            error: `作業場に、この機械のものでない道が書かれています: ${this.#opts.config.agent?.root}\n`
              + '設定の agent.root を、この機械の道に直してください。',
          });
        }
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
      // **一覧を見ただけでは作らないし、勝手に開きもしない。**
      // どれも開いていない状態がトップで、そこから書けば新しい会話になる。
      // **出していない分を、黙って隠さない。**古いものは消えていない。
      const total = await this.#conversations.count();
      return send(res, 200, {
        current: this.#conversationId ?? null, running: this.#runningId ?? null,
        list, total, hidden: Math.max(0, total - list.length),
      });
    }

    if (path === '/api/conversations' && req.method === 'POST') {
      const session = this.#session;
      /*
       * **「新しい会話」は、トップへ戻ること。**ここでは作らない。
       *
       * 押すたびに作っていたので、書かずに閉じた分だけ空の見出しが並んだ。
       * 会話が要るのは最初の一言が来たときで、そこで作れば見出しも
       * その一言から付く（`#currentConversation`）。
       */
      this.#conversationId = undefined;
      // 動いている間は本体に触らない（見ている所だけトップへ）。
      if (session && !this.#busyNow(session)) {
        session.reset();
        this.#loadedId = undefined;
        this.#saved = 0;
      }
      this.broadcast({ type: 'conversations' });
      return send(res, 200, { current: null, messages: [], running: this.#runningId ?? null });
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

    /*
     * 戻せるようにする。
     *
     * **手元の小さいモデルは、間違った直しを当てる。**そのとき利用者に
     * できることが「自分で書き戻す」しか無いなら、任せられない。
     * git があってもコミット前は戻せないし、社用PCには git が無い。
     */
    if (path === '/api/undo' && req.method === 'GET') {
      // 戻せるものの一覧は、ファイルから読める。**セッションは要らない。**
      // ここは画面が開いた直後に読む所（横の一覧に出る）。
      const undo = this.#session?.undo ?? new UndoStore(this.#workRoot(), join(stateDir(), 'undo'));
      return send(res, 200, { list: await undo.list() });
    }

    if (path === '/api/undo' && req.method === 'POST') {
      const body = await readBody(req) as { id?: unknown };
      const id = typeof body?.id === 'string' ? body.id : '';
      if (!id) return send(res, 400, { error: 'id がありません' });
      const session = await this.session();
      // 動いている最中に戻すと、書いている途中のものと噛み合わない。
      if (this.#busyNow(session)) {
        return send(res, 409, { error: 'いま作業中です。終わってから戻してください' });
      }
      const done = await session.undo.restore(id);
      if (!done) return send(res, 404, { error: 'その戻り先はもうありません' });
      session.markChanged();
      this.broadcast({
        type: 'log', level: 'info',
        text: done.points > 1
          ? `${done.paths.length} 件のファイルを戻しました（${done.points} 回ぶん）: ${done.paths.join(', ')}`
          : `${done.paths.length} 件のファイルを戻しました: ${done.paths.join(', ')}`,
      });
      this.broadcast({ type: 'undo' });
      return send(res, 200, { paths: done.paths, points: done.points });
    }

    if (path === '/api/conversations/select' && req.method === 'POST') {
      const body = await readBody(req) as { id?: unknown };
      const id = typeof body?.id === 'string' ? body.id : '';
      if (!ID_SHAPE.test(id)) return send(res, 400, { error: '会話の名前が正しくありません' });
      const session = this.#session;
      const past = await this.#conversations.load(id, { tailBytes: UiServer.RESTORE_TAIL });
      // **動いている間も切り替えられる。**見るだけなら本体には触らない。
      // 手が空いているなら、その場で本体にも載せる。
      this.#conversationId = id;
      if (session && !this.#busyNow(session)) {
        session.restore(past);
        this.#loadedId = id;
        this.#saved = past.length;
      }
      this.broadcast({ type: 'conversations' });
      return send(res, 200, { current: id, messages: past, running: this.#runningId ?? null, inFlight: this.#inFlightFor(id) });
    }

    // 見出しを付け替える。**消して作り直させない。**
    if (path === '/api/conversations/title' && req.method === 'POST') {
      const body = await readBody(req) as { id?: unknown; title?: unknown };
      const id = typeof body?.id === 'string' ? body.id : '';
      if (!ID_SHAPE.test(id)) return send(res, 400, { error: '会話の名前が正しくありません' });
      if (typeof body?.title !== 'string') return send(res, 400, { error: '見出しがありません' });
      const renamed = await this.#conversations.rename(id, body.title)
        .then((t) => ({ title: t }), (e: unknown) => ({ error: (e as Error).message }));
      if ('error' in renamed) return send(res, 400, renamed);
      this.broadcast({ type: 'conversations' });
      return send(res, 200, { id, title: renamed.title });
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
      // **画面へ 16MB を投げない。**丸ごと返すと、開いた瞬間に固まる
      // （半年続けた会話で JSON が 5.5MB になった）。後ろから読む。
      const shown = await this.#conversations.load(id, { tailBytes: UiServer.RESTORE_TAIL });
      return send(res, 200, { id, messages: shown, inFlight: this.#inFlightFor(id) });
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
        // 遠くに繋ぐものは、見出しの名前も「要る合言葉」に数える。
        const heads = Object.values(spec.headersFrom ?? {});
        return {
          name,
          command: spec.url ?? `${spec.command ?? ''} ${(spec.args ?? []).join(' ')}`.trim(),
          remote: spec.url !== undefined,
          enabled: spec.enabled !== false,
          // 合言葉は名前だけ。値は決して出さない。
          secrets: [...wants, ...heads].map((from) => ({ name: from, set: process.env[from] !== undefined })),
          // 遠くに繋ぐものは、立ち上げるものが要らない。
          canRun: spec.url !== undefined || (spec.command !== undefined && canRun(spec.command)),
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

    /**
     * 繋ぎ先の見本帳。**形が決まっているものは、こちらが持っておく。**
     * 値は返さない（要る合言葉の名前と、入っているかどうかだけ）。
     */
    if (path === '/api/mcp/catalog' && req.method === 'GET') {
      const have = this.#opts.config.mcp?.servers ?? {};
      return send(res, 200, {
        // **元から入っているものは、繋ぐ先に並べない。**
        // 並べると、自前で持っている機能を npm 経由で入れ直させることになる。
        builtin: BUILTIN.map((b) => ({ id: b.id, name: b.name, about: b.about, tools: [...b.tools] })),
        entries: CATALOG.map((e) => ({
          id: e.id,
          name: e.name,
          about: e.about,
          remote: e.url !== undefined,
          hasLocal: e.local !== undefined || e.command !== undefined,
          needsNpx: needsNpx(e),
          unverified: e.unverified === true,
          retired: e.retired ?? null,
          connected: have[e.id] !== undefined,
          secrets: (e.secrets ?? []).map((sec) => ({
            env: sec.env, about: sec.about, where: sec.where ?? null,
            set: (process.env[sec.env] ?? '').trim() !== '',
          })),
        })),
      });
    }

    /**
     * 見本帳から一つ繋ぐ。
     *
     * 名前を一つ言えば繋がる。合言葉が要るものは、それだけ受け取る
     * （置き場の .env に書く。設定にも画面にも、値は出さない）。
     */
    if (path === '/api/mcp/connect' && req.method === 'POST') {
      const body = await readBody(req) as {
        id?: unknown; secrets?: unknown; enabled?: unknown; prefer?: unknown;
      };
      const entry = typeof body?.id === 'string' ? findEntry(body.id) : undefined;
      if (!entry) return send(res, 404, { error: `見本帳にありません: ${String(body?.id ?? '')}` });

      const given = (body?.secrets ?? {}) as Record<string, unknown>;
      const secrets: Record<string, string> = {};
      for (const [k, v] of Object.entries(given)) if (typeof v === 'string') secrets[k] = v;

      // 中身は会話からの道と同じものを使う。二つに書くと、片方だけ直る。
      const prefer = body?.prefer === 'local' ? 'local' as const : undefined;
      const got = await connectService(entry.id, {
        root: this.#workRoot(), secrets, enabled: body?.enabled !== false,
        ...(prefer ? { prefer } : {}),
      });
      if (!got.ok) return send(res, 400, { error: got.error ?? '繋げませんでした' });

      // **いまの土台を畳む。**外の道具は土台を組むときに立ち上がるので、
      // 畳まないと、繋いだのに次も繋がらない。会話は残してある。
      const live = this.#session;
      if (live && !this.#busyNow(live)) {
        this.#session = undefined;
        await live.close().catch(() => undefined);
      }
      this.#opts.config.mcp = {
        ...this.#opts.config.mcp,
        servers: {
          ...this.#opts.config.mcp?.servers,
          [entry.id]: {
            ...specFrom(entry, { root: this.#workRoot(), ...(prefer ? { prefer } : {}) }),
            enabled: body?.enabled !== false,
          },
        },
      };
      return send(res, 200, {
        id: got.id, path: got.path, missing: got.missing, notes: got.notes,
      });
    }

    /** 繋いだものを外す。設定から消すだけで、合言葉は残す。 */
    if (path === '/api/mcp/connect' && req.method === 'DELETE') {
      const id = url.searchParams.get('id') ?? '';
      const servers = { ...this.#opts.config.mcp?.servers };
      if (!servers[id]) return send(res, 404, { error: `繋いでいません: ${id}` });
      delete servers[id];
      await disconnectService(id);
      const live = this.#session;
      if (live && !this.#busyNow(live)) {
        this.#session = undefined;
        await live.close().catch(() => undefined);
      }
      this.#opts.config.mcp = { ...this.#opts.config.mcp, servers };
      return send(res, 200, { id, removed: true });
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

    /**
     * 覚え違いを消す。
     *
     * **人が消せない記憶は、溜まる一方になる。**重みで下げるだけでは、
     * 「そもそも間違っている」ものが残り続ける。
     */
    if (path === '/api/memory' && req.method === 'DELETE') {
      const id = url.searchParams.get('id') ?? '';
      const session = this.#session;
      if (!session) return send(res, 409, { error: 'まだ土台がありません。一度何か送ってください' });
      const gone = session.memory.forget(id);
      if (!gone) return send(res, 404, { error: `その覚えはありません: ${id}` });
      await session.memory.save().catch(() => undefined);
      this.broadcast({ type: 'stateChanged' });
      return send(res, 200, { id, forgotten: true });
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
  /** 保存先を読む。上限を過ぎたら、読めた分で返す（`slow`）。 */
  static readonly DIR_WAIT_MS = 4000;
  /** 補完を待つ上限。これを超えたら、そこまでを返す（無ければ空）。 */
  static readonly COMPLETE_WAIT_MS = 8000;
  #completing = false;

  async #readModelsDir(liveDir: string): Promise<{
    gguf: unknown[]; dirState: string; slow: boolean;
  }> {
    const read = (async () => ({
      gguf: await Promise.all((await listGguf(liveDir)).map(async (m) => ({
        ...m,
        // 絶対の道。画面で開く・コピーするため。
        path: join(liveDir, m.ref),
        tooBig: tooBigForRam(m.sizeBytes, totalmem()) ?? null,
        // 名前だけ .gguf の別物も、一覧で分かるように。
        notGguf: !(await looksLikeGguf(join(liveDir, m.ref))),
      }))),
      // GGUF が0件のとき、置き場そのものが無いのか、空なのかで打つ手が違う。
      dirState: await inspectModelsDir(liveDir),
      slow: false,
    }))();
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<{ gguf: unknown[]; dirState: string; slow: boolean }>((ok) => {
      timer = setTimeout(() => ok({ gguf: [], dirState: 'SLOW', slow: true }), UiServer.DIR_WAIT_MS);
      timer.unref?.();
    });
    // 読み切れなかった側は捨てる。落ちても、この応答を巻き込ませない。
    read.catch(() => undefined);
    return await Promise.race([read, late]).finally(() => clearTimeout(timer));
  }

  async #configView(res: ServerResponse): Promise<void> {
    // **保存してあるもの**を読む。立ち上げたときのものを見せると、
    // 保存した直後に古い値が出て「効いていない」ように見える。
    const saved = await readSavedRuntime();
    const active = this.#opts.config.runtime ?? {};
    // 書いてあるものが無ければ、いま読み込んだ既定（設定が無ければ inproc）を見せる。
    // ここだけ 'ollama' と決め打つと、既定で動いているものと画面の表示が食い違う。
    const kind = String(saved.kind ?? this.#opts.config.runtime?.kind ?? 'inproc');
    const dir = await savedModelsDir();
    // いま実際に読まれている置き場。保存した方と違うことがある。
    const liveDir = active.modelsDir ?? dir;
    return send(res, 200, {
      path: configPath(),
      kinds: RUNTIME_KINDS.map((id) => ({ id, name: KIND_LABELS[id] })),
      kind,
      modelsDir: dir,
      // 使うと決めた GGUF。無ければ置き場の最初の一つを読む。
      model: typeof saved.model === 'string' ? saved.model : null,
      // いま動いているもの。保存したものと違えば、立ち上げ直しが要る。
      active: {
        kind: active.kind ?? 'inproc', modelsDir: active.modelsDir ?? modelsDir(),
        // いま使っているモデル。保存した方（model）と違うことがある（選んだ直後・自動で選んだとき）。
        model: active.model ?? (this.#runtime?.id === 'inproc' ? this.#runtime.loaded()[0] : undefined) ?? null,
      },
      restartNeeded: kind !== (active.kind ?? 'inproc')
        || dir !== (active.modelsDir ?? modelsDir()),
      /*
       * 置き場にある GGUF。「置いたのに認識しない」を画面で確かめるための一覧。
       *
       * **いま読まれている置き場を見る。**保存した方（まだ効いていない）を
       * 見ていたので、設定に別の場所を書いてある機械では、取ってきたものが
       * 一覧に出なかった。落とす先と一覧が割れると、
       * 「用意できました」と出たのに使えない、になる。
       */
      /*
       * **保存先を読むのに、いつまでも待たない。**
       *
       * ここは保存先の中を一つずつ開いて中身まで見る（`looksLikeGguf`）。
       * 手元の SSD なら一瞬だが、繋がっていないドライブや、必要になるまで
       * 実体を持たない置き方（OneDrive など）だと、返ってこないことがある。
       * その間この応答が出ないので、**画面は選択肢が一つも無いまま止まる**
       * （動かし方の一覧まで空になる。実際にそう出た）。
       *
       * 待つのをやめて、読めた分だけ返す。読み切れなかったことは `slow` で言う。
       */
      ...(await this.#readModelsDir(liveDir)),
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
    /*
     * **選んだモデルは、その場で効かせる。**
     *
     * ここまで「これを使う」は設定ファイルに書くだけで、動いている側には
     * 入れず、読んでいるものも降ろさなかった。画面は前のモデルを出したまま
     * 「立ち上げ直すと効きます」と言う。作業場を変えたときは既にその場で
     * 効かせているのに、モデルだけ違っていた（Windows で実際にそうなった）。
     * 動かし方とモデルのフォルダが同じなら、いま読んでいるものを降ろし、セッションを畳んで、
     * 次の送信で選んだものを読む。作業中は畳めないので、そのときだけ立ち上げ直しを言う。
     */
    let modelRestart = false;
    const rcNow = this.#opts.config.runtime ?? {};
    const sameRuntime = kind === (rcNow.kind ?? 'inproc') && (dir || modelsDir()) === (rcNow.modelsDir ?? modelsDir());
    if (model !== undefined && sameRuntime && (model || undefined) !== rcNow.model) {
      const live = this.#session;
      if (live && this.#busyNow(live)) {
        modelRestart = true;
      } else {
        this.#opts.config.runtime = { ...rcNow, ...(model ? { model } : {}) };
        if (!model) delete this.#opts.config.runtime.model;
        const runtime = this.#runtime;
        if (runtime?.id === 'inproc') {
          for (const ref of runtime.loaded()) await runtime.unload(ref).catch(() => undefined);
        }
        if (live) {
          this.#session = undefined;
          await live.close().catch(() => undefined);
        }
        this.broadcast({ type: 'log', level: 'info', text: model ? `モデルを ${model} にしました。次の送信で読みます` : 'モデルの指定を外しました。次の送信で選び直します' });
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
      restartNeeded: workRestart || modelRestart
        || kind !== (this.#opts.config.runtime?.kind ?? 'inproc')
        || (dir || modelsDir()) !== (this.#opts.config.runtime?.modelsDir ?? modelsDir()),
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
  /**
   * 人の手で書く（エディタの保存・塊や行の戻し）。
   *
   * モデルの直しと同じ扱いにする。戻り先に残し、差分を「変更したファイル」と
   * 会話へ流す。ここを通らずに書くと、戻せない直しができる。
   */
  /**
   * 画面から書く先。在れば実体で、無ければ在る所まで遡った実体で、作業場の中かを見る。
   * 外・リンク越しの外・絶対の道は undefined。
   */
  async #writablePath(asked: string): Promise<string | undefined> {
    if (isAbsolute(asked) || foreignPath(asked)) return undefined;
    const root = this.#workRoot();
    return (await resolveInside(root, asked)) ?? await realSafeResolve(root, asked);
  }

  async #writeByHand(asked: string, real: string, before: string | undefined, content: string, request: string): Promise<{ added: number; removed: number }> {
    const session = this.#session;
    const undo = session?.undo ?? new UndoStore(this.#workRoot(), join(stateDir(), 'undo'));
    await undo.begin(request);
    undo.capture(asked, before);
    // 無い階層ごと作る（新しいファイルは、無いフォルダの中に置きたいことが多い）。
    await mkdir(dirname(real), { recursive: true });
    await writeFile(real, content, 'utf8');
    await undo.end().catch(() => undefined);
    session?.markChanged();
    const diff = unifiedDiff(asked, before ?? '', content);
    const { added, removed } = diffStat(diff);
    this.broadcast({ type: 'session', event: { type: 'diff', path: asked, diff, added, removed, created: before === undefined } });
    this.broadcast({ type: 'undo' });
    this.broadcast({ type: 'stateChanged' });
    return { added, removed };
  }

  /** 開いた時点の先の一言。中身は `headsUp`。ここは材料を揃えるだけ。 */
  async #headsUp(): Promise<string | undefined> {
    const runtime = await this.#localRuntime();
    if (runtime.id !== 'inproc') return undefined;
    const models = await runtime.list();
    const machine = await new MachineCache(join(stateDir(), 'machine.json')).get();
    const backend = await this.#backendOf(runtime);
    return headsUp(models, totalmem(), this.#opts.config.runtime?.model, {
      hasGpu: backend ? backend.gpu !== false : machine.gpuName !== undefined,
      ...(backend?.vramBytes ? { vramBytes: backend.vramBytes } : {}),
      ...(machine.gpuName !== undefined ? { seenGpu: machine.gpuName } : {}),
    });
  }

  /**
   * 読む側が実際に使う backend。**nvidia-smi に見えるかどうかでは決めない。**
   * 見えているのに CPU で回り、大きい方を選んで記憶を使い切った（実機）。
   * 取れなければ undefined（呼ぶ側が nvidia-smi の結果で代える）。
   * 起こせない・ライブラリが無い、はここで断らない。断るのは読むときの口。
   */
  async #backendOf(runtime: LocalRuntime): Promise<Backend | undefined> {
    if (!runtime.backend) return undefined;
    return runtime.backend().catch(() => undefined);
  }

  async #readyToThink(load = true): Promise<string | undefined> {
    const kind = this.#opts.config.runtime?.kind ?? 'inproc';
    // 起動時の読み込みが走っているなら、それを待つ。**二重に読まない。**
    // 待ったあとは、読めていればそのまま通り、読めていなければここで読み直す。
    if (load && this.#preloading) await this.#preloading.catch(() => undefined);
    try {
      const runtime = await this.#localRuntime();
      const models = await runtime.list();
      if (models.length > 0) {
        // この中で読む道では、**読むまで口が立たない。**
        // 先に読ませておかないと、上の層は繋がらない先を叩くことになる。
        if (runtime.id === 'inproc' && runtime.loaded().length === 0) {
          /*
           * **名前の順で先頭を掴まない。**
           *
           * ここは `models[0]`（名前で並べた先頭）を無条件で選んでいた。
           * 検証用に大小いくつも置いてある保存先では、たまたま名前が前に
           * 来た大きいほうが選ばれる。記憶に辛うじて載る大きさだと、
           * 追い出しが起きて読み込みが終わらない。**小さいものが同じ
           * フォルダに在っても見なかった。**
           */
          const wanted = this.#opts.config.runtime?.model;
          /*
           * **GPU が無いなら、小さい方を選ぶ。**
           *
           * ここは「載るもののうち、いちばん大きいもの」を選んでいた。
           * GPU の無い機械では、大きいほど読み込みも生成も遅いだけで、
           * 最初の送信で何分も待つことになる（返ってこないのと変わらない）。
           * 大きい方を使いたいときは、設定 → モデル で選べる。
           */
          const machine = await new MachineCache(join(stateDir(), 'machine.json')).get();
          // **読む側が実際に使う backend と VRAM で選ぶ。**nvidia-smi に見えるだけでは
          // GPU で読むとは限らず、VRAM を数えないと載り切らないものを選ぶ。
          const backend = await this.#backendOf(runtime);
          const hasGpu = backend ? backend.gpu !== false : machine.gpuName !== undefined;
          const picked = chooseModel(models, totalmem(), wanted, {
            hasGpu, ...(backend?.vramBytes ? { vramBytes: backend.vramBytes } : {}),
          });
          if (!picked) return undefined;
          const ref = picked.chosen.ref;
          // 記憶に載らないものを読みに行かない。落ちるか、何十分も固まる。
          if (!picked.fits) {
            const big = tooBigForRam(picked.chosen.sizeBytes, totalmem());
            const others = models.length > 1
              ? `\nこの保存先には ${models.length} 個ありますが、どれも載りません。`
              : '';
            return `${ref}: ${big ?? '記憶に載りません。'}${others}`;
          }
          // 名前だけ .gguf で中身が別物（配布元の HTML の案内など）を、読みに行かない。
          // 一覧と同じ場所（動いている側の置き場）を見る。保存側を見ると、
          // 立ち上げ直す前の設定とずれて「読めない」と嘘をつく。
          if (!(await looksLikeGguf(join(this.#opts.config.runtime?.modelsDir ?? modelsDir(), ref)))) {
            return `${ref} は GGUF として読めません（先頭に GGUF の印がありません）。`
              + '配布元の同意頁の HTML を落としてしまった形が多いです。ブラウザで開き直して、本物を置いてください。';
          }
          // 読まずに分かることはここまで。読むのは頼まれたときだけ。
          if (!load) return NOT_LOADED_YET;
          const gb = ((picked.chosen.sizeBytes ?? 0) / 1024 ** 3).toFixed(1);
          this.broadcast({
            type: 'log', level: 'info',
            text: `モデルを読み込んでいます: ${ref}（${gb}GB・${CHOICE_WHY[picked.why]}`
              + `${hasGpu ? '' : '・GPU を使わないので、初回は時間がかかります'}）`,
          });
          const began = Date.now();
          /*
           * **読んでいる間、黙らない。**
           *
           * ここは読み終わるまで一行も出さなかった。数GBを CPU へ載せる間、
           * 画面は「待機中」のまま何も言わない。**押した人には、送ったのに
           * 無視されたようにしか見えない**（実機でそうなった）。
           * 何%まで読めたかは下の層から取れないので、**経っている時間を出す。**
           */
          const ticking = setInterval(() => {
            this.broadcast({
              type: 'log', level: 'info',
              text: `まだ読み込んでいます: ${ref}（${Math.round((Date.now() - began) / 1000)} 秒）`,
            });
          }, 10_000);
          ticking.unref?.();
          /*
           * **読み込みの失敗を、一覧の失敗と混ぜない。**
           *
           * ここは外側の catch に落ちていたので、読み込めなかったときに
           * 「モデルの一覧を取れません」と出ていた。一覧は取れている。
           * しかも node-llama-cpp の中の文がそのまま出るので
           * （`The value of "size" is out of range ... Received 7_810_759_...`）、
           * 読んだ人には何をすればいいのか分からない。
           *
           * 実際に、**「モデルを読み込んでいます」から先へ進まないまま
           * 返事が来ない**という形で当たった。
           */
          this.#loading = { ref, began };
          this.#jobsChanged();
          try {
            await runtime.ensureLoaded(ref);
          } catch (e) {
            this.#loading = undefined;
            this.#jobsChanged();
            clearInterval(ticking);
            const detail = e instanceof Error ? e.message : String(e);
            this.broadcast({
              type: 'log', level: 'error', text: `読み込めませんでした: ${ref}`,
            });
            /*
             * **理由を、こちらで決めつけない。**
             *
             * 最初は「ファイルが途中までしか落ちていない」と決め打ちで
             * 書いていた。ライブラリ（node-llama-cpp）が読めないときにも
             * そう出るので、**嘘になる。**読む側は在るファイルを消しに行く。
             * 中で出た理由が既に具体的なら、それをそのまま先に出す。
             */
            const looksLikeFile = /gguf|magic|size|out of range|unexpected|parse/i.test(detail);
            const hint = looksLikeFile
              ? '**ファイルが途中までしか落ちていない**ことが多いです。'
                + '大きさを配布元と見比べて、違っていたら消して取り直してください。'
              : 'モデルのファイルではなく、**読む側**で止まっています。'
                + '設定 → モデル で、動かし方を選び直すこともできます。';
            return `${ref} を読み込めませんでした。\n${detail.slice(0, 300)}\n${hint}\n`
              + `保存先: ${this.#opts.config.runtime?.modelsDir ?? modelsDir()}`;
          }
          this.#loading = undefined;
          this.#jobsChanged();
          clearInterval(ticking);
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

  async #drive(
    session: Session, text: string, resuming?: string,
    opts: { fromUser?: boolean } = {},
  ): Promise<void> {
    // **依頼をまたいで持ち越さない。**「この依頼のあいだは訊かない」は、
    // その依頼のあいだだけ。次の依頼では、また訊く。
    this.#allWrites = false;
    // 動いている会話。出来事に添えて流す。画面は、見ている会話のものだけを描く。
    const conversationId = this.#loadedId;
    this.#runningId = conversationId;
    this.#inFlight = { conversationId, asked: text, text: '', seq: 0 };
    this.broadcast({ type: 'busy', busy: true, conversationId });
    // どう終わったか。**終わり方を見て、やり残しを控える。**
    let settled: { reason: string; verified: boolean; checked: string } | undefined;
    // 道具が実際に動いたか。**一段の合否は、言葉ではなくここで見る。**
    // 「では、このあと直します」と言っただけの回を「済んだ」と数えていた。
    let didSomething = false;
    try {
      for await (const event of session.send(text, opts)) {
        if (event.type === 'settled') {
          settled = { reason: event.reason, verified: event.verified, checked: event.checked };
        }
        if (event.type === 'toolEnd' && event.ok) didSomething = true;
        let seq: number | undefined;
        if (event.type === 'text' && this.#inFlight) {
          this.#inFlight.text += event.delta;
          seq = ++this.#inFlight.seq;
        }
        this.broadcast({ type: 'session', event, conversationId, ...(seq !== undefined ? { seq } : {}) });
      }
    } catch (e) {
      this.broadcast({ type: 'log', level: 'error', text: (e as Error).message });
    } finally {
      this.#inFlight = undefined;
      await this.#recordUnfinished(text, settled, resuming, didSomething);
      // 戻り先が増えたことを画面へ。**触ったのに出ていないと、
      // 戻せることに気づけない。**
      this.broadcast({ type: 'undo' });
      // 大きすぎて控えられなかったものは言う。戻せると思って戻せない、をなくす。
      const skipped = session.undo.takeSkipped();
      if (skipped.length > 0) {
        this.broadcast({
          type: 'log', level: 'warn',
          text: `大きすぎるので控えていません（戻せません）: ${skipped.join(', ')}`,
        });
      }
      // **残してから、次へ進む。**先に次を流すと、落ちたときに
      // その回のやりとりが消える。
      await this.#persist(session);
      this.#runningId = undefined;
      this.broadcast({ type: 'busy', busy: false, conversationId });
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
      const past = await this.#conversations
        .load(item.conversationId, { tailBytes: UiServer.RESTORE_TAIL })
        .catch(() => undefined);
      if (past) {
        this.#conversationId = item.conversationId;
        this.#saved = past.length;
        session.restore(past);
        this.broadcast({ type: 'conversations' });
      }
    }
    // 続きの文はこちらが組み立てたもの。利用者の言葉として判じない。
    this.#bg(
      this.#drive(session, resumePrompt(item), item.id, { fromUser: false })
        .finally(() => { this.#resuming = undefined; }),
      'やり残しの続きが落ちました',
    );
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
    this.#bg(
      this.#drive(
        session, stepPrompt(item.request, step.instruction, p.done + 1, p.total), item.id,
        { fromUser: false },
      )
        .finally(() => { this.#resuming = undefined; this.#step = undefined; }),
      '一歩ずつの実行が落ちました',
    );
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
    text: string, settled: { reason: string; verified: boolean; checked: string } | undefined,
    resuming?: string, didSomething = true,
  ): Promise<void> {
    // **済んだかどうかは「確かめて落ちていないこと」で見る。**
    // 「確かめて通った」を条件にすると、試験の無い作業場で
    // 何をしても永久に済まない（実際にそうなった）。
    const done = settled?.reason === 'completed' && settled.checked !== 'failed';
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
              setTimeout(() => { this.#bg(this.#continueStep(session2, item), '次の段が落ちました'); }, 100);
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
      // **溜めすぎて閉じた分も言う。**上限を超えると古い方から諦めるが、
      // それが見えないと、頼んだことが黙って消えたようにしか見えない。
      const dropped = this.#unfinished.takeDropped();
      if (dropped.length > 0) {
        this.broadcast({
          type: 'log', level: 'warn',
          text: `やり残しが溜まりすぎたので、古い方から ${dropped.length} 件を諦めました`
            + `（${dropped.map((d) => d.request.split('\n')[0]!.slice(0, 30)).join(' / ')}）`,
        });
      }
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
   * 送るものを組み立てる。添付を前に、指名を開いた依頼を後ろに。
   *
   * **上限は窓から決める。**固定の文字数だと、狭い窓では添付だけで溢れる
   * （窓 4096 の相手に 40,052 文字を渡していた。5 件なら 200,268 文字で 49 倍）。
   * 添付も指名も依頼の一部で、**刈る側は落とせない**。
   *
   * 取り分は一つで、添付が使った分を指名から引く。別々に取ると、
   * 合計を誰も見ていないことになる。
   *
   * ここに寄せているのは、**同じ組み立てが二か所にあった**ため。
   * 窓から決める形に直したとき、送り口だけ直して順番待ちの方が
   * 取り残されていた。
   */
  async #compose(session: Session, text: string, attached: string[]): Promise<string> {
    const room = mentionBudget(session.contextTokens);
    const extra = attached.length > 0
      ? await this.#attachments.describe(attached, { chars: room }).catch(() => '')
      : '';
    const named = await expandMentions(text, this.#workRoot(), {
      contextTokens: session.contextTokens,
      totalBytes: Math.max(400, room.total - extra.length),
    }).catch(() => ({ text, reads: [] }));
    for (const r of named.reads) {
      if (!r.ok) this.broadcast({ type: 'log', level: 'warn', text: `指名を読めません ${r.path}: ${r.body}` });
    }
    return extra ? `${extra}\n\n${named.text}` : named.text;
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
    await this.#loadInto(session, next.conversationId);
    const full = await this.#compose(session, next.text, next.attached);
    this.broadcast({ type: 'log', level: 'info', text: `順番待ちから続けます: ${next.text.split('\n')[0]?.slice(0, 60) ?? ''}` });
    this.#bg(this.#drive(session, full), '順番待ちの実行が落ちました');
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
    if (this.#stopped) throw new Error('止めています');
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
  /**
   * いま取ってきているもの、または最後に失敗したもの。
   *
   * **押した場所に結果を出すために持つ。**ここまで、失敗はログの板へ
   * 流すだけだった。押したのはモデルの板なので、**押した本人には何も
   * 見えない。**押しても永久に何も起きないように見える。**
   */
  #fetching: { id: string; state: 'running' | 'done' | 'failed'; message: string; began: number; progress?: FetchStatus } | undefined;

  /**
   * 困ったときの報告。**押した所に結果を出すために持つ。**
   *
   * 診断の一覧に混ぜていたが、あれは点検を回す所で、報告を作る所ではない。
   * ⚙ の「情報」に一つのボタンとして置き、出来たファイルの場所をそこに出す。
   */
  #report: { state: 'running' | 'done' | 'failed'; path?: string; message: string; began: number } | undefined;

  async #makeReport(): Promise<void> {
    const began = Date.now();
    this.#report = { state: 'running', message: 'まとめています（doctor を回すので 1〜2 分かかります）', began };
    this.broadcast({ type: 'report', state: 'running' });
    this.#jobsChanged();
    try {
      const root = join(dirname(WEB_DIR), '..', '..');
      const body = await (this.#opts.buildReport ?? (() => buildReport({
        root, state: stateDir(), home: aasHome(),
        models: this.#opts.config.runtime?.modelsDir ?? modelsDir(),
      })))();
      const saved = await saveReport('report', body, [join(stateDir(), 'reports'), root]);
      const sec = Math.round((Date.now() - began) / 1000);
      this.#report = saved.path
        ? { state: 'done', path: saved.path, message: `出来ました（${sec} 秒）。このファイルを一つ送ってください。`, began }
        : { state: 'failed', message: `ファイルに残せませんでした（${saved.why}）`, began };
    } catch (e) {
      this.#report = { state: 'failed', message: `まとめられませんでした: ${e instanceof Error ? e.message : String(e)}`, began };
    }
    this.broadcast({ type: 'report', state: this.#report.state });
    this.#jobsChanged();
  }

  /** 裏で動いているものの、いまの状態。 */
  #jobs(): Job[] {
    const jobs: Job[] = [];
    const f = this.#fetching;
    if (f) {
      jobs.push({
        kind: 'fetch', id: f.id, title: `モデルを取ってくる: ${f.id}`, state: f.state, detail: f.message,
        startedAt: new Date(f.began).toISOString(),
        ...(f.progress?.pct !== undefined ? { progress: { pct: f.progress.pct } } : {}),
      });
    }
    const l = this.#loading;
    if (l) {
      jobs.push({ kind: 'load', id: l.ref, title: `モデルを読み込む: ${l.ref}`, state: 'running', detail: '読み込んでいます', startedAt: new Date(l.began).toISOString() });
    }
    for (const name of this.#tasks.running) {
      const began = this.#tasks.startedAt(name);
      jobs.push({
        kind: 'task', id: name, title: `点検: ${TaskRunner.list().find((t) => t.id === name)?.name ?? name}`,
        state: 'running', detail: '回しています', ...(began ? { startedAt: new Date(began).toISOString() } : {}),
      });
    }
    const r = this.#report;
    if (r) jobs.push({ kind: 'report', id: 'report', title: 'サポート用レポート', state: r.state, detail: r.message, startedAt: new Date(r.began).toISOString() });
    if (this.#resuming) jobs.push({ kind: 'resume', id: this.#resuming, title: 'やり残しの続き', state: 'running', detail: this.#resuming });
    return jobs;
  }

  /** 裏の仕事の状態が変わった。全部を流す（画面は差分を追わず、並べ直すだけ）。 */
  #jobsChanged(): void {
    this.broadcast({ type: 'jobs', jobs: this.#jobs() });
  }

  async #fetchModel(session: Session, id: string): Promise<void> {
    const runtime = await this.#localRuntime();
    const entry = lookupCatalog(id);
    const began = Date.now();
    /*
     * **節目だけを記録に流す。**進み具合は状態（#fetching）として持ち、裏の仕事の
     * 一覧へ流す。1.5 秒ごとの行を記録と stateChanged で撒いていたので、記録が
     * 埋まって読めず、開いている全部の画面がそのたびに描き直していた（実機）。
     */
    const log = (text: string) => {
      this.#fetching = { id, state: 'running', message: text, began };
      this.broadcast({ type: 'log', level: 'info', text });
      this.#jobsChanged();
    };
    const status = (s: FetchStatus) => {
      this.#fetching = { id, state: 'running', message: describeFetch(s), began, progress: s };
      this.#jobsChanged();
    };
    this.#fetching = { id, state: 'running', message: '始めます…', began };
    this.broadcast({ type: 'stateChanged' });
    this.#jobsChanged();

    try {
      if (usesGguf(runtime.id)) {
        // **いま読んでいる側と同じ場所へ落とす。**
        //
        // 画面が保存した置き場（savedModelsDir）だけを見ていたので、
        // 設定（runtime.modelsDir）に別の場所を書いてある機械では、
        // **落とす先と読む先が割れる。**画面には「用意できました」と出るのに、
        // 一覧にも出ず、使えない。動いている側が読む場所を先に見る。
        const dir = this.#opts.config.runtime?.modelsDir ?? await savedModelsDir();
        await installModel({
          entry: entry ?? {
            id, repo: id, quant: 'q4_k_m', ollama: '', approxGB: 0, note: '', license: '',
          },
          modelsDir: dir,
          onProgress: log,
          onStatus: status,
          ...(this.#opts.modelFetch ? { fetchImpl: this.#opts.modelFetch } : {}),
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
      this.#fetching = { id, state: 'done', message: `用意できました: ${id}`, began };
      this.broadcast({ type: 'log', level: 'info', text: `用意できました: ${id}` });
    } catch (e) {
      /*
       * **行き止まりにしない。**
       *
       * ここまでは「取ってこられませんでした: …」で終わりだった。
       * 一覧の名前は**版が上がると変わる**（`unsloth/Qwen3.5-4B-GGUF` の
       * ような個別の名前を持っている以上、いつか必ず腐る）。腐った日に
       * 利用者にできることが無いと、そこで詰まる。
       *
       * この作りは元から「GGUF を1つ置くだけ」で動く。落とせなかったときは、
       * **選び方と置き場所**を言う。名前を覚えてもらうのではなく、
       * 選び方を覚えてもらえば、名前が変わっても困らない。
       */
      // **一つの文にする。**二つに分けると、読む側は下の行を見落とす。
      const text = `取ってこられませんでした: ${e instanceof Error ? e.message : String(e)}\n${byHand(modelsDir())}`;
      // 押した板にも残す。ログの板は閉じていることがある。
      this.#fetching = { id, state: 'failed', message: text, began };
      this.broadcast({ type: 'log', level: 'error', text });
    }
    this.broadcast({ type: 'stateChanged' });
    this.#jobsChanged();
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
    // 何も無い（入れた直後）なら、既定の配置。名前を決め打ちにしていて、
    // 既定を Cursor の形に変えたあとも、入れた直後だけ古い形が出ていた。
    return { layout: preset(DEFAULT_LAYOUT_ID), repairs: [] };
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

/**
 * その道が、いま動いている機械のものでないか。
 *
 * Windows の `C:\\...` を linux で使うと、絶対の道ではなく**名前**になる。
 * 逆（linux の `/home/...` を Windows で）は絶対の道として扱われるので、
 * 名前になってしまうこちら側だけを止める。
 */
/**
 * まだ読んでいないだけ、を表す合図。
 *
 * 「無い」と「まだ読んでいない」は別。**同じ顔で出すと、置いてある人にも
 * 「使えません」と言うことになる。**文面の一致で判じないよう、名前で持つ。
 */
/** 画面で開くファイルの上限。これより大きいものは、画面のエディタでは扱わない。 */
const EDIT_MAX_BYTES = 2 * 1024 * 1024;
const NOT_LOADED_YET = 'モデルをまだ読んでいません（頼まれたときに読みます）';

/** OS で開いて見せる。起こしたら手を離す（閉じるまで待たない）。 */
function revealWithOs(command: string, args: string[]): Promise<void> {
  return new Promise((ok, ng) => {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.once('error', ng);
    child.once('spawn', () => { child.unref(); ok(); });
  });
}

export function foreignPath(p: string | undefined): boolean {
  if (typeof p !== 'string' || p.length === 0) return false;
  return process.platform !== 'win32' && /^[A-Za-z]:[\\/]/.test(p);
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

/**
 * 手で置く道を案内する。
 *
 * 一覧の名前は版が上がると変わるので、**名前ではなく選び方**を渡す。
 * NetVision が同じ理由で個別のファイル名を書かず、選び方だけ書いている
 * （「版が上がると名前が変わるので、個別のファイル名は書きません」）。
 */
export function byHand(dir: string): string {
  return [
    '名前は版が上がると変わります。手で置くこともできます（GGUF を1つ置くだけです）。',
    '  ・落とす先: https://huggingface.co/Qwen （名前に GGUF が付いたもの）',
    '  ・大きさ: 軽い読み書きなら 3B〜4B、コードを書かせるなら 7B 以上',
    '  ・量子化: 迷ったら Q4_K_M（品質と大きさの釣り合いが良い）',
    `  ・置き場所: ${dir}`,
    '  置いたら、設定の画面から選べます。',
  ].join('\n');
}
