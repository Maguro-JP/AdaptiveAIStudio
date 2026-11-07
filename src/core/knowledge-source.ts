/**
 * 取りに行く段（docs/NETWORK-MODEL.md の段階 3）。
 *
 * 蔵に無い問いを、外の配布元から取る。今は npm の登録先だけ。行き先は許可リスト、GET だけ、資格情報は送らない。
 * 取ったものは検問（`inspectInbound`、置いてあれば二段目の Inspector）を通し、通ったものだけを出どころつきで蔵に入れる。
 * 繋がらない・止められたときは何も入れず、理由を返す（呼ぶ側は蔵だけで続ける）。
 */
import { inspectInbound } from '../harness/gate.ts';
import { type Inspector, combine } from '../harness/inspector.ts';
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
const MAX_ANSWER_CHARS = 400;

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
