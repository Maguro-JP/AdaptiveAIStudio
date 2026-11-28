/**
 * 語の衝突を作る抽選（IDEAMAN の ideaman/engine/combinator.py を移したもの）。
 *
 * 推論で答えるのではなく、文の型に 材料・側面・操作・試し方 を当てはめて 1 件作る。概念を 2 つ引くときは、
 * 候補を何度か引いて、分野の重なりが少ない（遠い）組を選ぶ。`mechanism_transfer` の型は、外の世界の仕組みの
 * 1 文を、材料の側面に移す。同じ種と同じ語と同じ重みなら、同じ種（`IdeaSeed`）が出る。
 */
import type { Lexicon, Template, Term } from './lexicon.ts';
import { defaultLexicon } from './lexicon.ts';
import { rngFrom, type Rng } from './rng.ts';

/** 1 回の抽選で試す候補の数。多いほど遠い組が選ばれやすいが、大きすぎると毎回同じ最遠の組に寄る。 */
export const CANDIDATE_TRIES = 6;

/** スロットの名前から、そこに入れてよい語の形。混ぜると「頻度を主役と脇役を入れ替える」のように「を」が二重になる。 */
const SLOT_KINDS: Record<string, string> = { aspect: 'noun', aspect_q: 'clause', operation_v: 'verb' };

/** 連鎖が持ち越す「主題」のプール。問いかけや試し方を引き継ぐと、話題は変わるのに同じ問いが繰り返される。 */
export const SUBJECT_POOLS: ReadonlySet<string> = new Set(['materials', 'concepts', 'aspects']);

/** 分野で絞った結果、これ未満しか残らないなら、足りない分を分野の外の語で埋める。 */
const MIN_NARROWED = 4;

/** 型の needs の名前から、引くプールの名前。 */
export const SLOT_TO_POOL: Record<string, string> = {
  concept_a: 'concepts', concept_b: 'concepts',
  operation: 'operations', operation_v: 'operations',
  constraint: 'constraints', provocation: 'provocations',
  aspect: 'aspects', aspect_q: 'aspects', probe: 'probes',
  // 材料はプールから引かない。呼ぶ側が渡すテーマの語を使う
  material: 'materials',
  // 外の世界の仕組み。語ではなく 1 文を運ぶ（`mechanism_how`）
  mechanism: 'mechanisms',
};

/** 署名にも評価にも数えないプール。試し方は言い方であって、思いつきの中身ではない。 */
export const IGNORED_POOLS: ReadonlySet<string> = new Set(['probes']);

/** 抽選に使った語。`[プールの名前, 語]`。 */
export type UsedTerm = readonly [string, string];

/** 文にする前の、札の種。 */
export interface IdeaSeed {
  templateId: string;
  tone: string;
  slots: Record<string, string>;
  seed: number;
  terms: UsedTerm[];
  /** 引いた概念どうしの遠さ（0〜1）。1 つしか引かない型は測れないので 0.5。 */
  novelty: number;
}

export interface CombineOptions {
  lexicon?: Lexicon;
  /** 語から重み。評価で育った値。無い語は 1。0 の語は引かれない。 */
  weights?: Readonly<Record<string, number>>;
  domain?: string;
  tone?: string;
  seed: number;
  /** 前の札が使った語。連鎖で持ち越す候補。 */
  inherit?: readonly UsedTerm[];
  /** そのうち何語を引き継ぐか。0 なら引き継がない。 */
  inheritCount?: number;
  /** テーマの語（材料）。空なら、材料を使わない型だけになる。 */
  materials?: readonly string[];
  /** 型を名指しする（「仕組みの札を 1 枚は入れる」「組み合わせる」で使う）。埋められない型なら、名指しを外す。 */
  templateId?: string;
  /** スロットに入れる語を名指しする（材料・概念・側面など）。形が合わない・プールに無いものは使わない。材料と概念はそのまま使う。 */
  fixed?: Readonly<Record<string, string>>;
}

/** 同じ組み合わせに戻ってきたかを見る署名。型と、思いつきを担う語の集まりで決まる（語の順と種は入れない）。 */
export function signatureOf(seed: Pick<IdeaSeed, 'templateId' | 'terms'>): string {
  const terms = seed.terms.filter(([pool]) => !IGNORED_POOLS.has(pool)).map(([pool, term]) => `${pool}:${term}`).sort();
  return `${seed.templateId}|${terms.join('|')}`;
}

function weighted(rng: Rng, terms: readonly Term[], weights: Readonly<Record<string, number>>): Term {
  return rng.weighted(terms, terms.map((t) => Math.max(weights[t.term] ?? 1, 0)));
}

