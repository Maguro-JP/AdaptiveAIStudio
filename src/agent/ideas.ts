/**
 * アイデア生成 — 語の衝突で発想の種を作り、提案に載せる。
 *
 * IDEAMAN の生成エンジン（組み合わせ＋磨き）を、AdaptiveAIStudio の作りに合わせて移したもの。
 * 「AI が質問に答える」のではなく「普段結びつかないものが偶然ぶつかる」ことで
 * きっかけを生む。そのため素直な重み付きランダムではなく、候補を複数回引いて
 * 互いの分野タグが遠い組を選ぶ。
 *
 * 流れ:
 *   材料（いま取り組んでいること）＋語彙 → 種（衝突）→ 文章化 → 磨き（送り口）→ 提案
 *
 * 磨きは必ず検問を通す。通らなければ素の文章を出す。ここで例外は投げない
 * （磨けなくても、アイデアそのものは提案にできる）。
 *
 * 移していないもの: 語の重みの学習（評価で育てる）と、連想の連鎖（直前の
 * アイデアの語を引き継ぐ）、外から採る仕組み（mechanisms）。仕組みを使う
 * 文型は、語彙に仕組みが無い間は自動で選ばれなくなる（IDEAMAN と同じ決まり）。
 */
import { IDEA_LEXICON } from './idea-lexicon.ts';
import type { Proposal } from './proposals.ts';

export interface IdeaTerm {
  term: string;
  /** 分野タグ。重なりが少ないほど「遠い」組になる。 */
  domains: string[];
  /** 語の文法的な形。aspects でだけ意味を持つ（noun = 名詞句、clause = 疑問節）。 */
  kind?: string;
  /** mechanisms でだけ使う。何をどうしているかの一文と出典、どの側面の話か。 */
  how?: string;
  source?: string;
  aspect?: string;
}

export interface IdeaTemplate {
  id: string;
  tone: string;
  needs: string[];
  text: string;
}

export interface IdeaLexicon {
  pools: Record<string, IdeaTerm[]>;
  moods: string[];
  templates: IdeaTemplate[];
}

export interface IdeaSeed {
  templateId: string;
  tone: string;
  slots: Record<string, string>;
  domain?: string;
  mood: string;
  seed: number;
  /** 抽選に使われた語（プール名と語）。 */
  terms: Array<readonly [string, string]>;
  /** 引いた概念同士の遠さ（0〜1）。測れないときは中立の 0.5。 */
  novelty: number;
}

/** 1回の抽選で試す候補の数。多いほど「遠い組」が選ばれやすいが、大きすぎると毎回似た最遠ペアに収束する。 */
const CANDIDATE_TRIES = 6;

/** 分野で絞った結果、これ未満しか残らないなら、足りない分をタグ無しの語で埋める。 */
const MIN_NARROWED = 4;

/** スロット名 -> そこに入れてよい語の形。名詞句と疑問節を混ぜると壊れた日本語が出るので、スロット側で決める。 */
const SLOT_KINDS: Record<string, string> = {
  aspect: 'noun',
  aspect_q: 'clause',
  operation_v: 'verb',
};

/** 文型の needs にある名前 -> 引くべきプール名。material はプールから引かず、呼び出し側の材料を使う。 */
const SLOT_TO_POOL: Record<string, string> = {
  concept_a: 'concepts',
  concept_b: 'concepts',
  operation: 'operations',
  operation_v: 'operations',
  constraint: 'constraints',
  provocation: 'provocations',
  aspect: 'aspects',
  aspect_q: 'aspects',
  probe: 'probes',
  material: 'materials',
  mechanism: 'mechanisms',
};

/** 署名に数えないプール。probes は「まず何で試すか」という言い方であって、発想の中身ではない。 */
const SIGNATURE_IGNORED_POOLS = new Set(['probes']);

/** 同じ組み合わせに再到達したかを判定する署名。文型と、発想を担う語の集合だけで決まる（語順やシードは含めない）。 */
export function ideaSignature(seed: IdeaSeed): string {
  const terms = seed.terms
    .filter(([pool]) => !SIGNATURE_IGNORED_POOLS.has(pool))
    .map(([pool, term]) => `${pool}:${term}`)
    .sort();
  return `${seed.templateId}|${terms.join('|')}`;
}

