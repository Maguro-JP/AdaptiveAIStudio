/**
 * 作っているものを、その場で見る。
 *
 * HTML や CSS は、書けても見えなければ作れない。
 * 書き換えたら勝手に読み直す口を、作業場に向けて開く。
 *
 * **操作用の画面とは別の口（別ポート）で出す。**
 * 同じ口から作業物を出すと、書いたページが `/api/send` を叩けてしまう。
 * 作りかけのページや、外から持ち込んだ雛形が、この道具を動かせては困る。
 * 口を分ければ、ブラウザの側が別の出所として扱うので、これが起きない。
 *
 * 出すのは作業場の中だけ。`..` で外へは出られない。
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat, readdir } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { join, extname, relative, sep } from 'node:path';
import { safeResolve } from '../agent/tools/paths.ts';
import { listenOrExplain } from '../core/listen.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

/**
 * 読み直しの仕掛け。HTML にだけ差し込む。
 *
 * 書き換えるたびに手で読み直すのは、作っている最中いちばん邪魔になる。
 * 差し込みは末尾に置く。頭に入れると、こちらの都合で行番号がずれる。
 */
export const RELOAD_SNIPPET = `
<script>
// AdaptiveAIStudio — 書き換えを見て、勝手に読み直す
(() => {
  let es;
  const connect = () => {
    es = new EventSource('/__reload');
    es.onmessage = () => location.reload();
    // 相手が落ちても諦めない。立ち上げ直したら繋がってほしい。
    es.onerror = () => { es.close(); setTimeout(connect, 1000); };
  };
  connect();
})();
</script>`;

export function inject(html: string): string {
  // </body> があればその手前、無ければ末尾。
  const at = html.toLowerCase().lastIndexOf('</body>');
  return at >= 0 ? html.slice(0, at) + RELOAD_SNIPPET + html.slice(at) : html + RELOAD_SNIPPET;
}

/** 作業場の中の一覧を、そのまま見られる形にする。 */
/** HTML に文字として入れる。名前は作業場のもの＝モデルや外から来たものが付けうる。 */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>
  )[c]!);
}

export function listing(dir: string, entries: { name: string; isDir: boolean }[]): string {
  // 名前をそのまま HTML に流し込まない。作業場のファイル名はモデルが付ける
  // ことも、外から来たものが付けることもある。`"><script>` という名前の
  // ファイル一つで、この頁が書き換えられる。
  const rows = entries
    .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
    .map((e) => `<li><a href="${encodeURIComponent(e.name)}${e.isDir ? '/' : ''}">${e.isDir ? '📁 ' : '📄 '}${escapeHtml(e.name)}</a></li>`)
    .join('\n');
  const title = escapeHtml(dir);
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>
 body{font:14px system-ui,sans-serif;margin:2rem;background:#0f1116;color:#dfe3ec}
 a{color:#7aa2f7;text-decoration:none} a:hover{text-decoration:underline}
 ul{list-style:none;padding:0;line-height:1.9} h1{font-size:1rem;color:#8e97a8;font-weight:500}
</style>
<h1>${title}</h1><ul>${rows}</ul>${RELOAD_SNIPPET}`;
}

export interface PreviewOptions {
  /** 作業場。ここより外は出さない。 */
  root: string;
  port?: number;
  /** 見張らない（試験など） */
  watch?: boolean;
}

/**
 * 作業場を見せる小さな口。
 *
 * 作るものが決まっていないので、静的に配るだけにしてある。
 * 組み立てが要るもの（Vite など）は、利用者が自分で立ち上げて、
 * その口をこの板に映せばよい。**こちらが決め打ちにしない。**
 */
export class PreviewServer {
  readonly #opts: PreviewOptions;
  #server?: Server;
  #watcher?: FSWatcher;
  #listeners = new Set<ServerResponse>();
  #port = 0;
  /** 書き換えが続けて来たときに、まとめて一度だけ知らせる。 */
  #timer?: NodeJS.Timeout;

  constructor(opts: PreviewOptions) {
    this.#opts = opts;
  }

  get port(): number { return this.#port; }
  get url(): string { return `http://127.0.0.1:${this.#port}/`; }

  async start(): Promise<string> {
    this.#server = createServer((req, res) => { void this.#handle(req, res); });
    // 既定は 0（空いている口）。番号を渡されたときは塞がりうる。
    this.#port = await listenOrExplain(this.#server, { port: this.#opts.port ?? 0, what: '見る窓' });

    if (this.#opts.watch !== false) this.#startWatching();
    return this.url;
  }

  stop(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#watcher?.close();
    for (const res of this.#listeners) res.end();
    this.#listeners.clear();
    this.#server?.close();
    this.#server = undefined;
  }

  /** 見ている人へ、読み直せと伝える。 */
  notify(): void {
    for (const res of this.#listeners) res.write('data: change\n\n');
  }

  #startWatching(): void {
    try {
      this.#watcher = watch(this.#opts.root, { recursive: true }, (_e, name) => {
        // 中身と関係ない場所は無視する。保存のたびに読み直されると鬱陶しい。
        if (typeof name === 'string' && /(^|[\\/])(\.git|node_modules)([\\/]|$)/.test(name)) return;
        // 保存は何度も起きる。まとめて一度だけ知らせる。
        if (this.#timer) clearTimeout(this.#timer);
        this.#timer = setTimeout(() => this.notify(), 80);
        this.#timer.unref?.();
      });
    } catch {
      // 見張れない場所（一部の環境）でも、配ることはできる。
    }
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname === '/__reload') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(': つながりました\n\n');
      this.#listeners.add(res);
      req.on('close', () => { this.#listeners.delete(res); });
      return;
    }

    const wanted = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const abs = wanted === '' ? this.#opts.root : safeResolve(this.#opts.root, wanted);
    if (!abs) {
      // 作業場の外。何があるかも言わない。
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('作業場の外は見せません');
      return;
    }

    const info = await stat(abs).catch(() => undefined);
    if (!info) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('ありません');
      return;
    }

    if (info.isDirectory()) {
      // index.html があれば、それを見せる。無ければ一覧。
      const index = join(abs, 'index.html');
      if (await stat(index).then(() => true, () => false)) {
        return this.#sendFile(res, index);
      }
      const names = await readdir(abs, { withFileTypes: true }).catch(() => []);
      const rel = relative(this.#opts.root, abs).split(sep).join('/') || '/';
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(listing(rel, names.map((d) => ({ name: d.name, isDir: d.isDirectory() }))));
      return;
    }

    return this.#sendFile(res, abs);
  }

  async #sendFile(res: ServerResponse, abs: string): Promise<void> {
    const type = TYPES[extname(abs).toLowerCase()] ?? 'application/octet-stream';
    const data = await readFile(abs).catch(() => undefined);
    if (!data) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('読めません');
      return;
    }
    if (type.startsWith('text/html')) {
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(inject(data.toString('utf8')));
      return;
    }
    // 作っている最中なので、溜め込ませない。古いものが出続けるのがいちばん困る。
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(data);
  }
}
