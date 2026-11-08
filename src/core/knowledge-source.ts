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
  /** 今の事実（天気など）。蔵に残さず、この頼みでだけ使う。 */
  ephemeral?: boolean;
}

/** 配布元。試験では偽物を渡す。 */
export interface KnowledgeSource {
  fetch(question: string, signal: AbortSignal): Promise<Fetched | undefined>;
}

/** 取りに行ってよい行き先。公式文書と npm の登録先、天気（Open-Meteo。鍵が要らない）。 */
export const SOURCE_ALLOWED_HOSTS = ['registry.npmjs.org', 'nodejs.org', 'geocoding-api.open-meteo.com', 'api.open-meteo.com'];

/** 場所が書かれていない天気の問いに使う場所の既定。私の推測で決めた値（docs/DECISIONS.md）。 */
export const DEFAULT_LOCATION = '東京';

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

/** 天気の問いか（天気、気温、雨、降水、雪、晴れ、傘）。 */
export function isWeatherQuestion(question: string): boolean {
  return /天気|気温|降水|雨|雪|晴れ|傘|weather|forecast/i.test(String(question ?? '').normalize('NFKC'));
}

/** 日の言い方 → 今日から何日先か。書かれていなければ明日（1）。 */
export function dayOffsetOf(question: string): number {
  const q = question.normalize('NFKC');
  if (/明々後日|しあさって/.test(q)) return 3;
  if (/明後日|あさって/.test(q)) return 2;
  if (/明日|あした|あす|tomorrow/i.test(q)) return 1;
  if (/今日|きょう|本日|今|today/i.test(q)) return 0;
  return 1;
}

/** 問いから場所の名前を拾う（「大阪の天気」「札幌は雨?」の「大阪」「札幌」）。拾えなければ undefined。 */
export function placeOf(question: string): string | undefined {
  const q = question.normalize('NFKC').replace(/[?？!！。、\s]+/g, ' ');
  const skip = /^(明々後日|明後日|明日|今日|本日|今週|週末|あした|あす|きょう|あさって|しあさって|この辺|ここ|今|現在|この先)$/;
  const re = /([\p{Script=Han}\p{Script=Katakana}ー]{1,8}|[A-Za-z][A-Za-z .-]{1,30}?)(?:市|県|都|府)?\s*(?:の|は|って|で)\s*(?:明々後日|明後日|明日|今日|あした|あす|きょう)?\s*(?:の)?\s*(?:天気|気温|降水|雨|雪|晴れ|weather)/u;
  for (let rest = q; rest;) {
    const m = re.exec(rest);
    if (!m) return undefined;
    const name = m[1]!.trim();
    if (!skip.test(name)) return name;
    rest = rest.slice(m.index + m[0].length);
  }
  return undefined;
}

/** WMO の天気の番号 → 日本語。 */
function weatherWord(code: number): string {
  if (code === 0) return '快晴';
  if (code <= 2) return '晴れ';
  if (code === 3) return 'くもり';
  if (code <= 48) return '霧';
  if (code <= 57) return '霧雨';
  if (code <= 67) return '雨';
  if (code <= 77) return '雪';
  if (code <= 82) return 'にわか雨';
  if (code <= 86) return 'にわか雪';
  return '雷雨';
}

/**
 * 天気。Open-Meteo（鍵が要らない）。場所の名前を緯度経度にし、日ごとの予報から指定の日を取る。日本時間で日を切る。
 * 今の事実なので、蔵に残さない（`ephemeral`）。
 */
export class WeatherSource implements KnowledgeSource {
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #location: () => string;
  constructor(opts: { fetchImpl?: typeof fetch; timeoutMs?: number; location?: () => string } = {}) {
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#timeoutMs = opts.timeoutMs ?? 8000;
    this.#location = opts.location ?? (() => DEFAULT_LOCATION);
  }

