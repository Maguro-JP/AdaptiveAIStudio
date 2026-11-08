/**
 * ネットワークの送り口（docs/NETWORK-MODEL.md の段階 1）。
 *
 * id は `network`、モデルは `network` の1つだけ。重みは持たない。今は、受けた依頼を、これが無かったときに使っていた
 * 中の候補へ渡す（候補選び・やり直し・切り替え・失敗の扱いは `ChatOrchestrator` のまま）。
 *
 * 段階 2: 知識の蔵（`knowledge.ts`）に何か入っていれば、頼みの最初の一手（最後の発言が利用者のとき）でだけ、
 * 中のモデルに「答えるのに要る事実」を短い問いの並びで挙げさせ、蔵に当たった分を出どころつきで system に足す。
 * 蔵が空なら挙げさせない（段階 1 と同じ依頼のまま。毎回の頼みを遅くしない）。挙げる段が落ちても、問い無しで続ける。
 *
 * 段階 3: 配布元（`source`）を渡したときだけ、蔵に無い問いを取りに行き、検問を通ったものを蔵に入れて使う。
 * 使うほど賢くする: 文脈に入れた件は、頼みが最後まで通れば効いた回数、落ちれば外れた回数が増える（`recordOutcome`）。
 *
 * 呼ぶ側（Session、Agent、ChatOrchestrator の呼び手）は何も変えない。候補の先頭に `network:network` が来るだけ。
 */
import type { ChatProvider, HealthStatus, ModelDescriptor, ProviderChunk, ProviderRequest } from '../providers/contract.ts';
import { ChatOrchestrator, type ChatEvent, type ChatInput } from './orchestrator.ts';
import type { ProviderRegistry } from './registry.ts';
import { KnowledgeShelf, knowledgeBlock, type KnowledgeEntry } from './knowledge.ts';
import { gather, isLiveQuestion, type KnowledgeSource } from './knowledge-source.ts';
import type { Inspector } from '../harness/inspector.ts';
import { arithmeticBlock } from './arithmetic.ts';

export const NETWORK_PROVIDER_ID = 'network';
export const NETWORK_MODEL_ID = 'network:network';
/** 画面に出す名前。 */
export const NETWORK_LABEL = 'ネットワーク';

/** 候補に `network` が入っているか。 */
export function isNetworkModel(id: string | undefined): boolean {
  return id === NETWORK_MODEL_ID;
}

/** 候補から `network` を外したもの（中で使うモデル）。並びはそのまま。 */
export function innerCandidates(candidates: readonly string[]): string[] {
  return candidates.filter((c) => !isNetworkModel(c));
}

/** 中で使うモデルがあれば、先頭に `network` を置く。無ければそのまま（「モデルがありません」の道を変えない）。 */
export function withNetwork(candidates: readonly string[]): string[] {
  const inner = innerCandidates(candidates);
  return inner.length > 0 ? [NETWORK_MODEL_ID, ...inner] : inner;
}

/** 挙げる問いの数の上限と、1つの問いの長さの上限。 */
export const MAX_NEEDS = 5;
const MAX_NEED_CHARS = 80;

/** 「知らないことを挙げる」段。試験では偽物を渡す。 */
export interface NeedLister {
  list(input: ChatInput, signal: AbortSignal): Promise<string[]>;
}

/** 中のモデルの返事から、問いの並び（文字列の配列）だけを取り出す。形が違えば空。 */
export function parseNeeds(text: string): string[] {
  const m = /\[[\s\S]*\]/.exec(text);
  if (!m) return [];
  let raw: unknown;
  try { raw = JSON.parse(m[0]); } catch { return []; }
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === 'string')
    .map((x) => x.trim()).filter((x) => x.length > 0 && x.length <= MAX_NEED_CHARS).slice(0, MAX_NEEDS);
}

const NEEDS_SYSTEM = [
  'あなたは、頼みに答えるのに要る事実を挙げる係です。答えそのものは書かない。',
  `答えは JSON の文字列の配列だけ（最大 ${MAX_NEEDS} 個）。1つは事実の名前の短い問い（ライブラリ名、関数名、エラーの型、版）。`,
  'コードや頼みの本文を写さない。要るものが無ければ [] を返す。',
  '例: ["zod の最新の版", "node:test の mock.timers の使い方"]',
].join('\n');

