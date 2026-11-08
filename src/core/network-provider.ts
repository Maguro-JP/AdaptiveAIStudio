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
  /** 何を挙げ、何を取り、何を載せたかを書く先（画面の記録、ui.log）。置かなければ書かない。 */
  log?: (level: 'info' | 'warn', message: string) => void;
  /** 今の事実（天気など）を取り損ねたときの、取り直しまでの間（ミリ秒）。1・2 倍と延ばす。試験では 0。 */
  liveRetryWaitMs?: number;
}

/** 今の事実を取りに行く回数（最初の 1 回を含む）。私の推測で決めた値。 */
export const LIVE_FETCH_TRIES = 3;

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
  readonly #log: (level: 'info' | 'warn', message: string) => void;
  readonly #liveRetryWaitMs: number;

  /** `inner`: 依頼に中の候補が添えられていないときに使う候補（これが無かったときの候補）。 */
  constructor(registry: ProviderRegistry, inner: () => readonly string[], opts: NetworkOptions = {}) {
    this.#inner = inner;
    this.#orchestrator = new ChatOrchestrator(registry);
    this.#shelf = opts.shelf ?? new KnowledgeShelf();
    this.#lister = opts.lister ?? new InnerNeedLister(this.#orchestrator);
    this.#source = opts.source;
    this.#inspector = opts.inspector;
    this.#settleAtEnd = opts.settleAtEnd ?? false;
    this.#log = opts.log ?? (() => undefined);
    this.#liveRetryWaitMs = opts.liveRetryWaitMs ?? 1000;
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
    /*
     * 天気・Node.js の版のような今の事実の問いは、挙げる段にも前の回にも頼らず、利用者の一言そのままで毎回取りに行く。
     * 押し戻し（nudge）の回でも、押し戻しの文ではなく、その前の利用者の一言で決める（取り直しの機会にもなる）。
     * 蔵の言葉の重なり（`find`）で、経験の件（「明日の天気を確認する依頼…」）に当てない。取り損ねたら間を置いて取り直す
     * （Windows の work、run 42466889666: 二つ目の「明日の天気は?」で、取る段が 8 秒の時間切れで黙って落ち、何も載らなかった）
     */
    const said = lastUserSaid(input.messages);
    const live = Boolean(this.#source) && isLiveQuestion(said) ? said.slice(0, 200) : undefined;
    const listed = await this.#lister.list(input, signal).catch((e: unknown) => {
      this.#log('warn', `ネットワーク: 要る事実を挙げられませんでした: ${errorText(e)}`);
      return [] as string[];
    });
    const needs = (Array.isArray(listed) ? listed.slice(0, MAX_NEEDS) : []).filter((q): q is string => typeof q === 'string');
    // 挙げた問いの中の今の事実は、利用者の一言に置き換える（重ねない。挙げる段は「2026年11月9日の天気」と言い換える）
    if (live) for (let i = needs.length - 1; i >= 0; i--) if (isLiveQuestion(needs[i]!)) needs.splice(i, 1);
    this.#log('info', `ネットワーク: 要る事実 ${JSON.stringify(needs)}${live ? `、今の事実 ${JSON.stringify(live)}` : ''}`);
    const found: KnowledgeEntry[] = [];
    const ephemeral = new Set<KnowledgeEntry>();
    if (live) {
      const e = await this.#fetchLive(live, signal);
      if (e) { found.push(e); ephemeral.add(e); }
    }
    for (const q of needs) {
      let e = await this.#shelf.find(q).catch(() => undefined);
      if (e) this.#log('info', `ネットワーク: 蔵に当たりました: ${JSON.stringify(q)} → ${JSON.stringify(e.question)}`);
      if (!e && this.#source) {
        const got = await gather(q, this.#source, this.#shelf, signal, this.#inspector ? { inspector: this.#inspector } : {})
          .catch((err: unknown) => ({ status: 'failed' as const, reason: errorText(err) }));
        if (got.status === 'stored') { e = got.entry; if (got.ephemeral) ephemeral.add(e); }
        this.#log(got.status === 'stored' ? 'info' : 'warn', `ネットワーク: 取りました ${JSON.stringify(q)}: ${got.status === 'stored' ? got.entry.sourceUrl : `${got.status}（${got.reason}）`}`);
      }
      if (e && !found.includes(e)) found.push(e);
    }
    this.#log('info', `ネットワーク: 載せた事実 ${found.length} 件${found.length ? `: ${found.map((e) => JSON.stringify(e.question)).join(', ')}` : ''}`);
    // 蔵に無い件（今の事実）は、点を動かす相手にしない
    used.push(...found.filter((e) => !ephemeral.has(e)));
    const block = knowledgeBlock(found);
    if (!block) return input.system;
    return input.system ? `${input.system}\n\n${block}` : block;
  }

  /** 今の事実を、蔵を見ずに取りに行く。投げられた失敗も、取れなかったも、間を置いて取り直す。 */
  async #fetchLive(question: string, signal: AbortSignal): Promise<KnowledgeEntry | undefined> {
    for (let i = 0; i < LIVE_FETCH_TRIES; i++) {
      if (signal.aborted) return undefined;
      const got = await gather(question, this.#source!, this.#shelf, signal, this.#inspector ? { inspector: this.#inspector } : {})
        .catch((err: unknown) => ({ status: 'failed' as const, reason: errorText(err) }));
      if (got.status === 'stored') {
        this.#log('info', `ネットワーク: 今の事実を取りました（${i + 1} 回目）: ${got.entry.sourceUrl}`);
        return got.entry;
      }
      this.#log('warn', `ネットワーク: 今の事実を取れませんでした（${i + 1} 回目）: ${got.status}（${got.reason}）`);
      // 検問で止めたものと、答えの無いもの（天気でない）は、取り直しても変わらない
      if (got.status === 'blocked') return undefined;
      if (i + 1 < LIVE_FETCH_TRIES && this.#liveRetryWaitMs > 0) {
        await new Promise((r) => setTimeout(r, this.#liveRetryWaitMs * (i + 1)));
      }
    }
    return undefined;
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

/** 最後の利用者の一言。押し戻し（`nudge`）の文は飛ばす。 */
function lastUserSaid(messages: ChatInput['messages']): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'user' && !m.nudge) return String(m.content ?? '');
  }
  return '';
}

/** `fetch failed` だけでは分からないので、下の原因（ECONNRESET など）を添える。 */
function errorText(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause = (e as { cause?: { code?: string; message?: string } }).cause;
  const why = cause?.code ?? cause?.message;
  return why && !e.message.includes(why) ? `${e.message}: ${why}` : e.message;
}