/** 提案キューに残すときの指紋。手がかり由来の指紋と混ざらないよう、頭に `idea:` を付ける。 */
export function ideaFingerprint(seed: IdeaSeed): string {
  return `idea:${ideaSignature(seed)}`;
}

/** 種を固定できる乱数。同じ seed なら同じ種が再現できる（試験と再現のため）。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;

function choice<T>(rng: Rng, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]!;
}

function weightedChoice(rng: Rng, terms: readonly IdeaTerm[], weights: Record<string, number>): IdeaTerm {
  const ws = terms.map((t) => Math.max(weights[t.term] ?? 1.0, 0));
  const total = ws.reduce((a, b) => a + b, 0);
  if (total <= 0) return choice(rng, terms);
  let r = rng() * total;
  for (const [i, t] of terms.entries()) {
    r -= ws[i]!;
    if (r < 0) return t;
  }
  return terms[terms.length - 1]!;
}

/** 2語の「遠さ」。分野タグの重なりが少ないほど大きい（Jaccard 距離）。どちらもタグなしなら中間値。 */
function distance(a: IdeaTerm, b: IdeaTerm): number {
  const da = new Set(a.domains);
  const db = new Set(b.domains);
  const union = new Set([...da, ...db]);
  if (union.size === 0) return 0.5;
  let shared = 0;
  for (const d of da) if (db.has(d)) shared += 1;
  return 1 - shared / union.size;
}

/** 互いに遠い2語を選ぶ。 */
function pickFarPair(rng: Rng, terms: readonly IdeaTerm[], weights: Record<string, number>): [IdeaTerm, IdeaTerm] {
  if (terms.length < 2) throw new Error('ペアを作るには2語以上必要です');
  let best: [IdeaTerm, IdeaTerm] | undefined;
  let bestScore = -1;
  for (let i = 0; i < CANDIDATE_TRIES; i += 1) {
    const a = weightedChoice(rng, terms, weights);
    const b = weightedChoice(rng, terms, weights);
    if (a.term === b.term) continue;
    const score = distance(a, b);
    if (score > bestScore) { best = [a, b]; bestScore = score; }
  }
  if (best === undefined) {
    // 全試行が同じ語を引いた場合の予備。重ならない2語を順に取る。
    const a = choice(rng, terms);
    const b = terms.find((t) => t.term !== a.term)!;
    best = [a, b];
  }
  return best;
}

function filterByDomain(terms: readonly IdeaTerm[], domain: string | undefined): IdeaTerm[] {
  if (domain === undefined) return [...terms];
  const narrowed = terms.filter((t) => t.domains.includes(domain));
  if (narrowed.length === 0) return [...terms];
  if (narrowed.length >= MIN_NARROWED) return narrowed;
  const others = terms.filter((t) => !t.domains.includes(domain));
  return [...narrowed, ...others.slice(0, MIN_NARROWED - narrowed.length)];
}

/** そのスロットに入れてよい語だけに絞ったプール。絞って空になったら絞らない（文が壊れるより、語が偏るほうがまし）。 */
function poolForSlot(lexicon: IdeaLexicon, slot: string, poolName: string, domain?: string): IdeaTerm[] {
  const kind = SLOT_KINDS[slot];
  let pool = lexicon.pools[poolName] ?? [];
  if (kind !== undefined) {
    const kept = pool.filter((t) => (t.kind ?? 'noun') === kind);
    if (kept.length > 0) pool = kept;
  }
  return filterByDomain(pool, domain);
}

/** すでに使った語を候補から外す。外して空になったら外さない（語が被るより、文が作れないほうが困る）。 */
function without(terms: readonly IdeaTerm[], avoid: ReadonlySet<string>): IdeaTerm[] {
  if (avoid.size === 0) return [...terms];
  const kept = terms.filter((t) => !avoid.has(t.term));
  return kept.length > 0 ? kept : [...terms];
}

export interface CombineOptions {
  lexicon?: IdeaLexicon;
  /** 語 -> 重み。未知の語は 1.0 扱い。0.0 の語は抽選から外れる。 */
  weights?: Record<string, number>;
  domain?: string;
  /** oracle / proposal / question のいずれか。省略時はランダム。 */
  tone?: string;
  seed?: number;
  /**
   * いま取り組んでいるテーマの材料（例: 通知、会議）。
   * これが有益さの源。汎用の概念だけを衝突させても宙に浮いた警句にしかならないので、
   * 片方を利用者自身の語にする。空のときは material を使わない文型に限られる。
   */
  materials?: readonly string[];
  mood?: string;
}