/** 既定の挙げる段。同じ中の候補へ、温度 0・ツール無しで頼む。 */
export class InnerNeedLister implements NeedLister {
  readonly #orchestrator: ChatOrchestrator;
  constructor(orchestrator: ChatOrchestrator) { this.#orchestrator = orchestrator; }

  async list(input: ChatInput, signal: AbortSignal): Promise<string[]> {
    const last = input.messages.at(-1);
    if (!last || last.role !== 'user') return [];
    let text = '';
    for await (const ev of this.#orchestrator.run({
      candidates: input.candidates, system: NEEDS_SYSTEM, temperature: 0, maxTokens: 200,
      messages: [{ role: 'user', content: last.content }],
    }, signal)) {
      if (ev.type === 'text') text += ev.delta;
      else if (ev.type === 'failed') return [];
    }
    return parseNeeds(text);
  }
}

export interface NetworkOptions {
  shelf?: KnowledgeShelf;
  lister?: NeedLister;
  /** 蔵に無い問いを取りに行く先。置かなければ取りに行かない（段階 2 のまま）。 */
  source?: KnowledgeSource;
  inspector?: Inspector;
  /**
   * 点を動かすのを、頼みの最後（`settle`）まで待つか。置くと、1 回の返事ごとではなく、呼ぶ側が確かめた結果
   * （ファイルが書けて、確かめが通ったか）で動かす。置かなければ、返事が最後まで来たかで動かす（段階 3 のまま）。
   */
  settleAtEnd?: boolean;
}

export class NetworkProvider implements ChatProvider {
  readonly id = NETWORK_PROVIDER_ID;
  /** この機械の中で回す口として扱う（失敗で冷やさない。冷やすのは中の外の口）。 */
  readonly locality = 'local' as const;
  readonly #inner: () => readonly string[];
  readonly #orchestrator: ChatOrchestrator;
  readonly #shelf: KnowledgeShelf;
  readonly #lister: NeedLister;
  readonly #source: KnowledgeSource | undefined;
  readonly #inspector: Inspector | undefined;
  readonly #settleAtEnd: boolean;
  /** `settleAtEnd` のとき、頼みの最後まで持っておく、文脈に入れた件の問い。 */
  readonly #pending = new Set<string>();

  /** `inner`: 依頼に中の候補が添えられていないときに使う候補（これが無かったときの候補）。 */
  constructor(registry: ProviderRegistry, inner: () => readonly string[], opts: NetworkOptions = {}) {
    this.#inner = inner;
    this.#orchestrator = new ChatOrchestrator(registry);
    this.#shelf = opts.shelf ?? new KnowledgeShelf();
    this.#lister = opts.lister ?? new InnerNeedLister(this.#orchestrator);
    this.#source = opts.source;
    this.#inspector = opts.inspector;
    this.#settleAtEnd = opts.settleAtEnd ?? false;
  }

