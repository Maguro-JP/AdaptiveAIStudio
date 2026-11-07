/**
 * 取りに行く段（docs/NETWORK-MODEL.md の段階 3）。
 *
 * 蔵に無い問いを、外の配布元から取る。Node の公式文書（nodejs.org の API の JSON）と npm の登録先。行き先は許可リスト、GET だけ、資格情報は送らない。
 * 取ったものは検問（`inspectInbound`、置いてあれば二段目の Inspector）を通し、通ったものだけを出どころつきで蔵に入れる。
 * 繋がらない・止められたときは何も入れず、理由を返す（呼ぶ側は蔵だけで続ける）。
 */
import { inspectInbound } from '../harness/gate.ts';
import { type Inspector, combine } from '../harness/inspector.ts';
import { builtinModules } from 'node:module';
import { checkHost } from '../agent/tools/network.ts';
import type { KnowledgeEntry, KnowledgeShelf } from './knowledge.ts';

/** 取ってきた生の答え。 */
export interface Fetched {
  answer: string;
  sourceUrl: string;
  version?: string;
}

/** 配布元。試験では偽物を渡す。 */
export interface KnowledgeSource {
  fetch(question: string, signal: AbortSignal): Promise<Fetched | undefined>;
}

/** 取りに行ってよい行き先。公式文書と npm の登録先だけで始める。 */
export const SOURCE_ALLOWED_HOSTS = ['registry.npmjs.org', 'nodejs.org'];

/** 1件の答えの長さの上限（文字数）。私の推測で決めた値。 */
const MAX_ANSWER_CHARS = 700;

/** 問いから npm の包みの名前を拾う。拾えなければ undefined。 */
export function packageNameOf(question: string): string | undefined {
  const m = /(@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)/i.exec(question.normalize('NFKC'));
  const name = m?.[1]?.toLowerCase();
  if (!name || name.length < 2 || /^\d/.test(name)) return undefined;
  return name;
}

/** npm の登録先から、包みの最新の版と説明を取る。 */
export class NpmRegistrySource implements KnowledgeSource {
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  constructor(opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}) {
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#timeoutMs = opts.timeoutMs ?? 5000;
  }

  async fetch(question: string, signal: AbortSignal): Promise<Fetched | undefined> {
    const name = packageNameOf(question);
    if (!name) return undefined;
    const url = `https://registry.npmjs.org/${name.replace('/', '%2F')}/latest`;
    checkHost(url, new Set(SOURCE_ALLOWED_HOSTS));
    const res = await this.#fetch(url, {
      method: 'GET', credentials: 'omit', redirect: 'error',
      headers: { accept: 'application/json' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.#timeoutMs)]),
    });
    if (!res.ok) return undefined;
    const body = await res.json() as { name?: unknown; version?: unknown; description?: unknown };
    if (typeof body.version !== 'string') return undefined;
    const desc = typeof body.description === 'string' ? ` ${body.description}` : '';
    return { answer: `${name} の最新は ${body.version}。${desc}`.trim(), sourceUrl: url, version: body.version };
  }
}

/** 問いから Node の組み込みの名前（`node:util` の `util`）と、探す名前（`diff`）を拾う。拾えなければ undefined。 */
export function nodeApiOf(question: string): { module: string; names: string[] } | undefined {
  const q = question.normalize('NFKC');
  const mods = new Set(builtinModules.filter((m) => !m.startsWith('_') && !m.includes('/')));
  const words = [...q.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)].map((m) => m[0]);
  const prefixed = /node:([a-z_]+)/i.exec(q)?.[1]?.toLowerCase();
  const dotted = /\b([a-z_]+)\.[A-Za-z_]/.exec(q)?.[1]?.toLowerCase();
  const module = [prefixed, dotted].find((m) => m && mods.has(m))
    ?? (/node/i.test(q) ? words.map((w) => w.toLowerCase()).find((w) => mods.has(w)) : undefined);
  if (!module) return undefined;
  const skip = new Set(['node', module]);
  const names = words.filter((w) => !skip.has(w.toLowerCase()) && w.length >= 2);
  return { module, names };
}

interface DocNode { textRaw?: unknown; name?: unknown; desc?: unknown; [k: string]: unknown }

/** HTML を素の文字にする（タグを外し、よく出る実体参照を戻す）。 */
function plain(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\n{3,}/g, '\n\n').trim();
}