/** 語彙を衝突させて種を1つ作る。同じ語彙・同じ seed なら同じ種が再現できる。 */
export function combine(opts: CombineOptions = {}): IdeaSeed {
  const lexicon = opts.lexicon ?? IDEA_LEXICON;
  const weights = opts.weights ?? {};
  const materials = opts.materials ?? [];
  const seed = opts.seed ?? Math.floor(Math.random() * 2 ** 31);
  const rng = mulberry32(seed);

  let candidates = opts.tone === undefined
    ? [...lexicon.templates]
    : lexicon.templates.filter((t) => t.tone === opts.tone);
  if (candidates.length === 0) candidates = [...lexicon.templates];
  if (materials.length > 0) {
    // 材料があるなら、それを使う文型を優先する。
    const grounded = candidates.filter((t) => t.needs.includes('material'));
    if (grounded.length > 0) candidates = grounded;
  } else {
    const usable = candidates.filter((t) => !t.needs.includes('material'));
    candidates = usable.length > 0 ? usable : lexicon.templates.filter((t) => !t.needs.includes('material'));
  }
  if ((lexicon.pools['mechanisms'] ?? []).length === 0) {
    // 仕組みをまだ採っていないなら、それを使う文型は埋められない。
    const usable = candidates.filter((t) => !t.needs.includes('mechanism'));
    candidates = usable.length > 0 ? usable : lexicon.templates.filter((t) => !t.needs.includes('mechanism'));
  }
  const template = choice(rng, candidates);

  const slots: Record<string, string> = {};
  const used: Array<readonly [string, string]> = [];
  // 概念を1つしか引かない文型では衝突の距離が測れない。測れない＝中立として 0.5 を既定にする。
  let novelty = 0.5;

  // 材料を先に決める。材料は利用者の語彙なので、語彙プールと衝突しうる。
  // 先に決めておけば、あとの抽選から除外できる（「通知と通知は…」のような重なりを防ぐ）。
  if (template.needs.includes('material')) {
    const chosen = weightedChoice(rng, materials.map((m) => ({ term: m, domains: [] })), weights).term;
    slots['material'] = chosen;
    used.push(['materials', chosen] as const);
  }
  const avoid = new Set(slots['material'] !== undefined ? [slots['material']] : []);

  // concepts は「遠い2語」をまとめて引く必要があるので先に処理する。
  const conceptSlots = template.needs.filter((s) => SLOT_TO_POOL[s] === 'concepts');
  if (conceptSlots.length >= 2) {
    const pool = without(filterByDomain(lexicon.pools['concepts'] ?? [], opts.domain), avoid);
    const [a, b] = pickFarPair(rng, pool, weights);
    slots[conceptSlots[0]!] = a.term;
    slots[conceptSlots[1]!] = b.term;
    used.push(['concepts', a.term] as const, ['concepts', b.term] as const);
    novelty = distance(a, b);
  } else if (conceptSlots.length === 1) {
    const pool = without(filterByDomain(lexicon.pools['concepts'] ?? [], opts.domain), avoid);
    const term = weightedChoice(rng, pool, weights);
    slots[conceptSlots[0]!] = term.term;
    used.push(['concepts', term.term] as const);
  }

  for (const slot of template.needs) {
    if (slots[slot] !== undefined) continue;
    const poolName = SLOT_TO_POOL[slot];
    if (poolName === undefined) throw new Error(`未知のスロット ${slot} (template=${template.id})`);
    const pool = without(poolForSlot(lexicon, slot, poolName, opts.domain), avoid);
    const term = weightedChoice(rng, pool, weights);
    slots[slot] = term.term;
    used.push([poolName, term.term] as const);
    if (slot === 'mechanism') {
      // 語（何の）だけでなく、一文（どうしているか）と出典を運ぶ。出典は文には出さないが、種に残す。
      slots['mechanism_how'] = term.how ?? '';
      slots['mechanism_source'] = term.source ?? '';
      slots['mechanism_aspect'] = term.aspect ?? '';
    }
  }

  return {
    templateId: template.id,
    tone: template.tone,
    slots,
    ...(opts.domain !== undefined ? { domain: opts.domain } : {}),
    mood: opts.mood ?? choice(rng, lexicon.moods),
    seed,
    terms: used,
    novelty,
  };
}

