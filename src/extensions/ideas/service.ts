/**
 * アイデアの拡張機能の本体（IDEAMAN の ideaman/service.py と mcp_server.py に当たる所）。
 *
 * 札を出す（receive）・連鎖の次を出す（follow_chain）・2 枚から出す（combine）・残す（rate）・
 * テーマの語を足す・外す・戻す（register_theme / remove_theme / restore_theme）・見る（list_themes / browse）。
 * 口の名前は、後から MCP で繋げるように IDEAMAN のツールの名前に寄せてある。
 *
 * 札は、推論ではなく語の掛け合わせで作る。モデルもネットワークも要らない。種を渡すと、同じ蔵の中身なら同じ札が出る。
 */
import { combine, render, signatureOf, IGNORED_POOLS, type IdeaSeed, type UsedTerm } from './combinator.ts';
import { defaultLexicon, lexiconCounts, type Lexicon, type Term } from './lexicon.ts';
import { freshSeed, rngFrom } from './rng.ts';
import {
  IdeaStore, MAX_RECENT, MAX_SAVED, MAX_STEPS, MAX_THEMES, MAX_THOUGHT, MAX_THREADS, MAX_WEIGHT, MIN_WEIGHT,
  type IdeasState, type StoredCard, type StoredThread,
} from './store.ts';
import { cleanMaterial, wordsIn } from './themes.ts';

/** 1 度に出す札の数。画面は開いただけで並べるので、読み切れる数にする。 */
export const DEFAULT_COUNT = 4;
export const MIN_COUNT = 3;
export const MAX_COUNT = 5;
/** 星を付けたときに、札の語の重みに掛ける数。外すと割って戻す。 */
export const STAR_FACTOR = 1.25;
/** 「もっと」で、元の札から引き継ぐ語の数。 */
export const CHAIN_INHERIT = 2;
/** 同じ札が出たときに引き直す回数。 */
const REDRAWS = 8;

/** 「なぜ」に出すもの。仕組みの札は、元の文と出典。ほかの札は、掛け合わせた語と、同じ側面の仕組み（在れば）。 */
export interface Why {
  parts: Array<{ label: string; term: string }>;
  mechanism?: { subject: string; how: string; source: string; aspect: string; license: string; licenseUrl: string; direct: boolean };
}

/** 画面へ渡す札。 */
export interface IdeaCard {
  id: string;
  /** 出す文（磨いた文が在ればそれ）。 */
  text: string;
  /** 掛け合わせで出来た元の文。 */
  original: string;
  polished: boolean;
  tone: string;
  toneLabel: string;
  templateId: string;
  material?: string;
  starred: boolean;
  parents: string[];
  seed: number;
  why: Why;
}

export interface ThemeList {
  themes: Array<{ term: string; from: 'auto' | 'added' }>;
  /** 外した語（戻せる）。 */
  removed: string[];
}

/** 画面へ渡す筋。置いた思いつきと、育てた札の流れ。 */
export interface IdeaThread {
  id: string;
  thought: string;
  words: string[];
  steps: IdeaCard[];
  updatedAt: number;
  /** 依頼に入れる形（思いつきと、育てた札を順に並べた文）。 */
  asText: string;
}

/** 思いつきを広げて返す札の数と、育てたときに返す次の札の数。 */
export const PLANT_COUNT = 4;
export const GROW_COUNT = 3;
/** 思いつきから採る語の数。 */
const MAX_THOUGHT_WORDS = 4;

export class IdeasError extends Error {}

const PART_LABELS: Record<string, string> = {
  materials: '材料', concepts: '概念', aspects: '側面', operations: '操作', constraints: '制約',
  provocations: '問いかけ', probes: '試し方', mechanisms: '仕組み',
};

export class IdeaService {
  readonly #store: IdeaStore;
  readonly #lexicon: Lexicon;
  readonly #now: () => number;

  constructor(dir: string, opts: { lexicon?: Lexicon; now?: () => number } = {}) {
    this.#store = new IdeaStore(dir);
    this.#lexicon = opts.lexicon ?? defaultLexicon();
    this.#now = opts.now ?? Date.now;
  }

  /** いま使うテーマの語。自動で採った語と足した語から、外した語を除く。 */
  async listThemes(auto: readonly string[] = []): Promise<ThemeList> {
    const state = await this.#store.state();
    return themeList(state, auto);
  }

