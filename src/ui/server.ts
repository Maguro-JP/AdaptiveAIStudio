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
import { repairLayout, preset, PRESETS, PANEL_KINDS, type Layout } from './layout.ts';
import { collectState } from './state.ts';
import type { AasConfig } from '../config.ts';
import { Session } from '../core/session.ts';
import type { ApprovalRequest } from '../agent/tools/types.ts';

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), 'web');
const LAYOUT_PATH = () => join(stateDir(), 'layout.json');

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
  /** 対話の出来事。そのまま画面へ流す。 */
  | { type: 'session'; event: unknown }
  /** 承認待ち。答えが来るまで作業は止まっている。 */
  | { type: 'approval'; id: string; request: ApprovalRequest }
  | { type: 'approvalDone'; id: string; approved: boolean }
  | { type: 'busy'; busy: boolean };

export class UiServer {
  readonly #opts: UiServerOptions;
  readonly #clients = new Set<ServerResponse>();
  #server?: ReturnType<typeof createServer>;
  #url = '';
  #session?: Session;
  /** 承認待ちの返事先。画面が答えるまで、ここで待っている。 */
  readonly #pending = new Map<string, (ok: boolean) => void>();
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
    return this.#session;
  }

  #ask(req: ApprovalRequest): Promise<boolean> {
    const approval = this.#opts.config.agent?.approval ?? 'autoEdit';
    if (approval === 'auto') return Promise.resolve(true);
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

    if (path === '/api/send' && req.method === 'POST') {
      const body = await readBody(req) as { text?: string };
      const text = typeof body?.text === 'string' ? body.text.trim() : '';
      if (!text) return send(res, 400, { error: '指示が空です' });

      const session = await this.session();
      if (session.busy) return send(res, 409, { error: 'いま別の作業をしています' });

      // 受け取ったことだけ先に返し、続きは出来事として流す。
      send(res, 202, { accepted: true });
      void this.#drive(session, text);
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

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return undefined; // 直す側が既定に落としてくれる
  }
}
