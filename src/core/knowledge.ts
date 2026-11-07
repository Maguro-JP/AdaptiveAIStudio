/**
 * 知識の蔵（docs/NETWORK-MODEL.md の「中の形」の 2 と 4、段階 2）。
 *
 * 置く所は記録の場所（`stateDir()`）の下の `knowledge/shelf.json` の1つのファイル。
 * 1件は「問い・答えの抜き書き・出どころの URL・取った日・版・効いた回数・外れた回数」。
 * 読み書きは journal-file を通す（壊れていれば脇へ移し、読めなければ空で上書きせず、一時ファイルから付け替える）。
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { stateDir } from './home.ts';
import { redactSecrets } from './redact.ts';
import { loadJournal, saveJournal } from './journal-file.ts';

export interface KnowledgeEntry {
  question: string;
  answer: string;
  sourceUrl: string;
  /** 取った日（ISO の文字列）。 */
  fetchedAt: string;
  version?: string;
  hits: number;
  misses: number;
}

/** 問いを比べる形にする（全角・半角、大文字・小文字、空白の揺れを揃える）。 */
export function normalizeQuestion(q: string): string {
  return q.normalize('NFKC').toLowerCase().replace(/[\s?？。、,.]+/g, ' ').trim();
}

/** 言葉の組。英数字は語ごと、日本語は区切りが無いので 2 文字ずつ。 */
function keywords(q: string): Set<string> {
  const out = new Set<string>();
  for (const w of normalizeQuestion(q).split(/[\s/:()「」]+/)) {
    for (const part of w.split(/([a-z0-9_.@-]+)/)) {
      if (!part) continue;
      if (/^[a-z0-9_.@-]+$/.test(part)) { if (part.length >= 2) out.add(part); continue; }
      for (let i = 0; i + 1 < part.length; i++) out.add(part.slice(i, i + 2));
    }
  }
  return out;
}

/** 言葉の重なりで当たりとみなす割合（問いの言葉のうち、この割合以上が蔵の問いにあれば当たり）。私の推測で決めた値。 */
export const KEYWORD_OVERLAP = 0.6;

export function defaultKnowledgeDir(): string {
  return join(stateDir(), 'knowledge');
}

export class KnowledgeShelf {
  readonly #file: string;
  #entries: KnowledgeEntry[] | undefined;

  constructor(dir = defaultKnowledgeDir()) {
    this.#file = join(dir, 'shelf.json');
  }

  async #load(): Promise<KnowledgeEntry[]> {
    if (this.#entries) return this.#entries;
    this.#entries = [];
    await loadJournal(this, this.#file, (v) => { this.#entries = Array.isArray(v) ? v.filter(isEntry) : []; });
    return this.#entries;
  }

  async #save(): Promise<void> {
    await mkdir(join(this.#file, '..'), { recursive: true });
    await saveJournal(this, this.#file, () => JSON.stringify(this.#entries ?? [], null, 2), (v) => {
      // 読めなかった間に、ファイルにあった分を足す（同じ問いは手元を先に）
      const mine = this.#entries ?? [];
      const keys = new Set(mine.map((x) => normalizeQuestion(x.question)));
      for (const e of Array.isArray(v) ? v.filter(isEntry) : []) if (!keys.has(normalizeQuestion(e.question))) mine.push(e);
      this.#entries = mine;
    });
  }

  async all(): Promise<KnowledgeEntry[]> {
    return [...await this.#load()];
  }

  async isEmpty(): Promise<boolean> {
    return (await this.#load()).length === 0;
  }

  /** 同じ問い（揃えた形で同じ）があれば中身を替え、回数は残す。無ければ足す。秘密は伏せてから置く。 */
  async upsert(e: Omit<KnowledgeEntry, 'hits' | 'misses'> & Partial<Pick<KnowledgeEntry, 'hits' | 'misses'>>): Promise<KnowledgeEntry> {
    const entries = await this.#load();
    const key = normalizeQuestion(e.question);
    const old = entries.find((x) => normalizeQuestion(x.question) === key);
    const next: KnowledgeEntry = {
      question: e.question, answer: redactSecrets(e.answer), sourceUrl: redactSecrets(e.sourceUrl),
      fetchedAt: e.fetchedAt, ...(e.version !== undefined ? { version: e.version } : {}),
      hits: e.hits ?? old?.hits ?? 0, misses: e.misses ?? old?.misses ?? 0,
    };
    if (old) entries[entries.indexOf(old)] = next; else entries.push(next);
    await this.#save();
    return next;
  }

  /** 問いに合う1件。揃えた形が同じものを先に、無ければ言葉の重なりが一番多いもの。 */
  async find(question: string): Promise<KnowledgeEntry | undefined> {
    const entries = await this.#load();
    const key = normalizeQuestion(question);
    const exact = entries.find((x) => normalizeQuestion(x.question) === key);
    if (exact) return exact;
    const want = keywords(question);
    if (want.size === 0) return undefined;
    let best: KnowledgeEntry | undefined;
    let bestScore = 0;
    for (const x of entries) {
      const have = keywords(x.question);
      let n = 0;
      for (const w of want) if (have.has(w)) n++;
      const score = n / want.size;
      if (score >= KEYWORD_OVERLAP && score > bestScore) { best = x; bestScore = score; }
    }
    return best;
  }

  async mark(question: string, result: 'hit' | 'miss'): Promise<boolean> {
    const entries = await this.#load();
    const key = normalizeQuestion(question);
    const e = entries.find((x) => normalizeQuestion(x.question) === key);
    if (!e) return false;
    if (result === 'hit') e.hits++; else e.misses++;
    await this.#save();
    return true;
  }
}

function isEntry(x: unknown): x is KnowledgeEntry {
  const e = x as KnowledgeEntry;
  return typeof e === 'object' && e !== null && typeof e.question === 'string' && typeof e.answer === 'string'
    && typeof e.sourceUrl === 'string' && typeof e.fetchedAt === 'string'
    && typeof e.hits === 'number' && typeof e.misses === 'number';
}

/** 文脈に詰める量の上限（文字数）。8192 トークンの文脈の 1 割ほどを日本語の文字数で見た値。私の推測で決めた値。 */
export const KNOWLEDGE_CHAR_BUDGET = 1500;

/** 蔵から引いた分を、出どころつきで system に足す塊にする。何も無ければ空。上限を超える分は入れない。 */
export function knowledgeBlock(found: readonly KnowledgeEntry[], budget = KNOWLEDGE_CHAR_BUDGET): string {
  if (found.length === 0) return '';
  const head = '## 知識の蔵から（出どころつき。答えに使うときは出どころを添える）\n';
  let out = head;
  for (const e of found) {
    const line = `- ${e.question}: ${e.answer}（出どころ: ${e.sourceUrl}${e.version ? `、版 ${e.version}` : ''}、取った日 ${e.fetchedAt.slice(0, 10)}）\n`;
    if (out.length + line.length > budget) break;
    out += line;
  }
  return out === head ? '' : out.trimEnd();
}
