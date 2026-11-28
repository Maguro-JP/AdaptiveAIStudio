/**
 * アイデアの拡張機能の蔵。AAS_HOME のデータの下の JSON 1 本（`extensions/ideas/store.json`）。
 *
 * 持つのは、語の重み（評価で育つ）・利用者が足した語と外した語・出した札（連鎖を辿るため）・残した札。
 * 件数に上限を付ける（出した札は古いものから落とす。残した札は、上限まで来たら足すのを断る）。
 * 書くときは一時ファイルから付け替える。在るのに読めないときは、空で始めるが上書きしない。
 */
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { readJournal, writeWhole } from '../../core/journal-file.ts';
import type { UsedTerm } from './combinator.ts';

/** 出した札を覚えておく数。「もっと」「組み合わせる」は、ここに在る札から辿る。 */
export const MAX_RECENT = 200;
/** 残した札の数の上限。 */
export const MAX_SAVED = 500;
/** 利用者が足した語・外した語の数の上限。 */
export const MAX_THEMES = 100;
/** 筋（置いた思いつきと、育てた札の流れ）を覚えておく数。古いものから落とす。 */
export const MAX_THREADS = 100;
/** 1 本の筋に残す札の数。 */
export const MAX_STEPS = 50;
/** 置ける思いつきの長さ（文字）。 */
export const MAX_THOUGHT = 200;
/** 重みの下限と上限。無いと、育った語ばかりになるか、二度と出なくなる。 */
export const MIN_WEIGHT = 0.2;
export const MAX_WEIGHT = 5;

export interface StoredCard {
  id: string;
  text: string;
  tone: string;
  templateId: string;
  slots: Record<string, string>;
  terms: UsedTerm[];
  seed: number;
  novelty: number;
  /** 元の札（「もっと」は 1 枚、「組み合わせる」は 2 枚）。 */
  parents: string[];
  createdAt: number;
  starred?: boolean;
  /** 手元のモデルが磨いた文。元の文は `text` に残す。 */
  polished?: string;
}

/** 筋。利用者が置いた思いつき 1 行と、そこから選んで育てた札の流れ。 */
export interface StoredThread {
  id: string;
  thought: string;
  /** 思いつきから採った語（札の材料）。 */
  words: string[];
  /** 育てた札。選んだ順。出した札の一覧から落ちても残るよう、札そのものを持つ。 */
  steps: StoredCard[];
  createdAt: number;
  updatedAt: number;
}

export interface IdeasState {
  version: 1;
  nextId: number;
  /** プールの名前 → 語 → 重み。無い語は 1。 */
  weights: Record<string, Record<string, number>>;
  themes: { added: string[]; removed: string[] };
  recent: StoredCard[];
  saved: StoredCard[];
  threads: StoredThread[];
  /** 手元のモデルで磨くか。 */
  polish: boolean;
}

export function emptyState(): IdeasState {
  return { version: 1, nextId: 1, weights: {}, themes: { added: [], removed: [] }, recent: [], saved: [], threads: [], polish: true };
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

function cardFrom(v: unknown): StoredCard | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.text !== 'string' || typeof o.templateId !== 'string') return undefined;
  const slots: Record<string, string> = {};
  for (const [k, x] of Object.entries((o.slots && typeof o.slots === 'object' ? o.slots : {}) as Record<string, unknown>)) {
    if (typeof x === 'string') slots[k] = x;
  }
  const terms = (Array.isArray(o.terms) ? o.terms : [])
    .filter((t): t is [string, string] => Array.isArray(t) && typeof t[0] === 'string' && typeof t[1] === 'string')
    .map((t): UsedTerm => [t[0], t[1]]);
  return {
    id: o.id, text: o.text, templateId: o.templateId, slots, terms,
    tone: typeof o.tone === 'string' ? o.tone : 'proposal',
    seed: typeof o.seed === 'number' ? o.seed : 0,
    novelty: typeof o.novelty === 'number' ? o.novelty : 0.5,
    parents: strings(o.parents),
    createdAt: typeof o.createdAt === 'number' ? o.createdAt : 0,
    ...(o.starred === true ? { starred: true } : {}),
    ...(typeof o.polished === 'string' && o.polished ? { polished: o.polished } : {}),
  };
}