/** 種を日本語の文章にする。対応する文型が語彙に無ければ投げる。 */
export function render(seed: IdeaSeed, lexicon: IdeaLexicon = IDEA_LEXICON): string {
  const template = lexicon.templates.find((t) => t.id === seed.templateId);
  if (template === undefined) throw new Error(`テンプレート ${seed.templateId} が見つかりません`);
  return template.text.replace(/\{(\w+)\}/g, (_all, name: string) => {
    const value = seed.slots[name];
    if (value === undefined) throw new Error(`テンプレート ${template.id} の {${name}} を埋められません`);
    return value;
  });
}

/* ------------------------------------------------------------------ */
/* 磨き — 種から作った素の文章を、送り口のモデルに一度だけ通して整える。 */
/* IDEAMAN の refiner と同じ決まり: 検問を通らない返事は採用しない。     */
/* ------------------------------------------------------------------ */

export const POLISH_SYSTEM = `あなたはアイデアの種を短い日本語に整える編集者です。ユーザーの質問に答えるアシスタントではありません。

守ること:
- 与えられた素材の語をすべて活かす。新しい題材を持ち込まない。
- 出力は1〜2文だけ。整えた文以外（解説・箇条書き・鉤括弧）は出さない。
- 説明しない。断定して終わる。読み手が自分で考える余白を残す。
- 元の文の語調（お告げ／提案／問い）を保つ。
整えた文だけを出力してください。`;

/** 仕上がりが元の何倍までなら受け入れるか。「1〜2文」と指示しているので、大きく超えたら余分な文が混ざっている。 */
export const MAX_GROWTH = 2.5;

/** 混ざっていたら捨てる合図。タグの漏れ、箇条書き、余分な書き出し。 */
const SUSPICIOUS = ['<thinking', '</thinking', '<', '```', '- ', '* ', '1. '] as const;

export function polishPrompt(seed: IdeaSeed, text: string): string {
  const slots = Object.entries(seed.slots).map(([k, v]) => `- ${k}: ${v}`).join('\n');
  return `素材:\n${slots}\n\n語調: ${seed.tone}\n気分: ${seed.mood}\n\n整える前の文:\n${text}`;
}

/**
 * 仕上がりをそのままアイデアとして出してよいか。
 * ここを通った文字列は、そのまま利用者の目に入る。モデルが余分な書き出しを付けたり、
 * 思考のタグを漏らしたり、箇条書きにしたりしたら、素の文章のほうがまだよい。
 * 判定できないものは受け入れない側に倒す。
 */
export function usablePolished(refined: string, original: string): boolean {
  const text = refined.trim();
  if (text === '') return false;
  if (text.length > Math.max(original.length * MAX_GROWTH, 40)) return false;
  if (SUSPICIOUS.some((mark) => text.includes(mark))) return false;
  // 1〜2文と指示している。句点が多すぎるなら説明が始まっている。
  return (text.match(/。/g) ?? []).length <= 3;
}

/** 送り口への一回きりの依頼。答えが取れなければ undefined（呼ぶ側は素の文章に倒れる）。 */
export type IdeaComplete = (system: string, prompt: string) => Promise<string | undefined>;

/**
 * 種と素の文章を受け取り、磨いた文章と出どころを返す。
 * source は `llm`（磨いた）か `engine`（そのまま）。失敗時は必ず後者。例外は投げない。
 */
export async function polishIdea(
  seed: IdeaSeed, text: string, complete: IdeaComplete | undefined,
): Promise<{ text: string; source: 'llm' | 'engine' }> {
  if (complete === undefined) return { text, source: 'engine' };
  let refined: string | undefined;
  try {
    refined = await complete(POLISH_SYSTEM, polishPrompt(seed, text));
  } catch {
    return { text, source: 'engine' };
  }
  if (refined !== undefined && usablePolished(refined, text)) return { text: refined.trim(), source: 'llm' };
  return { text, source: 'engine' };
}