  async #get(url: string, signal: AbortSignal): Promise<unknown> {
    checkHost(url, new Set(SOURCE_ALLOWED_HOSTS));
    const res = await this.#fetch(url, {
      method: 'GET', credentials: 'omit', redirect: 'error',
      headers: { accept: 'application/json' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.#timeoutMs)]),
    });
    if (!res.ok) throw new Error(`${new URL(url).host} が ${res.status} を返しました`);
    return res.json();
  }

  async fetch(question: string, signal: AbortSignal): Promise<Fetched | undefined> {
    if (!isWeatherQuestion(question)) return undefined;
    const place = placeOf(question) ?? (this.#location().trim() || DEFAULT_LOCATION);
    const f = await this.forecast(place, dayOffsetOf(question), signal);
    if (!f) return undefined;
    const parts = [`${f.name}の${f.day}（日本時間）の天気は${weatherWord(f.code)}`];
    if (typeof f.max === 'number' && typeof f.min === 'number') parts.push(`最高 ${f.max}℃・最低 ${f.min}℃`);
    if (typeof f.pop === 'number') parts.push(`降水確率 ${f.pop}%`);
    return { answer: `${parts.join('、')}（Open-Meteo の予報）。`, sourceUrl: f.sourceUrl, ephemeral: true };
  }

  /**
   * 場所の名前と、今日から何日先かで、その日の予報を取る（日本時間で日を切る）。予報が無ければ undefined、場所が無ければ投げる。
   * 働くかの確かめ（scripts/work-judge.mjs）も、正解をここから取る（場所の引き方を二か所に書かない。書き分けると、
   * 本体は引けるのに確かめだけ引けない、が起きる）。
   */
  async forecast(place: string, offset: number, signal: AbortSignal): Promise<Forecast | undefined> {
    type Geo = { results?: { name?: unknown; latitude?: unknown; longitude?: unknown }[] };
    // Open-Meteo は日本語の名前を「東京都」「大阪市」の形でしか引けない。書かれた形、市・都・府・県を足した形の順に引く
    const tries = /[\p{Script=Han}]$/u.test(place) && !/[市都府県町村区]$/.test(place)
      ? [place, `${place}市`, `${place}都`, `${place}府`, `${place}県`] : [place];
    let hit: NonNullable<Geo['results']>[number] | undefined;
    for (const name of tries) {
      const geo = await this.#get(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=ja&format=json`, signal) as Geo;
      hit = geo.results?.[0];
      if (hit) break;
    }
    if (!hit || typeof hit.latitude !== 'number' || typeof hit.longitude !== 'number') {
      throw new Error(`「${place}」の場所が見つかりませんでした`);
    }
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${hit.latitude}&longitude=${hit.longitude}`
      + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max'
      + `&timezone=Asia%2FTokyo&forecast_days=${offset + 1}`;
    const body = await this.#get(url, signal) as { daily?: Record<string, unknown[] | undefined> };
    const d = body.daily ?? {};
    const day = d.time?.[offset];
    const code = d.weather_code?.[offset];
    const hi = d.temperature_2m_max?.[offset];
    const lo = d.temperature_2m_min?.[offset];
    const pop = d.precipitation_probability_max?.[offset];
    if (typeof day !== 'string' || typeof code !== 'number') return undefined;
    return {
      name: typeof hit.name === 'string' ? hit.name : place, day, code,
      ...(typeof hi === 'number' ? { max: hi } : {}), ...(typeof lo === 'number' ? { min: lo } : {}),
      ...(typeof pop === 'number' ? { pop } : {}), sourceUrl: url,
    };
  }
}

/** ある日の予報（`WeatherSource.forecast`）。 */
export interface Forecast { name: string; day: string; code: number; max?: number; min?: number; pop?: number; sourceUrl: string }

/** Node.js の LTS・最新の版を問うているか。 */
export function isNodeReleaseQuestion(question: string): boolean {
  const q = String(question ?? '').normalize('NFKC');
  return /node(\.?js)?/i.test(q) && /lts|最新|新しい|版|バージョン|version|latest/i.test(q) && !/node:|[a-z_]+\.[a-z_]+\(/i.test(q);
}

/** 利用者の一言そのままで取りに行く問い（今の事実）。 */
export function isLiveQuestion(question: string): boolean {
  return isWeatherQuestion(question) || isNodeReleaseQuestion(question);
}

/** nodejs.org の配布の一覧（`/dist/index.json`）から、今の LTS と最新の版を取る。新しい版が出るので蔵に残さない。 */
export class NodeReleaseSource implements KnowledgeSource {
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  constructor(opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}) {
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#timeoutMs = opts.timeoutMs ?? 8000;
  }

  async fetch(question: string, signal: AbortSignal): Promise<Fetched | undefined> {
    if (!isNodeReleaseQuestion(question)) return undefined;
    const url = 'https://nodejs.org/dist/index.json';
    checkHost(url, new Set(SOURCE_ALLOWED_HOSTS));
    const res = await this.#fetch(url, {
      method: 'GET', credentials: 'omit', redirect: 'error', headers: { accept: 'application/json' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.#timeoutMs)]),
    });
    if (!res.ok) throw new Error(`nodejs.org が ${res.status} を返しました`);
    const list = await res.json() as { version?: unknown; date?: unknown; lts?: unknown }[];
    if (!Array.isArray(list)) return undefined;
    const latest = list.find((r) => typeof r.version === 'string');
    const lts = list.find((r) => typeof r.version === 'string' && typeof r.lts === 'string');
    if (!latest || !lts) return undefined;
    return {
      answer: `Node.js の今の LTS は ${lts.version}（${lts.lts}、${lts.date} 公開）。いちばん新しい版は ${latest.version}（${latest.date}）。`,
      sourceUrl: url, version: String(lts.version), ephemeral: true,
    };
  }
}

/** 天気なら Open-Meteo、Node の組み込みの話なら公式文書、それ以外は npm の登録先。 */
export class DefaultSource implements KnowledgeSource {
  readonly #node: KnowledgeSource;
  readonly #npm: KnowledgeSource;
  readonly #weather: KnowledgeSource;
  readonly #release: KnowledgeSource;
  constructor(opts: { fetchImpl?: typeof fetch; location?: () => string } = {}) {
    const f = opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {};
    this.#node = new NodeDocsSource(f);
    this.#npm = new NpmRegistrySource(f);
    this.#release = new NodeReleaseSource(f);
    this.#weather = new WeatherSource({ ...f, ...(opts.location ? { location: opts.location } : {}) });
  }

  async fetch(question: string, signal: AbortSignal): Promise<Fetched | undefined> {
    // 天気を npm へ回さない（「天気」の語から包みの名前を拾ってしまう）
    if (isWeatherQuestion(question)) return this.#weather.fetch(question, signal);
    if (isNodeReleaseQuestion(question)) return this.#release.fetch(question, signal);
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
  | { status: 'stored'; entry: KnowledgeEntry; ephemeral?: boolean }
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
  const fetchedAt = (opts.now?.() ?? new Date()).toISOString();
  // 今の事実は蔵に残さない（明日には古い）。この頼みでだけ使う
  if (got.ephemeral) {
    return { status: 'stored', ephemeral: true, entry: { question, answer, sourceUrl: got.sourceUrl, fetchedAt, hits: 0, misses: 0 } };
  }
  const entry = await shelf.upsert({
    question, answer, sourceUrl: got.sourceUrl, fetchedAt,
    ...(got.version !== undefined ? { version: got.version } : {}),
  });
  return { status: 'stored', entry };
}