/** Node の公式文書の JSON から、名前の合う項目を探す。 */
export function findDoc(root: unknown, names: readonly string[]): DocNode | undefined {
  const want = names.map((n) => n.toLowerCase());
  let best: DocNode | undefined;
  let bestRank = Infinity;
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) { for (const x of n) walk(x); return; }
    if (!n || typeof n !== 'object') return;
    const d = n as DocNode;
    if (typeof d.name === 'string' && typeof d.desc === 'string') {
      const leaf = d.name.toLowerCase().split('.').at(-1)!;
      const rank = want.indexOf(leaf);
      if (rank >= 0 && rank < bestRank) { best = d; bestRank = rank; }
    }
    for (const k of ['modules', 'methods', 'classes', 'properties', 'globals', 'classMethods']) walk(d[k]);
  };
  walk(root);
  return best;
}

/** nodejs.org の API の文書（`/api/<名前>.json`）から、関数や型の説明と例を取る。 */
export class NodeDocsSource implements KnowledgeSource {
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  constructor(opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}) {
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#timeoutMs = opts.timeoutMs ?? 8000;
  }

  async fetch(question: string, signal: AbortSignal): Promise<Fetched | undefined> {
    const api = nodeApiOf(question);
    if (!api || api.names.length === 0) return undefined;
    const url = `https://nodejs.org/api/${api.module}.json`;
    checkHost(url, new Set(SOURCE_ALLOWED_HOSTS));
    const res = await this.#fetch(url, {
      method: 'GET', credentials: 'omit', redirect: 'error',
      headers: { accept: 'application/json' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.#timeoutMs)]),
    });
    if (!res.ok) return undefined;
    const doc = findDoc(await res.json(), api.names);
    if (!doc || typeof doc.desc !== 'string') return undefined;
    const head = typeof doc.textRaw === 'string' ? plain(doc.textRaw) : String(doc.name);
    return { answer: `${head}（node:${api.module}）: ${plain(doc.desc)}`, sourceUrl: url };
  }
}

/** Node の組み込みの話なら公式文書、それ以外は npm の登録先。 */
export class DefaultSource implements KnowledgeSource {
  readonly #node: KnowledgeSource;
  readonly #npm: KnowledgeSource;
  constructor(opts: { fetchImpl?: typeof fetch } = {}) {
    this.#node = new NodeDocsSource(opts);
    this.#npm = new NpmRegistrySource(opts);
  }

  async fetch(question: string, signal: AbortSignal): Promise<Fetched | undefined> {
    // 組み込みの話を npm へ回さない（「node」という包みの版を、組み込みの知識として入れてしまう）
    if (nodeApiOf(question)) return this.#node.fetch(question, signal);
    return this.#npm.fetch(question, signal);
  }
}

/** アプリで取りに行くか。`AAS_KNOWLEDGE_FETCH=0` で止める。node --test の中（試験）では既定で止める（本物のネットワークに出ない）。 */
export function fetchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.AAS_KNOWLEDGE_FETCH?.trim();
  if (v === '0' || v === 'off') return false;
  if (v === '1' || v === 'on') return true;
  return env.NODE_TEST_CONTEXT === undefined;
}

export type GatherResult =
  | { status: 'stored'; entry: KnowledgeEntry }
  | { status: 'none' | 'blocked' | 'failed'; reason: string };

/** 取って、検問を通して、蔵に入れる。 */
export async function gather(
  question: string, source: KnowledgeSource, shelf: KnowledgeShelf, signal: AbortSignal,
  opts: { inspector?: Inspector; now?: () => Date } = {},
): Promise<GatherResult> {
  let got: Fetched | undefined;
  try { got = await source.fetch(question, signal); } catch (e) {
    return { status: 'failed', reason: `取れませんでした: ${(e as Error).message}` };
  }
  if (!got || typeof got.answer !== 'string' || !got.answer.trim()) return { status: 'none', reason: '答えがありませんでした' };
  try { checkHost(got.sourceUrl, new Set(SOURCE_ALLOWED_HOSTS)); } catch (e) {
    return { status: 'blocked', reason: (e as Error).message };
  }
  const answer = got.answer.slice(0, MAX_ANSWER_CHARS);
  let verdict = inspectInbound(answer);
  if (verdict.passed && opts.inspector) {
    verdict = combine(verdict, await opts.inspector.inspect(answer, 'inbound', signal), 'inbound');
  }
  if (!verdict.passed) return { status: 'blocked', reason: verdict.findings.map((f) => f.kind).join(', ') || '検問で止めました' };
  const entry = await shelf.upsert({
    question, answer, sourceUrl: got.sourceUrl, fetchedAt: (opts.now?.() ?? new Date()).toISOString(),
    ...(got.version !== undefined ? { version: got.version } : {}),
  });
  return { status: 'stored', entry };
}
