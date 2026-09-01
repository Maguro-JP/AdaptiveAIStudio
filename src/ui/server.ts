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
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateDir } from '../core/autopilot-setup.ts';
import { aasHome, binDir, modelsDir, isPortable, productRoot } from '../core/home.ts';
import { currentVersion, describeVersion } from '../core/version.ts';
import { checkUpdate, applyUpdate } from '../core/update.ts';
import { findInstalled } from '../runtime/llama-install.ts';
import { findNewerOllama } from '../runtime/model-updates.ts';
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
import { listGguf } from '../runtime/inproc.ts';
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

export interface UiServerOptions {
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
  #idleTimer?: ReturnType<typeof setInterval>;
  #thinking = false;
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
      try { res.write(line); } catch { this.#clients.delete(res); }
    }
  }

  async start(): Promise<string> {
    const host = this.#opts.host ?? '127.0.0.1';
    const port = this.#opts.port ?? 4174;
    const server = createServer((req, res) => {
      this.#handle(req, res).catch((e: unknown) => {
        // 画面の不具合で本体を落とさない。
        send(res, 500, { error: e instanceof Error ? e.message : String(e) });
      });
    });
    this.#server = server;

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });
    // 0 を渡すと空いている口を選ぶ。実際に決まった番号を使う。
    const addr = server.address();
    const actual = typeof addr === 'object' && addr ? addr.port : port;
    this.#url = `http://${host}:${actual}/`;
    return this.#url;
  }

  /**
   * 対話の本体を用意する。
   * 承認は画面へ投げて、答えが返るまで待つ。
   * 誰も見ていない画面へ投げっぱなしにならないよう、待ち時間には上限を置く。
   */
  async session(): Promise<Session> {
    if (this.#session) return this.#session;
    this.#session = await Session.create(this.#opts.config, {
      approve: (req) => this.#ask(req),
      onLog: (level, text) => this.broadcast({ type: 'log', level, text }),
    });
    this.#startThinking(this.#session);
    return this.#session;
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

    this.#idleTimer = setInterval(() => {
      // 作業中は考えない。人の依頼が先。
      if (session.busy || this.#thinking) return;
      this.#thinking = true;
      void (async () => {
        try {
          for await (const event of session.think()) {
            this.broadcast({ type: 'thinkEvent', event });
          }
        } catch { /* 考えに失敗しても、この場所は止まらない */ } finally {
          this.#thinking = false;
        }
      })();
    }, every);
    this.#idleTimer.unref?.();
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
    for (const res of this.#clients) { try { res.end(); } catch { /* 切れている */ } }
    this.#clients.clear();
    await new Promise<void>((resolve) => this.#server?.close(() => resolve()) ?? resolve());
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

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

      const session = await this.session();
      if (session.busy) return send(res, 409, { error: 'いま別の作業をしています' });

      // **先に確かめる。**モデルが無いまま送ると、繋ぎ先を待ち続けて
      // 画面は「考え中」のまま止まる。利用者からは固まったようにしか見えない。
      const missing = await this.#readyToThink();
      if (missing) return send(res, 503, { error: missing });

      // 添付は依頼の前に置く。後ろに置くと、長い中身のせいで
      // 肝心の指示が末尾に押しやられて、モデルが取りこぼす。
      const extra = attached.length > 0 ? await this.#attachments.describe(attached) : '';
      const full = extra ? `${extra}\n\n${text}` : text;

      // 受け取ったことだけ先に返し、続きは出来事として流す。
      send(res, 202, { accepted: true });
      void this.#drive(session, full);
      return;
    }

    if (path === '/api/plan' && req.method === 'POST') {
      const body = await readBody(req) as { text?: string };
      const text = typeof body?.text === 'string' ? body.text.trim() : '';
      if (!text) return send(res, 400, { error: '依頼が空です' });

      const session = await this.session();
      if (session.busy) return send(res, 409, { error: 'いま別の作業をしています' });

      // **先に確かめる。**モデルが無いまま送ると、繋ぎ先を待ち続けて
      // 画面は「考え中」のまま止まる。利用者からは固まったようにしか見えない。
      const missing = await this.#readyToThink();
      if (missing) return send(res, 503, { error: missing });

      send(res, 202, { accepted: true });
      void this.#drivePlan(session, text);
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
      if (verdict === 'accepted' && !session.busy) void this.#drive(session, target.suggestedAction);
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
        return send(res, 200, { findings: await findNewerOllama({ installed }) });
      } catch (e) {
        return send(res, 502, { error: e instanceof Error ? e.message : String(e) });
      }
    }

    if (path === '/api/models/get' && req.method === 'POST') {
      const session = await this.session();
      if (session.busy) return send(res, 409, { error: 'いま作業中です。終わってからにしてください' });
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
      if (session.busy) return send(res, 409, { error: 'いま作業中です。終わってから更新してください' });
      const result = await applyUpdate(session.root);
      return send(res, result.ok ? 200 : 409, result);
    }

    if (path === '/api/think' && req.method === 'POST') {
      const session = await this.session();
      if (session.busy || this.#thinking) return send(res, 409, { error: 'いま別の作業をしています' });
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
      const saved = await readConfigFile();
      const active = this.#opts.config.runtime ?? {};
      const kind = String(saved.kind ?? 'ollama');
      const dir = String(saved.modelsDir ?? modelsDir());
      return send(res, 200, {
        path: configPath(),
        kinds: RUNTIME_KINDS.map((id) => ({ id, name: KIND_LABELS[id] })),
        kind,
        modelsDir: dir,
        // いま動いているもの。保存したものと違えば、立ち上げ直しが要る。
        active: { kind: active.kind ?? 'ollama', modelsDir: active.modelsDir ?? modelsDir() },
        restartNeeded: kind !== (active.kind ?? 'ollama')
          || dir !== (active.modelsDir ?? modelsDir()),
        // 置き場にある GGUF。「置いたのに認識しない」を画面で確かめられるように。
        gguf: await listGguf(dir),
      });
    }

    if (path === '/api/config' && req.method === 'PUT') {
      const body = await readBody(req) as { kind?: string; modelsDir?: string };
      const kind = String(body?.kind ?? '');
      if (!(RUNTIME_KINDS as readonly string[]).includes(kind)) {
        return send(res, 400, { error: 'そういう動かし方はありません' });
      }
      const dir = typeof body?.modelsDir === 'string' ? body.modelsDir.trim() : '';
      const at = configPath();
      // 既にあるものを読んで、**触ると決めたところだけ**書き換える。
      // 丸ごと書き直すと、画面から見えない設定を消してしまう。
      let current: Record<string, unknown> = {};
      try {
        current = JSON.parse(await readFile(at, 'utf8')) as Record<string, unknown>;
      } catch { /* まだ無い */ }
      const runtime = { ...(current.runtime as Record<string, unknown> ?? {}), kind };
      if (dir) runtime.modelsDir = dir;
      else delete runtime.modelsDir;
      await writeFile(at, `${JSON.stringify({ ...current, runtime }, null, 2)}\n`, 'utf8');
      this.broadcast({ type: 'log', level: 'info', text: `設定を書きました: ${at}` });
      return send(res, 200, {
        path: at,
        saved: { kind, modelsDir: dir || null },
        // 動かし方の切り替えは、立ち上げ直すまで効かない。黙って効いた顔をしない。
        restartNeeded: kind !== (this.#opts.config.runtime?.kind ?? 'ollama')
          || (dir || modelsDir()) !== (this.#opts.config.runtime?.modelsDir ?? modelsDir()),
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
        model: this.#opts.config.runtime?.model ?? '—',
      });
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
  async #readyToThink(): Promise<string | undefined> {
    const kind = this.#opts.config.runtime?.kind ?? 'ollama';
    try {
      const runtime = await this.#localRuntime();
      const models = await runtime.list();
      if (models.length > 0) {
        // この中で読む道では、**読むまで口が立たない。**
        // 先に読ませておかないと、上の層は繋がらない先を叩くことになる。
        if (runtime.id === 'inproc' && runtime.loaded().length === 0) {
          const ref = models[0]!.ref;
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
      this.broadcast({ type: 'busy', busy: false });
      // 作業で記憶やファイルが動いている。画面の材料を取り直させる。
      this.broadcast({ type: 'stateChanged' });
    }
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
    this.#runtime = await buildRuntime(this.#opts.config, machine);
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
        const dir = this.#opts.config.runtime?.modelsDir ?? modelsDir();
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

/** 保存してある設定の runtime だけを読む。無ければ空。 */
async function readConfigFile(): Promise<Record<string, unknown>> {
  try {
    const raw = JSON.parse(await readFile(configPath(), 'utf8')) as Record<string, unknown>;
    return (raw.runtime as Record<string, unknown>) ?? {};
  } catch {
    return {};
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return undefined; // 直す側が既定に落としてくれる
  }
}