/* ------------------------------------------------------------------ */
/* 提案まで — 衝突させて、文章にして、磨いて、提案の形にする。           */
/* ------------------------------------------------------------------ */

/** 既出の組み合わせを引いたときの描き直しの上限（IDEAMAN の MAX_REDRAWS と同じ）。 */
export const MAX_REDRAWS = 6;

export interface ProposeIdeaOptions extends CombineOptions {
  /** 提案キューが既に見た指紋（`ideaFingerprint` の形）。同じ組み合わせは出さない。 */
  seen?: ReadonlySet<string>;
  /** 磨きに使う送り口。無ければ磨かずに素の文章を出す。 */
  complete?: IdeaComplete;
  redraws?: number;
}

export interface ProposedIdea {
  seed: IdeaSeed;
  /** 表に出す文章。磨きが通れば磨いたもの、通らなければ素の文章。 */
  text: string;
  source: 'llm' | 'engine';
}

/**
 * アイデアを1つ作る。既出の組み合わせしか引けなければ undefined
 * （同じ発想を何度も提案にしない）。磨きは出すと決まってから行う。
 */
export async function proposeIdea(opts: ProposeIdeaOptions = {}): Promise<ProposedIdea | undefined> {
  const seen = opts.seen ?? new Set<string>();
  const redraws = opts.redraws ?? MAX_REDRAWS;
  let seed: IdeaSeed | undefined;
  for (let attempt = 0; attempt <= redraws; attempt += 1) {
    seed = combine({ ...opts, seed: attempt === 0 ? opts.seed : undefined });
    if (!seen.has(ideaFingerprint(seed))) break;
    seed = undefined;
  }
  if (seed === undefined) return undefined;
  const raw = render(seed, opts.lexicon ?? IDEA_LEXICON);
  const polished = await polishIdea(seed, raw, opts.complete);
  return { seed, text: polished.text, source: polished.source };
}

/** 提案キューへ渡す形にする。実行するかは利用者が決めるので、提案は提案のまま置く。 */
export function ideaProposal(
  idea: ProposedIdea, evidence: string[], root?: string,
): Omit<Proposal, 'id' | 'status' | 'createdAt'> {
  const material = idea.seed.slots['material'];
  const words = idea.seed.terms
    .filter(([pool]) => pool !== 'probes')
    .map(([, term]) => term);
  const rationale = [
    material !== undefined
      ? `いまの材料「${material}」と、普段結びつかない語（${words.join('、')}）を衝突させて作った発想です。`
      : `普段結びつかない語（${words.join('、')}）を衝突させて作った発想です。`,
    `語調は ${idea.seed.tone}、気分は ${idea.seed.mood}。`,
    idea.source === 'llm' ? '文章はモデルに一度通して整えました。' : '文章は型どおりの素のままです。',
  ].join('');
  return {
    kind: 'question',
    title: idea.text,
    rationale,
    evidence,
    suggestedAction: `アイデア「${idea.text}」を、この作業場で活かせるか検討してください。まず関係するファイルを読み、最小の試し方と、やらない理由があるならそれを示してください。`,
    fingerprint: ideaFingerprint(idea.seed),
    ...(root !== undefined ? { root } : {}),
    origin: 'idea',
  };
}

/**
 * 材料を集める。いま取り組んでいることの語が、有益さの源になる。
 * 作業場の様子（未コミットの変更・最近触ったファイル）と、記憶の題から拾う。
 * 長い題は材料にならない（文がそのまま入ると衝突にならない）ので、短いものだけ。
 */
export function materialsFromContext(input: {
  changedFiles?: readonly string[];
  recentFiles?: readonly string[];
  memoryTitles?: readonly string[];
}): string[] {
  const out: string[] = [];
  const push = (word: string) => {
    const w = word.trim();
    if (w !== '' && !out.includes(w)) out.push(w);
  };
  for (const title of input.memoryTitles ?? []) {
    if (title.trim().length <= 16) push(title);
  }
  const baseName = (path: string) => path.split('/').pop()!.replace(/\.[^.]+$/, '');
  for (const f of input.changedFiles ?? []) push(baseName(f));
  for (const f of input.recentFiles ?? []) push(baseName(f));
  return out.slice(0, 24);
}
