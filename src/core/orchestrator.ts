/**
 * 候補モデルを順に試し、正規化エラーの種別に従って
 * リトライ・フォールバック・冷却を行う。
 *
 * 設計上の要点:
 *   - フォールバックは「まだ1文字も出力していない場合」に限る。
 *     出力途中で別モデルに切り替えると、文章が二重・不整合になるため。
 *   - どのモデルが答えたかは必ず呼び出し側へ通知する(暗黙の劣化を防ぐ)。
 */
import type { ChatProvider, FinishReason, ModelId, Priority, ProviderMessage, ToolCall, ToolSchema } from '../providers/contract.ts';
import { ProviderError } from '../providers/errors.ts';
import type { ProviderRegistry } from './registry.ts';

export type ChatEvent =
  | { type: 'attempt'; modelId: ModelId; attempt: number }
  | { type: 'fallback'; from: ModelId; to: ModelId; reason: string }
  | { type: 'text'; delta: string }
  | { type: 'toolCall'; call: ToolCall }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  /** finishReason: 相手が言った終わり方。`length` は出力の上限で切れた（言い終えていない）。 */
  | { type: 'done'; modelId: ModelId; fallbackFrom?: ModelId; finishReason?: FinishReason }
  | { type: 'failed'; error: ProviderError };

export interface ChatInput {
  candidates: ModelId[];
  system?: string;
  messages: ProviderMessage[];
  temperature?: number;
  maxTokens?: number;
  tools?: ToolSchema[];
  /** 優先度。無ければ provider へ渡さない（既定は受ける側が決める）。 */
  priority?: Priority;
}

/** 待つ。止めるボタン（signal）で抜ける。抜けた後は、呼ぶ側が `signal.aborted` を見て終わる。 */
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((r) => {
  if (signal?.aborted) return r();
  const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); r(); };
  const timer = setTimeout(done, ms);
  signal?.addEventListener('abort', done, { once: true });
});

/**
 * やり直すまでに待つ上限。相手の `Retry-After` は上限が無く（3600 秒や数時間先の日時が来る）、そのまま待つと、その間は依頼が
 * 動いたまま・次の依頼は順番待ち・■も効かない、になっていた。
 *
 * - 次の候補があるとき: これより長く待てと言われたら、待たずに次の候補へ回す
 * - 最後の候補のとき: `MAX_LAST_RETRY_WAIT_MS` までは待つ（35〜60 秒の 429 はよく来る。待てば通るものを落とさない）。
 *   それより長ければ、何秒待てと言われたかを添えて落ちたと言う
 * どちらの待ちも ■ で抜ける。
 */
export const MAX_RETRY_WAIT_MS = 30_000;
export const MAX_LAST_RETRY_WAIT_MS = 5 * 60_000;

export class ChatOrchestrator {
  readonly #registry: ProviderRegistry;

  constructor(registry: ProviderRegistry) {
    this.#registry = registry;
  }