/** 読んだ JSON を、決めた形に直す。知らない項目は落とし、数は上限に収める。 */
export function stateFrom(raw: unknown): IdeasState {
  const state = emptyState();
  if (!raw || typeof raw !== 'object') return state;
  const o = raw as Record<string, unknown>;
  for (const [pool, terms] of Object.entries((o.weights && typeof o.weights === 'object' ? o.weights : {}) as Record<string, unknown>)) {
    if (!terms || typeof terms !== 'object') continue;
    const kept: Record<string, number> = {};
    for (const [term, w] of Object.entries(terms as Record<string, unknown>)) {
      if (typeof w === 'number' && Number.isFinite(w)) kept[term] = Math.min(Math.max(w, MIN_WEIGHT), MAX_WEIGHT);
    }
    state.weights[pool] = kept;
  }
  const themes = (o.themes && typeof o.themes === 'object' ? o.themes : {}) as Record<string, unknown>;
  state.themes = { added: strings(themes.added).slice(-MAX_THEMES), removed: strings(themes.removed).slice(-MAX_THEMES) };
  const cards = (v: unknown): StoredCard[] => (Array.isArray(v) ? v.map(cardFrom).filter((c): c is StoredCard => c !== undefined) : []);
  state.recent = cards(o.recent).slice(-MAX_RECENT);
  state.saved = cards(o.saved).slice(-MAX_SAVED).map((c) => ({ ...c, starred: true }));
  state.threads = (Array.isArray(o.threads) ? o.threads : []).flatMap((v): StoredThread[] => {
    if (!v || typeof v !== 'object') return [];
    const t = v as Record<string, unknown>;
    if (typeof t.id !== 'string' || typeof t.thought !== 'string' || !t.thought) return [];
    return [{
      id: t.id, thought: t.thought.slice(0, MAX_THOUGHT), words: strings(t.words), steps: cards(t.steps).slice(-MAX_STEPS),
      createdAt: typeof t.createdAt === 'number' ? t.createdAt : 0, updatedAt: typeof t.updatedAt === 'number' ? t.updatedAt : 0,
    }];
  }).slice(-MAX_THREADS);
  state.polish = o.polish !== false;
  const biggest = [...state.recent, ...state.saved, ...state.threads.flatMap((t) => t.steps)].reduce((n, c) => Math.max(n, Number(/^c(\d+)$/.exec(c.id)?.[1] ?? 0)), 0);
  state.nextId = Math.max(typeof o.nextId === 'number' && o.nextId > 0 ? Math.floor(o.nextId) : 1, biggest + 1);
  return state;
}

export class IdeaStore {
  readonly path: string;
  #state: IdeasState | undefined;
  /** 在るのに読めなかった。上書きすると前の中身を消すので、書かない。 */
  #unreadable = false;

  constructor(dir: string) { this.path = join(dir, 'store.json'); }

  /** 蔵を読む（1 度だけ）。無ければ空で始める。 */
  async state(): Promise<IdeasState> {
    if (this.#state) return this.#state;
    const read = await readJournal(this.path);
    this.#unreadable = read.kind === 'unreadable';
    this.#state = read.kind === 'value' ? stateFrom(read.value) : emptyState();
    return this.#state;
  }

  /** いまの中身を書く。書けたら true。読めなかった蔵は上書きしない（false）。 */
  async save(): Promise<boolean> {
    if (!this.#state || this.#unreadable) return false;
    await mkdir(dirname(this.path), { recursive: true });
    return writeWhole(this.path, `${JSON.stringify(this.#state, null, 1)}\n`);
  }

  get unreadable(): boolean { return this.#unreadable; }
}