/** 2 語の遠さ。分野の重なりが少ないほど大きい（Jaccard 距離）。どちらも分野なしなら 0.5。 */
export function distance(a: Pick<Term, 'domains'>, b: Pick<Term, 'domains'>): number {
  const da = new Set(a.domains);
  const db = new Set(b.domains);
  const union = new Set([...da, ...db]);
  if (union.size === 0) return 0.5;
  let both = 0;
  for (const d of da) if (db.has(d)) both += 1;
  return 1 - both / union.size;
}

function pickFarPair(rng: Rng, terms: readonly Term[], weights: Readonly<Record<string, number>>): [Term, Term] {
  if (terms.length < 2) throw new Error('組を作るには 2 語以上が要ります');
  let best: [Term, Term] | undefined;
  let bestScore = -1;
  for (let i = 0; i < CANDIDATE_TRIES; i += 1) {
    const a = weighted(rng, terms, weights);
    const b = weighted(rng, terms, weights);
    if (a.term === b.term) continue;
    const score = distance(a, b);
    if (score > bestScore) { best = [a, b]; bestScore = score; }
  }
  if (!best) {
    const [a, b] = rng.sample(terms, 2);
    best = [a!, b!];
  }
  return best;
}

/** 分野の指定が在れば、その分野の語に寄せる。絞り切らず、少なければ分野の外の語で埋める（同じ語の繰り返しを避ける）。 */
function byDomain(terms: readonly Term[], domain: string | undefined): readonly Term[] {
  if (!domain) return terms;
  const narrowed = terms.filter((t) => t.domains.includes(domain));
  if (narrowed.length === 0) return terms;
  if (narrowed.length >= MIN_NARROWED) return narrowed;
  return [...narrowed, ...terms.filter((t) => !t.domains.includes(domain)).slice(0, MIN_NARROWED - narrowed.length)];
}

/** そのスロットに入れてよい語だけに絞ったプール。絞って空になったら絞らない（文が作れないより、語が偏るほうがまし）。 */
function poolFor(lexicon: Lexicon, slot: string, poolName: string, domain: string | undefined): readonly Term[] {
  const kind = SLOT_KINDS[slot];
  let pool = lexicon.pools[poolName] ?? [];
  if (kind) {
    const fit = pool.filter((t) => t.kind === kind);
    if (fit.length > 0) pool = fit;
  }
  return byDomain(pool, domain);
}

/** すでに使った語を候補から外す。外して空になったら外さない。 */
function without(terms: readonly Term[], avoid: ReadonlySet<string>): readonly Term[] {
  if (avoid.size === 0) return terms;
  const kept = terms.filter((t) => !avoid.has(t.term));
  return kept.length > 0 ? kept : terms;
}

/** 引き継ぐ語を、プールごとに分けて返す。今回の型が使うプールの語だけを候補にし、主題の語を先に引き継ぐ。 */
function pickInherited(rng: Rng, inherit: readonly UsedTerm[], count: number, usablePools: ReadonlySet<string>): Map<string, string[]> {
  const carried = new Map<string, string[]>();
  if (count <= 0 || inherit.length === 0) return carried;
  let usable = inherit.filter(([pool]) => usablePools.has(pool));
  if (usable.length === 0) return carried;
  const subject = usable.filter(([pool]) => SUBJECT_POOLS.has(pool));
  if (subject.length >= count) usable = subject;
  else if (subject.length > 0) {
    const rest = usable.filter(([pool]) => !SUBJECT_POOLS.has(pool));
    usable = [...subject, ...rng.sample(rest, Math.min(count - subject.length, rest.length))];
  }
  for (const [pool, term] of rng.sample(usable, Math.min(count, usable.length))) {
    carried.set(pool, [...(carried.get(pool) ?? []), term]);
  }
  return carried;
}