  /** 画像を読めない相手へは、画像を外し、渡していないことを依頼の文に添える。画像が無ければそのまま。 */
  async #forModel(
    messages: readonly ProviderMessage[], provider: ChatProvider, model: string, signal: AbortSignal,
  ): Promise<ProviderMessage[]> {
    if (!messages.some((m) => m.images && m.images.length > 0)) return [...messages];
    const sees = provider.canSeeImages ? await provider.canSeeImages(model, signal).catch(() => false) : false;
    if (sees) return [...messages];
    return messages.map((m) => {
      if (!m.images || m.images.length === 0) return m;
      const { images: _images, ...rest } = m;
      return { ...rest, content: `${m.content}\n\n（添えた画像は、いまのモデルが読めないので渡していません）` };
    });
  }

  /** そのモデル（`送り口:モデル`）が画像を読めるか。分からなければ false。 */
  async canSeeImages(id: string | undefined, signal?: AbortSignal): Promise<boolean> {
    const r = id ? this.#registry.resolve(id) : undefined;
    if (!r?.provider.canSeeImages) return false;
    return r.provider.canSeeImages(r.model, signal).catch(() => false);
  }

  async *run(input: ChatInput, signal: AbortSignal): AsyncGenerator<ChatEvent> {
    const usable = input.candidates.filter((id) => {
      const r = this.#registry.resolve(id);
      return r !== undefined && this.#registry.isAvailable(r.provider.id);
    });

    if (usable.length === 0) {
      yield {
        type: 'failed',
        error: new ProviderError({
          kind: 'unavailable',
          providerId: '-',
          message: noUsableMessage(this.#registry, input.candidates),
        }),
      };
      return;
    }

    let lastError: ProviderError | undefined;
    let previousModelId: ModelId | undefined;

    for (const [index, modelId] of usable.entries()) {
      const isLast = index === usable.length - 1;
      const resolved = this.#registry.resolve(modelId)!;
      const { provider, model } = resolved;
      // この依頼の中で冷やした口の候補は飛ばす（同じ鍵・同じ残高・同じ制限でもう一度叩き、切り替えの知らせも二度出ていた）
      if (index > 0 && !this.#registry.isAvailable(provider.id)) continue;
      // 試しを始めた時刻。やり直しのたびに取り直す（自分の前の試しが付けた冷やしは、成功で解く）
      let triedAt = this.#registry.clock();

      if (previousModelId && lastError) {
        yield {
          type: 'fallback',
          from: previousModelId,
          to: modelId,
          reason: `${lastError.kind}: ${lastError.message}`,
        };
      }

      // 画像を読めない相手には、画像を外して送る。依頼の文が「添えた画像」を指すので、渡していないことも添える
      //（先頭の候補で読めると決めて載せた画像が、切り替えた先の読めないモデルにもそのまま渡り、断られるか黙って無視されていた）
      const messages = await this.#forModel(input.messages, provider, model, signal);

      let attempt = 0;
      // 同一モデル内のリトライ。retries は kind ごとの規則から決まる。
      for (;;) {
        if (signal.aborted) return;
        triedAt = this.#registry.clock();
        yield { type: 'attempt', modelId, attempt };

        let emitted = false;
        let finishReason: FinishReason | undefined;
        try {
          for await (const chunk of provider.chat(
            { model, system: input.system, messages,
              temperature: input.temperature, maxTokens: input.maxTokens,
              tools: input.tools,
              ...(input.priority !== undefined ? { priority: input.priority } : {}) },
            signal,
          )) {
            if (chunk.type === 'text') {
              emitted = true;
              yield { type: 'text', delta: chunk.delta };
            } else if (chunk.type === 'toolCall') {
              // ツール呼び出しも「出力済み」とみなす。
              // ここで別モデルに切り替えると、呼び出しが二重に実行される。
              emitted = true;
              yield { type: 'toolCall', call: chunk.call };
            } else if (chunk.type === 'usage') {
              yield { type: 'usage', inputTokens: chunk.inputTokens, outputTokens: chunk.outputTokens };
            } else if (chunk.type === 'done') {
              finishReason = chunk.finishReason;
            }
          }
          this.#registry.clearCooldown(provider.id, triedAt);
          yield { type: 'done', modelId, fallbackFrom: previousModelId, ...(finishReason ? { finishReason } : {}) };
          return;
        } catch (e) {
          const err = e instanceof ProviderError
            ? e
            : new ProviderError({
                kind: 'unavailable', providerId: provider.id, cause: e,
                message: e instanceof Error ? e.message : String(e),
              });

          // 黙って終わってよいのは、利用者が止めたときだけ。中の時計などで打ち切られたのに黙ると、呼ぶ側は本文も失敗も
          // 受け取らず「返事が空でした」とモデルのせいにしていた
          if (err.kind === 'canceled') {
            if (signal.aborted) return;
            yield { type: 'failed', error: err };
            return;
          }

          /*
           * **地元の口は冷やさない。**
           *
           * 冷却は、外の口（雲）の割当てを守り、その間に別の口へ逃がすためのもの。
           * この機械の中の口（inproc の子プロセス、Ollama）では意味が違う。
           * 落ちた原因は子が消えたことで、それは**次の送信で読み直す**と直る。
           * ここで 5 分冷やすと、読み直せているのに「利用できるモデルがありません」で
           * 0.0 秒で終わり続ける（子を殺して確かめた）。逃がす先も、たいてい無い。
           */
          if (provider.locality !== 'local') this.#registry.cooldown(provider.id, cooldownFor(err), err.message);
          lastError = err;

          // 出力開始後の切替は文章を壊すので、ここで打ち切る。
          if (emitted) {
            yield { type: 'failed', error: err };
            return;
          }
          /*
           * **地元の口の「時間切れ」は、やり直さない。**
           *
           * 雲なら、時間切れは向こうの混み具合で、少し待てば通る。
           * この機械の中の口では、時間切れは**この機械が遅い**という意味で、
           * 同じことをもう一度頼めば同じだけ待つ。しかも子は前の依頼を
           * まだ抱えていて、やり直しはその後ろに並ぶ。3 回並んで 3 回落ちた。
           */
          const retries = provider.locality === 'local' && err.kind === 'timeout' ? 0 : err.rule.retries;
          if (!err.rule.fallback && attempt >= retries) {
            yield { type: 'failed', error: err };
            return;
          }
          if (attempt < retries) {
            const wait = err.retryAfterMs ?? 500 * 2 ** attempt;
            const limit = isLast || !err.rule.fallback ? MAX_LAST_RETRY_WAIT_MS : MAX_RETRY_WAIT_MS;
            if (wait > limit) {
              // 長く待てと言われた。次の候補があれば待たずにそちらへ。無ければ、言われた長さを添えて落ちたと言う
              if (isLast || !err.rule.fallback) {
                yield {
                  type: 'failed',
                  error: new ProviderError({
                    kind: err.kind, providerId: err.providerId,
                    message: `${err.message}（${Math.ceil(wait / 1000)} 秒待つよう言われたので、待たずにやめました）`,
                  }),
                };
                return;
              }
              break;
            }
            attempt += 1;
            await sleep(wait, signal);
            continue;
          }
          break; // 次の候補モデルへ
        }
      }
      previousModelId = modelId;
    }

    yield {
      type: 'failed',
      error: lastError ?? new ProviderError({
        kind: 'unavailable', providerId: '-',
        message: 'すべての候補モデルが失敗しました。',
      }),
    };
  }
}

/** 言われた待ちを冷やしの上限に使う長さ（これより長い Retry-After は一日で区切る。壊れた値で何日も口を塞がない）。 */
const MAX_COOLDOWN_MS = 24 * 60 * 60_000;

/**
 * 外の口を冷やす長さ。種類ごとの長さと、相手が言った待ち（Retry-After）の長い方。
 * 種類ごとの長さだけで決めていたので、1 時間待てと言われても 1 分後にまた送り、断られては切り替えていた。
 * 冷やさない種類（長すぎる依頼・モデルが無い）は、言われても冷やさない。
 */
export function cooldownFor(err: ProviderError): number {
  const base = err.rule.cooldownMs;
  if (base <= 0 || err.retryAfterMs === undefined) return base;
  return Math.max(base, Math.min(err.retryAfterMs, MAX_COOLDOWN_MS));
}

/**
 * 使える候補が無いときの文。冷やしている候補があれば、どれが・あとどれだけ・何で、を言う。
 * 「未登録または冷却中」とだけ言っていたので、Retry-After で長く冷やしている間は、送るたびに理由も残り時間も無く即座に終わっていた。
 * 冷やしは手元の記憶にしか無いので、立ち上げ直せば解ける（鍵や上限を直したときの抜け道）。
 */
function noUsableMessage(registry: ProviderRegistry, candidates: readonly string[]): string {
  const cooled: string[] = [];
  const seen = new Set<string>();
  for (const id of candidates) {
    const r = registry.resolve(id);
    if (!r || seen.has(r.provider.id) || registry.isAvailable(r.provider.id)) continue;
    seen.add(r.provider.id);
    const left = registry.cooldownRemainingMs(r.provider.id);
    const reason = registry.cooldownReason(r.provider.id);
    cooled.push(`${r.provider.id}: ${describeLeft(left)}${reason ? `（${reason.slice(0, 200)}）` : ''}`);
  }
  if (cooled.length === 0) return '利用できるモデルがありません（候補のどれも登録されていません）。';
  return `利用できるモデルがありません。失敗のあと休ませている候補: ${cooled.join(' / ')}。`
    + '鍵や上限を直したときは、立ち上げ直すと休ませているのが解けます。';
}

function describeLeft(ms: number): string {
  if (ms === Infinity) return '手で解くまで';
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `あと ${minutes} 分`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `あと ${hours} 時間${rest > 0 ? ` ${rest} 分` : ''}`;
}