  /** 語を足す。語でないもの（文・1 文字・長すぎる）は断る。外してあった語なら、外したのを取り消す。 */
  async registerTheme(raw: string): Promise<string> {
    const term = cleanMaterial(raw);
    if (!term) throw new IdeasError('語を 1 つ入れてください（2 文字以上。句読点や空白を含む文は使えません）');
    const state = await this.#store.state();
    state.themes.removed = state.themes.removed.filter((t) => t !== term);
    if (!state.themes.added.includes(term)) {
      if (state.themes.added.length >= MAX_THEMES) throw new IdeasError(`足せる語は ${MAX_THEMES} 個までです。使わない語を外してください`);
      state.themes.added.push(term);
    }
    await this.#store.save();
    return term;
  }

  /** 語を外す。足した語は足した一覧に残したまま、外した一覧に入れる（戻せるように）。 */
  async removeTheme(raw: string): Promise<string> {
    const term = raw.normalize('NFKC').trim();
    if (!term) throw new IdeasError('外す語が空です');
    const state = await this.#store.state();
    if (!state.themes.removed.includes(term)) state.themes.removed = [...state.themes.removed, term].slice(-MAX_THEMES);
    await this.#store.save();
    return term;
  }

  /** 外した語を戻す。 */
  async restoreTheme(raw: string): Promise<string> {
    const term = raw.normalize('NFKC').trim();
    const state = await this.#store.state();
    state.themes.removed = state.themes.removed.filter((t) => t !== term);
    await this.#store.save();
    return term;
  }