/** 語を掛け合わせて、札の種を 1 つ作る。 */
export function combine(opts: CombineOptions): IdeaSeed {
  const lexicon = opts.lexicon ?? defaultLexicon();
  const weights = opts.weights ?? {};
  const materials = opts.materials ?? [];
  const fixed = opts.fixed ?? {};
  const rng = rngFrom(opts.seed);
  const hasMaterial = materials.length > 0 || Boolean(fixed.material);
  const hasMechanisms = (lexicon.pools.mechanisms ?? []).length > 0;
  const fillable = (t: Template): boolean => (hasMaterial || !t.needs.includes('material')) && (hasMechanisms || !t.needs.includes('mechanism'));

  let candidates = lexicon.templates.filter((t) => !opts.tone || t.tone === opts.tone);
  if (candidates.length === 0) candidates = [...lexicon.templates];
  // 材料が在るなら、それを使う型を先にする。概念だけの型は、テーマが無いときのためのもの
  const grounded = hasMaterial ? candidates.filter((t) => t.needs.includes('material')) : [];
  candidates = (grounded.length > 0 ? grounded : candidates).filter(fillable);
  if (candidates.length === 0) candidates = lexicon.templates.filter(fillable);
  const named = opts.templateId ? lexicon.templates.find((t) => t.id === opts.templateId && fillable(t)) : undefined;
  // 名指しのときも、乱数は 1 つ進める（名指しの有無で、あとの語の引き方が変わらないように）
  const drawn = rng.choice(candidates);
  const template = named ?? drawn;

  const usablePools = new Set(template.needs.map((s) => SLOT_TO_POOL[s]).filter((p): p is string => Boolean(p)));
  const carried = pickInherited(rng, opts.inherit ?? [], opts.inheritCount ?? 0, usablePools);
  const takeCarried = (pool: string): string | undefined => carried.get(pool)?.pop();
  const slots: Record<string, string> = {};
  const used: UsedTerm[] = [];
  let novelty = 0.5;

  // 材料を先に決める。材料は利用者の語なので、語のプールと重なりうる（「通知」は概念にも在る）。
  // 先に決めて、あとの抽選から外す（外さないと「通知と通知は…同じではないか」が出る）
  if (template.needs.includes('material')) {
    const kept = fixed.material ?? takeCarried('materials');
    const chosen = kept ?? weighted(rng, materials.map((m) => ({ term: m, domains: [], kind: 'noun' })), weights).term;
    slots.material = chosen;
    used.push(['materials', chosen]);
  }
  const avoid = new Set(slots.material ? [slots.material] : []);

  // 概念は「遠い 2 語」をまとめて引くので、先に片づける
  const conceptSlots = template.needs.filter((s) => SLOT_TO_POOL[s] === 'concepts');
  if (conceptSlots.length > 0) {
    const pool = without(byDomain(lexicon.pools.concepts ?? [], opts.domain), avoid);
    if (conceptSlots.length >= 2) {
      // 片方だけ引き継ぐ（両方引き継ぐと、元と同じ組になる）
      const kept = fixed.concept_a ?? takeCarried('concepts');
      let a: string;
      let b: string;
      if (kept !== undefined) {
        let other = weighted(rng, pool, weights);
        for (let i = 0; i < CANDIDATE_TRIES && other.term === kept; i += 1) other = weighted(rng, pool, weights);
        if (other.term === kept) other = pool.find((t) => t.term !== kept) ?? other;
        a = kept; b = other.term;
      } else {
        const pair = pickFarPair(rng, pool, weights);
        a = pair[0].term; b = pair[1].term;
      }
      slots.concept_a = a; slots.concept_b = b;
      used.push(['concepts', a], ['concepts', b]);
      const ta = pool.find((t) => t.term === a);
      const tb = pool.find((t) => t.term === b);
      if (ta && tb) novelty = distance(ta, tb);
    } else {
      const slot = conceptSlots[0]!;
      const term = fixed[slot] ?? takeCarried('concepts') ?? weighted(rng, pool, weights).term;
      slots[slot] = term;
      used.push(['concepts', term]);
      avoid.add(term);
    }
  }

  for (const slot of template.needs) {
    if (slot in slots) continue;
    const poolName = SLOT_TO_POOL[slot];
    if (!poolName) throw new Error(`知らないスロットです: ${slot}（型 ${template.id}）`);
    const pool = without(poolFor(lexicon, slot, poolName, opts.domain), avoid);
    let kept = fixed[slot] ?? takeCarried(poolName);
    // 引き継いだ語が、このスロットの形に合わない（名詞句のスロットに疑問節が来た等）。引き継ぎを諦めて引き直す
    if (kept !== undefined && !pool.some((t) => t.term === kept)) kept = undefined;
    const chosen = kept !== undefined ? pool.find((t) => t.term === kept)! : weighted(rng, pool, weights);
    slots[slot] = chosen.term;
    used.push([poolName, chosen.term]);
    if (slot === 'mechanism') {
      // 語（何の）だけでなく、1 文（どうしているか）と出典と、どの側面の話かを運ぶ
      slots.mechanism_how = chosen.how ?? '';
      slots.mechanism_source = chosen.source ?? '';
      slots.mechanism_aspect = chosen.aspect ?? '';
    }
  }

  return { templateId: template.id, tone: template.tone, slots, seed: opts.seed, terms: used, novelty };
}

/** 種を日本語の文にする。 */
export function render(seed: IdeaSeed, lexicon: Lexicon = defaultLexicon()): string {
  const template = lexicon.templates.find((t) => t.id === seed.templateId);
  if (!template) throw new Error(`文の型 ${seed.templateId} が見つかりません`);
  return template.text.replace(/\{([a-z_]+)\}/g, (whole, name: string) => seed.slots[name] ?? whole);
}