  /** 知識の蔵（呼ぶ側が経験を置くのに使う）。 */
  get shelf(): KnowledgeShelf { return this.#shelf; }

  /** 頼みの最後に呼ぶ。持っておいた件の点を、確かめた結果で動かす。止めた頼みは `ok` を渡さず捨てる。 */
  async settle(ok: boolean | undefined): Promise<void> {
    const qs = [...this.#pending];
    this.#pending.clear();
    if (ok === undefined || qs.length === 0) return;
    await this.#shelf.recordOutcome(qs, ok).catch(() => undefined);
  }

  /** 蔵に当たった分を足した system。当たりが無ければ元のまま（undefined なら undefined のまま）。 */
  async #withKnowledge(input: ChatInput, signal: AbortSignal, used: KnowledgeEntry[]): Promise<string | undefined> {
    if (input.messages.at(-1)?.role !== 'user') return input.system;
    // 問いの中の式は、この機械で計算した値を載せる（モデルに掛け算をさせない）
    const calc = arithmeticBlock(String(input.messages.at(-1)?.content ?? ''));
    const base = calc ? (input.system ? `${input.system}\n\n${calc}` : calc) : input.system;
    const facts = await this.#facts({ ...input, ...(base !== undefined ? { system: base } : {}) }, signal, used);
    return facts;
  }

  async #facts(input: ChatInput, signal: AbortSignal, used: KnowledgeEntry[]): Promise<string | undefined> {
    if (!this.#source && await this.#shelf.isEmpty().catch(() => true)) return input.system;
    const listed = await this.#lister.list(input, signal).catch(() => [] as string[]);
    const needs = Array.isArray(listed) ? listed.slice(0, MAX_NEEDS) : [];
    /*
     * 天気・Node.js の版のような今の事実の問いは、挙げる段に頼らず、利用者の一言そのままで取りに行く（小さいモデルは [] を返して何も取らなかった）。
     * 挙げた問いの中の天気は、利用者の一言に置き換える（重ねない）。挙げる段は「2026年11月9日の天気」のように言い換え、
     * 場所でない「日」を場所と読んで取れなかった（Windows の work、場所の無い「明日の天気は?」）
     */
    const said = String(input.messages.at(-1)?.content ?? '');
    if (this.#source && isLiveQuestion(said)) {
      for (let i = needs.length - 1; i >= 0; i--) if (typeof needs[i] === 'string' && isLiveQuestion(needs[i]!)) needs.splice(i, 1);
      needs.unshift(said.slice(0, 200));
    }
    const found: KnowledgeEntry[] = [];
    const ephemeral = new Set<KnowledgeEntry>();
    for (const q of needs) {
      if (typeof q !== 'string') continue;
      let e = await this.#shelf.find(q).catch(() => undefined);
      if (!e && this.#source) {
        const got = await gather(q, this.#source, this.#shelf, signal, this.#inspector ? { inspector: this.#inspector } : {})
          .catch(() => undefined);
        if (got?.status === 'stored') { e = got.entry; if (got.ephemeral) ephemeral.add(e); }
      }
      if (e && !found.includes(e)) found.push(e);
    }
    // 蔵に無い件（今の事実）は、点を動かす相手にしない
    used.push(...found.filter((e) => !ephemeral.has(e)));
    const block = knowledgeBlock(found);
    if (!block) return input.system;
    return input.system ? `${input.system}\n\n${block}` : block;
  }

  async health(): Promise<HealthStatus> {
    return innerCandidates(this.#inner()).length > 0
      ? { ok: true }
      : { ok: false, reason: '中で使うモデルがありません' };
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return [{
      id: NETWORK_MODEL_ID, providerId: NETWORK_PROVIDER_ID, model: 'network',
      displayName: NETWORK_LABEL, locality: 'local', verified: true,
    }];
  }

  /**
   * 中の候補へ渡し、出来事をそのまま返す（試し・切り替え・本文・ツールの呼び出し・失敗・どのモデルが答えたか）。
   * `candidates` が空なら、作ったときに渡された候補を使う。
   */
  async *relay(input: ChatInput, signal: AbortSignal): AsyncGenerator<ChatEvent> {
    const given = innerCandidates(input.candidates);
    const candidates = given.length > 0 ? given : innerCandidates(this.#inner());
    const used: KnowledgeEntry[] = [];
    const system = await this.#withKnowledge({ ...input, candidates }, signal, used);
    const next: ChatInput = { ...input, candidates };
    if (system !== undefined) next.system = system;
    let ok = false;
    let failed = false;
    for await (const ev of this.#orchestrator.run(next, signal)) {
      if (ev.type === 'done') ok = true;
      else if (ev.type === 'failed') failed = true;
      yield ev;
    }
    // 文脈に入れた件の点を、通ったか落ちたかで動かす（途中で止めたときは動かさない）
    if (used.length > 0 && this.#settleAtEnd) {
      for (const e of used) this.#pending.add(e.question);
    } else if (used.length > 0 && (ok || failed)) {
      await this.#shelf.recordOutcome(used.map((e) => e.question), ok && !failed).catch(() => undefined);
    }
  }

  /** 送り口の契約の形。`ChatOrchestrator` を通さずに呼ばれたとき用。失敗は中の失敗をそのまま投げる。 */
  async *chat(req: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderChunk> {
    const { model: _model, ...rest } = req;
    for await (const ev of this.relay({ ...rest, candidates: [] }, signal)) {
      if (ev.type === 'text') yield { type: 'text', delta: ev.delta };
      else if (ev.type === 'toolCall') yield { type: 'toolCall', call: ev.call };
      else if (ev.type === 'usage') yield ev;
      else if (ev.type === 'done') yield { type: 'done', finishReason: ev.finishReason ?? 'unknown' };
      else if (ev.type === 'failed') throw ev.error;
    }
  }

  async canSeeImages(_model: string, signal?: AbortSignal): Promise<boolean> {
    return this.#orchestrator.canSeeImages(innerCandidates(this.#inner())[0], signal);
  }
}