  /**
   * 札を出す。`seed` を渡すと、同じ蔵の中身（重み・テーマの語）なら同じ札が出る。
   * `focus` を渡すと、材料を使う札の半分（切り上げ）は、その語を材料にする（足した語が、すぐ札に入るように）。
   * 材料が在るときは、仕組みの札（外の世界の仕組みの 1 文を移す型）を 1 枚は入れる。
   */
  async receive(opts: { count?: number; seed?: number; auto?: readonly string[]; focus?: string } = {}): Promise<IdeaCard[]> {
    const state = await this.#store.state();
    const count = Math.min(MAX_COUNT, Math.max(MIN_COUNT, Math.floor(opts.count ?? DEFAULT_COUNT)));
    const materials = themeList(state, opts.auto ?? []).themes.map((t) => t.term);
    const focus = opts.focus && materials.includes(opts.focus) ? opts.focus : undefined;
    const base = opts.seed ?? freshSeed(this.#now());
    // 種を渡されたときは、前に出した札を見ない（同じ種で同じ札を出すため）。渡されなければ、前に出した札と同じものは引き直す
    const seen = new Set(opts.seed === undefined ? [...state.recent, ...state.saved].map((c) => signatureOf(c)) : []);
    const weights = flatWeights(state);
    const seeds: IdeaSeed[] = [];
    const templates = new Set<string>();
    for (let i = 0; i < count; i += 1) {
      const fixed = focus && i < Math.ceil(count / 2) ? { material: focus } : undefined;
      let picked: IdeaSeed | undefined;
      for (let attempt = 0; attempt <= REDRAWS; attempt += 1) {
        const seed = combine({
          lexicon: this.#lexicon, weights, materials, seed: mix(base, i, attempt), ...(fixed ? { fixed } : {}),
        });
        picked = seed;
        // 同じ組み合わせ・同じ型が並ぶと、違う話をしていても同じ札に見える
        if (!seen.has(signatureOf(seed)) && !templates.has(seed.templateId)) break;
      }
      seeds.push(picked!);
      seen.add(signatureOf(picked!));
      templates.add(picked!.templateId);
    }
    if (materials.length > 0 && !seeds.some((s) => s.templateId === 'mechanism_transfer')) {
      const at = seeds.length - 1;
      const forced = combine({
        lexicon: this.#lexicon, weights, materials, seed: mix(base, at, 0), templateId: 'mechanism_transfer',
        ...(focus && at < Math.ceil(count / 2) ? { fixed: { material: focus } } : {}),
      });
      if (forced.templateId === 'mechanism_transfer') seeds[at] = forced;
    }
    const cards = seeds.map((seed) => this.#keep(state, seed, []));
    await this.#store.save();
    return cards.map((c) => this.#toCard(c));
  }

  /** 連鎖の次を出す。元の札の主題（材料・概念・側面）から語を引き継ぎ、別の型・別の語で 1 枚作る。 */
  async followChain(id: string, opts: { seed?: number; auto?: readonly string[] } = {}): Promise<IdeaCard> {
    const state = await this.#store.state();
    const parent = find(state, id);
    if (!parent) throw new IdeasError('その札は、もう覚えていません（別の札でお試しください）');
    const themes = themeList(state, opts.auto ?? []);
    const gone = new Set(themes.removed);
    // 外した語は引き継がない。元の札の材料が今の語に無くても、外していなければ使う
    const inherit = parent.terms.filter(([pool, term]) => !(pool === 'materials' && gone.has(term)));
    const own = parent.slots.material && !gone.has(parent.slots.material) ? [parent.slots.material] : [];
    const materials = [...new Set([...own, ...themes.themes.map((t) => t.term)])];
    const base = opts.seed ?? freshSeed(this.#now());
    const seen = new Set([signatureOf(parent), ...state.recent.filter((c) => c.parents.includes(id)).map((c) => signatureOf(c))]);
    let picked: IdeaSeed | undefined;
    for (let attempt = 0; attempt <= REDRAWS; attempt += 1) {
      picked = combine({
        lexicon: this.#lexicon, weights: flatWeights(state), materials, seed: mix(base, 0, attempt),
        inherit, inheritCount: CHAIN_INHERIT,
      });
      if (!seen.has(signatureOf(picked)) && picked.templateId !== parent.templateId) break;
    }
    const card = this.#keep(state, picked!, [parent.id]);
    await this.#store.save();
    return this.#toCard(card);
  }

  /**
   * 2 枚の札から、新しい札を 1 枚出す。1 枚目の主題（材料か概念）に、2 枚目の主題（材料・仕組みの主・概念）をぶつける。
   * 2 枚の主題が同じなら、1 枚目の主題に 2 枚目の側面を当てる。
   */
  async combineTwo(idA: string, idB: string, opts: { seed?: number } = {}): Promise<IdeaCard> {
    if (idA === idB) throw new IdeasError('違う札を 2 枚選んでください');
    const state = await this.#store.state();
    const a = find(state, idA);
    const b = find(state, idB);
    if (!a || !b) throw new IdeasError('選んだ札を、もう覚えていません（別の札でお試しください）');
    const base = opts.seed ?? freshSeed(this.#now());
    const rng = rngFrom(mix(base, 7, 0));
    const subject = a.slots.material ?? a.slots.concept_a ?? b.slots.material ?? b.slots.concept_a ?? '';
    const partner = [b.slots.material, b.slots.mechanism, b.slots.concept_a, b.slots.concept_b, a.slots.mechanism, a.slots.concept_a]
      .find((t): t is string => Boolean(t) && t !== subject);
    const nouns = new Set((this.#lexicon.pools.aspects ?? []).filter((t) => t.kind === 'noun').map((t) => t.term));
    const aspectOf = (c: StoredCard): string | undefined => [c.slots.aspect, c.slots.mechanism_aspect].find((t): t is string => Boolean(t) && nouns.has(t!));
    const aspects = [aspectOf(b), aspectOf(a)].filter((t): t is string => Boolean(t));
    const templateIds = partner ? ['borrow_from', 'two_materials', 'question_absence'] : ['swap_aspect', 'exaggerate', 'question_aspect', 'constrained_rebuild'];
    const seen = new Set([a, b, ...state.recent.filter((c) => c.parents.includes(idA) && c.parents.includes(idB))].map((c) => signatureOf(c)));
    let picked: IdeaSeed | undefined;
    for (let attempt = 0; attempt <= REDRAWS; attempt += 1) {
      const fixed: Record<string, string> = { material: subject };
      if (partner) fixed.concept_a = partner;
      // 側面は、2 枚目のものを先に当て、同じ札になるなら 1 枚目のもの、それでも同じなら引く
      const aspect = aspects[attempt];
      if (aspect) fixed.aspect = aspect;
      picked = combine({
        lexicon: this.#lexicon, weights: flatWeights(state), materials: [subject], seed: mix(base, 0, attempt),
        templateId: rng.choice(templateIds), fixed,
        // 操作と制約は、元の 2 枚のものを使えるなら使う
        inherit: [...a.terms, ...b.terms].filter(([pool]) => pool === 'operations' || pool === 'constraints'), inheritCount: 1,
      });
      if (!seen.has(signatureOf(picked))) break;
    }
    const card = this.#keep(state, picked!, [a.id, b.id]);
    await this.#store.save();
    return this.#toCard(card);
  }

  /**
   * 札を残す（value 1）・残すのをやめる（value 0）。残すと、札の語（試し方を除く）の重みが上がり、次からその語が出やすくなる。
   * やめると、上げた分を戻す。
   */
  async rate(id: string, value: number): Promise<{ card: IdeaCard; weights: Array<{ pool: string; term: string; weight: number }> }> {
    const state = await this.#store.state();
    const card = find(state, id);
    if (!card) throw new IdeasError('その札は、もう覚えていません');
    const star = value > 0;
    if (star !== Boolean(card.starred)) {
      if (star && state.saved.length >= MAX_SAVED) throw new IdeasError(`残せる札は ${MAX_SAVED} 枚までです。一覧から外してから残してください`);
      for (const [pool, term] of card.terms) {
        if (IGNORED_POOLS.has(pool)) continue;
        const at = (state.weights[pool] ??= {});
        const next = (at[term] ?? 1) * (star ? STAR_FACTOR : 1 / STAR_FACTOR);
        at[term] = Math.min(Math.max(Math.round(next * 10000) / 10000, MIN_WEIGHT), MAX_WEIGHT);
      }
      if (star) {
        card.starred = true;
        state.saved.push(card);
      } else {
        delete card.starred;
        state.saved = state.saved.filter((c) => c.id !== id);
        // 出した札の一覧に無ければ戻す（残したあとで古くなって落ちた札を、やめた直後に戻せるように）
        if (!state.recent.some((c) => c.id === id)) state.recent = [...state.recent, card].slice(-MAX_RECENT);
      }
      await this.#store.save();
    }
    const weights = card.terms.filter(([pool]) => !IGNORED_POOLS.has(pool))
      .map(([pool, term]) => ({ pool, term, weight: state.weights[pool]?.[term] ?? 1 }));
    return { card: this.#toCard(card), weights };
  }

  /**
   * 思いつきを 1 行で置く。その思いつきから語を採り、掛け合わせで広げた札を返す。思いつきは、筋の頭として残る。
   * 語を 1 つも採れない思いつき（ひらがなだけ等）は、今のテーマの語で広げる（札は、その語の話になる）。
   */
  async plant(text: string, opts: { seed?: number; auto?: readonly string[] } = {}): Promise<{ thread: IdeaThread; cards: IdeaCard[] }> {
    const thought = text.normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, MAX_THOUGHT);
    if (!thought) throw new IdeasError('思いつきを 1 行で書いてください');
    const state = await this.#store.state();
    // 思いつきが 1 語（助詞を含まない短い語。「棚卸し」）なら、それをそのまま材料にする。文なら、文の中の語を採る
    const whole = /[がをにはでともへ]/.test(thought) ? undefined : cleanMaterial(thought);
    const words = whole ? [whole] : [...new Set(wordsIn(thought))].slice(0, MAX_THOUGHT_WORDS);
    const now = this.#now();
    const thread: StoredThread = { id: `t${state.nextId}`, thought, words, steps: [], createdAt: now, updatedAt: now };
    state.nextId += 1;
    state.threads = [...state.threads, thread].slice(-MAX_THREADS);
    const cards = this.#spread(state, thread, undefined, PLANT_COUNT, opts);
    await this.#store.save();
    return { thread: this.#toThread(thread), cards: cards.map((c) => this.#toCard(c)) };
  }

  /**
   * 札を育てる。その札を筋に足し（考えの流れが 1 本の筋として残る）、その札を種にした次の札を返す。
   * 札を渡さなければ、筋の最後の札（無ければ、置いた思いつき）を種にして、次の札だけを返す（筋を開き直したとき）。
   */
  async grow(threadId: string, cardId: string | undefined, opts: { seed?: number; auto?: readonly string[] } = {}): Promise<{ thread: IdeaThread; cards: IdeaCard[] }> {
    const state = await this.#store.state();
    const thread = state.threads.find((t) => t.id === threadId);
    if (!thread) throw new IdeasError('その筋は、もう覚えていません（思いつきを置き直してください）');
    if (cardId) {
      const card = find(state, cardId);
      if (!card) throw new IdeasError('その札は、もう覚えていません（別の札でお試しください）');
      if (thread.steps.at(-1)?.id !== card.id) {
        if (thread.steps.length >= MAX_STEPS) throw new IdeasError(`1 本の筋に残せる札は ${MAX_STEPS} 枚までです。新しい思いつきとして置き直してください`);
        thread.steps.push({ ...card });
      }
      thread.updatedAt = this.#now();
    }
    const cards = this.#spread(state, thread, thread.steps.at(-1), GROW_COUNT, opts);
    await this.#store.save();
    return { thread: this.#toThread(thread), cards: cards.map((c) => this.#toCard(c)) };
  }

  /** 筋の一覧。新しく触ったものが先。 */
  async threads(): Promise<IdeaThread[]> {
    const state = await this.#store.state();
    return [...state.threads].sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt).map((t) => this.#toThread(t));
  }

  /**
   * 筋の次の札を作る。材料は、思いつきから採った語（無ければ今のテーマの語）。種の札が在れば、その主題を引き継ぐ。
   * 同じ型・筋にもう在る組み合わせは並べない。
   */
  #spread(state: IdeasState, thread: StoredThread, from: StoredCard | undefined, count: number, opts: { seed?: number; auto?: readonly string[] }): StoredCard[] {
    const themes = themeList(state, opts.auto ?? []);
    const own = thread.words.length > 0 ? thread.words : themes.themes.map((t) => t.term);
    const materials = [...new Set([...(from?.slots.material ? [from.slots.material] : []), ...own])];
    const base = opts.seed ?? freshSeed(this.#now());
    const weights = flatWeights(state);
    const seen = new Set(thread.steps.map((c) => signatureOf(c)));
    const templates = new Set(from ? [from.templateId] : []);
    const out: StoredCard[] = [];
    for (let i = 0; i < count; i += 1) {
      let picked: IdeaSeed | undefined;
      for (let attempt = 0; attempt <= REDRAWS; attempt += 1) {
        picked = combine({
          lexicon: this.#lexicon, weights, materials, seed: mix(base, i, attempt),
          ...(from ? { inherit: from.terms, inheritCount: CHAIN_INHERIT } : {}),
        });
        if (!seen.has(signatureOf(picked)) && !templates.has(picked.templateId)) break;
      }
      seen.add(signatureOf(picked!));
      templates.add(picked!.templateId);
      out.push(this.#keep(state, picked!, from ? [from.id] : []));
    }
    return out;
  }

  #toThread(thread: StoredThread): IdeaThread {
    const steps = thread.steps.map((c) => this.#toCard(c));
    return {
      id: thread.id, thought: thread.thought, words: [...thread.words], steps, updatedAt: thread.updatedAt,
      asText: [`思いつき: ${thread.thought}`, ...steps.map((c, i) => `${i + 1}. ${c.text}`)].join('\n'),
    };
  }

  /** 残した札。新しいものが先。 */
  async browse(): Promise<IdeaCard[]> {
    const state = await this.#store.state();
    return [...state.saved].reverse().map((c) => this.#toCard(c));
  }

  /** 札を id で取る（磨くときに、元の文を読む）。 */
  async cards(ids: readonly string[]): Promise<IdeaCard[]> {
    const state = await this.#store.state();
    return ids.map((id) => find(state, id)).filter((c): c is StoredCard => c !== undefined).map((c) => this.#toCard(c));
  }

  /** 磨いた文を札に付ける（元の文は残す）。空を渡すと、磨いた文を外す。 */
  async setPolished(texts: Readonly<Record<string, string>>): Promise<void> {
    const state = await this.#store.state();
    for (const [id, text] of Object.entries(texts)) {
      const card = find(state, id);
      if (!card) continue;
      if (text) card.polished = text;
      else delete card.polished;
    }
    await this.#store.save();
  }

  async polishEnabled(): Promise<boolean> { return (await this.#store.state()).polish; }
  async setPolishEnabled(on: boolean): Promise<boolean> {
    const state = await this.#store.state();
    state.polish = on;
    await this.#store.save();
    return on;
  }

  /** 数（doctor と設定の画面に出す。IDEAMAN の stock_status に当たる）。 */
  async status(): Promise<{ terms: number; templates: number; mechanisms: number; mechanismsTotal: number; saved: number; recent: number; threads: number; grown: number; added: number; removed: number; path: string; unreadable: boolean }> {
    const state = await this.#store.state();
    const grown = Object.values(state.weights).reduce((n, terms) => n + Object.values(terms).filter((w) => w !== 1).length, 0);
    return {
      ...lexiconCounts(this.#lexicon), saved: state.saved.length, recent: state.recent.length, threads: state.threads.length, grown,
      added: state.themes.added.length, removed: state.themes.removed.length, path: this.#store.path, unreadable: this.#store.unreadable,
    };
  }

  /** 種を札にして、出した札の一覧に入れる（古いものから落とす）。 */
  #keep(state: IdeasState, seed: IdeaSeed, parents: string[]): StoredCard {
    const card: StoredCard = {
      id: `c${state.nextId}`, text: render(seed, this.#lexicon), tone: seed.tone, templateId: seed.templateId,
      slots: seed.slots, terms: seed.terms, seed: seed.seed, novelty: seed.novelty, parents, createdAt: this.#now(),
    };
    state.nextId += 1;
    state.recent = [...state.recent, card].slice(-MAX_RECENT);
    return card;
  }

  #toCard(card: StoredCard): IdeaCard {
    return {
      id: card.id, text: card.polished ?? card.text, original: card.text, polished: Boolean(card.polished),
      tone: card.tone, toneLabel: card.tone === 'question' ? '問い' : '提案', templateId: card.templateId,
      ...(card.slots.material ? { material: card.slots.material } : {}),
      starred: Boolean(card.starred), parents: card.parents, seed: card.seed, why: this.#why(card),
    };
  }

  #why(card: StoredCard): Why {
    const parts = card.terms.map(([pool, term]) => ({ label: PART_LABELS[pool] ?? pool, term }));
    const license = this.#lexicon.mechanismsLicense;
    const shape = (m: Term, direct: boolean): Why['mechanism'] => ({
      subject: m.term, how: m.how ?? '', source: m.source ?? '', aspect: m.aspect ?? '', license: license.name, licenseUrl: license.url, direct,
    });
    const pool = this.#lexicon.pools.mechanisms ?? [];
    if (card.slots.mechanism) {
      const used = pool.find((m) => m.term === card.slots.mechanism && m.how === card.slots.mechanism_how);
      if (used) return { parts, mechanism: shape(used, true) };
      // 同梱の仕組みが入れ替わっても、札が運んできた文と出典は出す
      return {
        parts,
        mechanism: {
          subject: card.slots.mechanism, how: card.slots.mechanism_how ?? '', source: card.slots.mechanism_source ?? '',
          aspect: card.slots.mechanism_aspect ?? '', license: license.name, licenseUrl: license.url, direct: true,
        },
      };
    }
    // 仕組みを使わない札には、同じ側面の話をしている外の世界の仕組みを 1 つ添える（在れば。札の種で決まる）
    const near = pool.filter((m) => m.aspect === card.slots.aspect);
    if (near.length === 0) return { parts };
    return { parts, mechanism: shape(near[Math.abs(card.seed) % near.length]!, false) };
  }
}

function find(state: IdeasState, id: string): StoredCard | undefined {
  return state.saved.find((c) => c.id === id) ?? state.recent.find((c) => c.id === id)
    ?? state.threads.flatMap((t) => t.steps).find((c) => c.id === id);
}

function themeList(state: IdeasState, auto: readonly string[]): ThemeList {
  const gone = new Set(state.themes.removed);
  const themes: ThemeList['themes'] = [];
  const push = (term: string, from: 'auto' | 'added'): void => {
    if (!gone.has(term) && !themes.some((t) => t.term === term)) themes.push({ term, from });
  };
  // 足した語が先（利用者が選んだものを、自動で採った語より前に並べる）
  for (const term of state.themes.added) push(term, 'added');
  for (const term of auto) push(term, 'auto');
  return { themes, removed: [...state.themes.removed] };
}

/** 抽選に渡す重み（語 → 重み）。同じ語が 2 つのプールに在れば、大きいほうを使う。 */
function flatWeights(state: IdeasState): Record<string, number> {
  const out: Record<string, number> = {};
  for (const terms of Object.values(state.weights)) {
    for (const [term, w] of Object.entries(terms)) out[term] = Math.max(out[term] ?? 0, w);
  }
  return out;
}

/** 元の種と、何枚目か・何度目の引き直しかから、札 1 枚の種を作る。 */
function mix(base: number, index: number, attempt: number): number {
  return (Math.imul(base >>> 0, 2654435761) + index * 40503 + attempt * 9973) >>> 0;
}
