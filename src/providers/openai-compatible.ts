/**
 * OpenAI互換アダプタ。
 *
 * baseUrl を差し替えるだけで Ollama / LM Studio / vLLM / llama.cpp-server、
 * および将来のOpenAI互換サービスへ接続できる。
 * 「特定サービスの終了に依存しない」ことの実体的な担保がこれ。
 */
import { PRIORITY_HEADER } from './contract.ts';
import type {
  ChatProvider, HealthStatus, ModelDescriptor,
  ProviderChunk, ProviderMessage, ProviderRequest, ToolCall,
} from './contract.ts';
import {
  ProviderError, kindFromHttpStatus, kindFromThrown, parseRetryAfter,
} from './errors.ts';
import { readSseLines } from './sse.ts';
import { describeNet } from '../runtime/net-why.ts';
import { connect } from 'node:net';

export interface OpenAiCompatibleOptions {
  id: string;
  baseUrl: string;
  apiKey?: string;
  locality: 'local' | 'cloud';
  /** APIがモデル一覧を返さない場合のフォールバック */
  fallbackModels?: string[];
  /**
   * 接続〜最初の1トークンまでの上限。既定10分。
   * 巨大モデルのロードやディスクからの読み出しに数分かかることがあるため長い。
   */
  firstTokenTimeoutMs?: number;
  /**
   * **繋がるまでの上限。既定10秒。**
   *
   * 上の10分と分ける。10分は「モデルが最初の1トークンを返すまで」の猶予で、
   * **繋がらない相手を待つための時間ではない。**
   *
   * 分けていなかったので、動いていない ollama を叩いたとき、1回の試行が
   * 10分待たされた。`unavailable` は 2 回まで再試行するので 1 候補で 30 分、
   * 候補が 2 つで **62 分**。画面には failed 1847.6秒 と出た。
   * 応答のない相手に対して、Windows は長く待つ（拒否が返らない）。
   *
   * 返事の頭（ヘッダ）さえ来れば、そこから先は上の10分に切り替える。
   * 繋がってさえいれば、遅いモデルはいくらでも待つ。
   */
  connectTimeoutMs?: number;
  /**
   * トークンが1つも来ない状態が続いたときの上限。既定2分。
   *
   * 総時間ではなく「停滞時間」で打ち切るのが要点。
   * 1トークン/秒でも生成が進んでいる限り、何時間でも待つ。
   */
  stallTimeoutMs?: number;
  /**
   * **黙っているが生きている、を許す上限。既定10分。**
   *
   * 最初のトークンより前は、届いたバイト（`: queued` / `: working`）で待ちを
   * 延ばしていた。**後ろでは延ばしていなかった。**ツールの呼び出しを組んでいる間は
   * 本文が一文字も出ないので、遅い機械ではそこで黙る。Windows のランナーで
   * 本物の重みを読ませたとき、足し算は通り、ツールを渡した回だけ
   * 「120秒 応答しませんでした（停滞）」で落ちた。**動いていたのに落としている。**
   *
   * だから最初のトークンの後も、届いたバイトで待ちを延ばす。ただし
   * **合図だけで永久には延ばさない。**本文かツールの欠片が最後に来てから
   * ここを超えたら、合図が来ていても停滞と言う（死んでいる相手を待ち続けない）。
   */
  quietCeilingMs?: number;
  /**
   * **モデル一覧と生存確認の上限。既定2秒。**
   *
   * 生成の上限と分ける。ここは相手が居るかを見るだけで、返るものは
   * 小さい。5秒で固定していたので、繋ぎ先が黙って落とす形（LAN の
   * 向こう、塞がれた口）だと `Session.create` が毎回5秒止まり、
   * **最初の送信がそのぶん待たされた。**拒否が返る相手なら即返る。
   */
  listTimeoutMs?: number;
}

export class OpenAiCompatibleProvider implements ChatProvider {
  readonly id: string;
  readonly locality: 'local' | 'cloud';
  readonly #baseUrl: string;
  readonly #apiKey?: string;
  readonly #fallbackModels: string[];
  readonly #firstTokenTimeoutMs: number;
  readonly #connectTimeoutMs: number;
  readonly #stallTimeoutMs: number;
  readonly #quietCeilingMs: number;
  readonly #listTimeoutMs: number;

  constructor(opts: OpenAiCompatibleOptions) {
    this.id = opts.id;
    this.locality = opts.locality;
    this.#baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.#apiKey = opts.apiKey;
    this.#fallbackModels = opts.fallbackModels ?? [];
    this.#firstTokenTimeoutMs = opts.firstTokenTimeoutMs ?? 600_000;
    this.#connectTimeoutMs = opts.connectTimeoutMs ?? 10_000;
    this.#stallTimeoutMs = opts.stallTimeoutMs ?? 120_000;
    this.#quietCeilingMs = opts.quietCeilingMs ?? 600_000;
    this.#listTimeoutMs = opts.listTimeoutMs ?? 2_000;
  }

  #headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (this.#apiKey) h.authorization = `Bearer ${this.#apiKey}`;
    return h;
  }

  async health(): Promise<HealthStatus> {
    try {
      const res = await fetch(`${this.#baseUrl}/models`, {
        headers: this.#headers(),
        signal: AbortSignal.timeout(this.#listTimeoutMs),
      });
      if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
      return { ok: true };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return { ok: false, reason };
    }
  }

  async listModels(): Promise<ModelDescriptor[]> {
    const toDescriptor = (model: string, verified: boolean): ModelDescriptor => ({
      id: `${this.id}:${model}`,
      providerId: this.id,
      model,
      displayName: model,
      locality: this.locality,
      verified,
    });
    /*
     * **一覧が取れなかったことを、取れたことにしない。**
     *
     * ここは設定に書いてある名前をそのまま返していた。返ってきた側からは
     * 相手が「在る」と言ったのか、こちらが書いておいただけなのかが
     * 区別できない。**書いてあるだけの名前が「入っている」ことになる。**
     *
     * 実際にそうなった。既定の設定にあった Ollama 向けの2つが画面に候補
     * として並び、送るたびに存在しない相手を叩いていた。しかもその名前は
     * 世代ごと古くなるので、**放っておくと必ずそうなる。**
     *
     * 控えは残す（`/v1/models` を持たない相手が居る）。ただし
     * `verified: false` を付けて、確かめていないことを持ち回らせる。
     */
    const guessed = (): ModelDescriptor[] => this.#fallbackModels.map((m) => toDescriptor(m, false));

    try {
      const res = await fetch(`${this.#baseUrl}/models`, {
        headers: this.#headers(),
        signal: AbortSignal.timeout(this.#listTimeoutMs),
      });
      if (!res.ok) return guessed();
      const json = (await res.json()) as { data?: Array<{ id?: unknown }> };
      const ids = (json.data ?? [])
        .map((m) => m.id)
        .filter((v): v is string => typeof v === 'string');
      if (ids.length === 0) return guessed();
      return ids.map((m) => toDescriptor(m, true));
    } catch {
      // 一覧が取れないことは致命的ではない。設定値で続行する。ただし黙らない。
      return guessed();
    }
  }

  async *chat(req: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderChunk> {
    const wire = req.messages.map(toWireMessage);
    const messages = req.system
      ? [{ role: 'system', content: req.system }, ...wire]
      : wire;

    // 総時間ではなく「停滞」で打ち切る。低速環境でも生成が進む限り待ち続ける。
    const watchdog = new AbortController();
    let stalled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => { stalled = true; watchdog.abort(); }, ms);
    };
    /*
     * **繋がるまでは短く待つ。**繋がってから、最初の1トークンまでを長く待つ。
     *
     * 地元の口（Ollama・llama-server）は、**最初のトークンが出るまでヘッダを返さない。**
     * ヘッダまでを 10 秒で見切ると、モデルの読み込みと入力の読み取りが 10 秒を超えた
     * 時点で「接続に失敗」になる（地元の時間切れはやり直さないので、そのまま落ちる）。
     * 地元は「繋がるか」だけを先に短く見て、繋がったらヘッダを長く待つ。
     */
    const local = this.locality === 'local';
    if (local) await this.#reach(signal);
    arm(local ? this.#firstTokenTimeoutMs : this.#connectTimeoutMs);

    const combined = AbortSignal.any([signal, watchdog.signal]);

    let res: Response;
    try {
      res = await fetch(`${this.#baseUrl}/chat/completions`, {
        method: 'POST',
        // 優先度はヘッダで運ぶ。本文に足すと、知らない項目を断る相手が居る。
        headers: {
          ...this.#headers(),
          ...(req.priority !== undefined ? { [PRIORITY_HEADER]: String(req.priority) } : {}),
        },
        signal: combined,
        body: JSON.stringify({
          model: req.model,
          messages,
          stream: true,
          stream_options: { include_usage: true },
          temperature: req.temperature,
          max_tokens: req.maxTokens,
          ...(req.tools && req.tools.length > 0
            ? {
                tools: req.tools.map((t) => ({
                  type: 'function',
                  function: { name: t.name, description: t.description, parameters: t.parameters },
                })),
                tool_choice: 'auto',
              }
            : {}),
        }),
      });
    } catch (e) {
      clearTimeout(timer);
      // 中断が「利用者の Ctrl-C」か「停滞による打ち切り」かを区別する
      const kind = signal.aborted ? 'canceled' : stalled ? 'timeout' : kindFromThrown(e);
      throw new ProviderError({
        kind, providerId: this.id, cause: e,
        message: `${this.id} への接続に失敗しました: ${describe(e)}`,
      });
    }

    /*
     * ここまで来たら、繋がっている。**ここから先は長く待つ。**
     * 返事の頭（ヘッダ）は来たので、あとはモデルが最初の1トークンを
     * 返すまでの話。巨大なモデルの読み込みで数分かかることがある。
     */
    arm(this.#firstTokenTimeoutMs);

    if (!res.ok || !res.body) {
      // 本文を読む間も見張る（つなぐときと同じ長さ）。相手が失敗の頭だけ返して本文を止めると、ここで何分も待っていた
      arm(this.#connectTimeoutMs);
      const body = await res.text().catch(() => '');
      clearTimeout(timer);
      throw new ProviderError({
        kind: kindFromHttpStatus(res.status, body),
        providerId: this.id,
        retryAfterMs: parseRetryAfter(res.headers.get('retry-after')),
        message: `${this.id} が HTTP ${res.status} を返しました: ${truncate(body)}`,
      });
    }

    let finishReason: 'stop' | 'length' | 'toolCalls' | 'unknown' = 'unknown';
    // 終わりの合図（[DONE] か finish_reason）を受け取ったか。**受け取らずに流れが閉じたら、途中で切れた。**
    let ended = false;
    // ツール呼び出しは複数チャンクに分割して届く。index ごとに組み立てる。
    const pending = new Map<number, { id: string; name: string; args: string }>();
    // **並んでいる間は停滞ではない。**inproc は口が空くのを待つ間 `: queued` を打ち続け、
    // 借りたら `: started` を流す。注釈行は data ではないので下の読みには出ないが、
    // 最初のトークンが来るまでは、届いたバイトそのものを「生きている」合図として待ちを延ばす。
    // 来なければ、これまでどおり 10 分で落とす。
    let firstToken = false;
    const firstTokenTimeoutMs = this.#firstTokenTimeoutMs;
    /*
     * **最初のトークンの後も、届いたバイトを生きている合図として数える。**
     *
     * 数えていなかったので、ツールの呼び出しを組んでいる間（本文が一文字も
     * 出ない間）に黙ると停滞と判定した。Windows のランナーで本物の重みを
     * 読ませたとき、足し算は通り、ツールを渡した回だけそこで落ちた。
     *
     * ただし**合図だけで永久には延ばさない。**本文かツールの欠片が最後に来てから
     * `quietCeilingMs` を超えたら、合図が来ていても停滞にする。
     */
    const stallTimeoutMs = this.#stallTimeoutMs;
    const quietCeilingMs = this.#quietCeilingMs;
    let lastDeltaAt = Date.now();
    const alive = res.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(bytes, controller) {
        if (!firstToken) arm(firstTokenTimeoutMs);
        else if (Date.now() - lastDeltaAt < quietCeilingMs) arm(stallTimeoutMs);
        controller.enqueue(bytes);
      },
    }));
    try {
      for await (const data of readSseLines(alive)) {
        if (data === '[DONE]') { ended = true; break; }
        if (!data) continue;

        let parsed: OpenAiStreamChunk;
        try {
          parsed = JSON.parse(data) as OpenAiStreamChunk;
        } catch {
          continue; // 壊れた1行でストリーム全体を落とさない
        }

        // 流れの途中の失敗（`data: {"error": ...}`）を読み飛ばさない。読み飛ばすと、途中までの文が完了になる
        if (parsed.error !== undefined && parsed.error !== null) {
          throw new ProviderError({
            kind: 'unavailable', providerId: this.id,
            message: `${this.id} の生成が途中で落ちました: ${truncate(errorText(parsed.error))}`,
          });
        }
        const choice = parsed.choices?.[0];
        const delta = choice?.delta?.content;
        // **落ちたものを、成功として通さない。**中で読む口は、生成が落ちたときに 'error' で終える。同じ塊に失敗の文が本文として
        // 載ってくるので、本文として流す前に見る（流すと上の層が「書き始めた」と数え、やり直しも次の候補への切り替えもしなかった）
        if (choice?.finish_reason === 'error') {
          throw new ProviderError({
            kind: 'unavailable', providerId: this.id,
            message: `${this.id} の生成が途中で落ちました${typeof delta === 'string' && delta.trim() ? `: ${truncate(delta.trim())}` : ''}`,
          });
        }
        if (typeof delta === 'string' && delta.length > 0) {
          firstToken = true;
          lastDeltaAt = Date.now();
          arm(this.#stallTimeoutMs); // 生成が進んでいるので待ち直す
          yield { type: 'text', delta };
        }
        for (const tc of choice?.delta?.tool_calls ?? []) {
          // 番号（index）を付けない相手もいる。そのときは、別の id が来たら新しい呼び出しとして分ける
          // （全部を 0 番に入れていたので、二件目が一件目に繋がり `read_fileread_file` や `{..}{..}` になっていた）
          let idx = tc.index;
          if (idx === undefined) {
            const last = pending.size > 0 ? Math.max(...pending.keys()) : -1;
            const open = pending.get(last);
            idx = last < 0 ? 0 : (tc.id && open?.id && open.id !== tc.id ? last + 1 : last);
          }
          const slot = pending.get(idx) ?? { id: '', name: '', args: '' };
          if (tc.id) slot.id = tc.id;
          // 名前を欠片ごとに丸ごと付けてくる相手もいる。同じ名前を二度足さない
          if (tc.function?.name && slot.name !== tc.function.name) slot.name += tc.function.name;
          if (tc.function?.arguments) slot.args += tc.function.arguments;
          pending.set(idx, slot);
          firstToken = true;
          lastDeltaAt = Date.now();
          arm(this.#stallTimeoutMs);
        }

        if (typeof choice?.finish_reason === 'string') ended = true;
        if (choice?.finish_reason === 'stop') finishReason = 'stop';
        else if (choice?.finish_reason === 'length') finishReason = 'length';
        else if (choice?.finish_reason === 'tool_calls') finishReason = 'toolCalls';

        if (parsed.usage) {
          yield {
            type: 'usage',
            inputTokens: parsed.usage.prompt_tokens ?? 0,
            outputTokens: parsed.usage.completion_tokens ?? 0,
          };
        }
      }
      // **終わりの合図が無いまま閉じたものを、言い終えたことにしない。**
      // 止めたとき（signal）は下の done が canceled を言うので、ここでは見ない。
      if (!ended && !signal.aborted) {
        throw new ProviderError({
          kind: 'unavailable', providerId: this.id,
          message: `${this.id} の返事が、終わりの合図の無いまま切れました`,
        });
      }
    } catch (e) {
      if (e instanceof ProviderError && !signal.aborted && !stalled) throw e;
      const kind = signal.aborted ? 'canceled' : stalled ? 'timeout' : kindFromThrown(e);
      throw new ProviderError({
        kind, providerId: this.id, cause: e,
        message: stalled
          ? `${this.id} が ${this.#stallTimeoutMs / 1000}秒 応答しませんでした（停滞）`
          : `${this.id} のストリームが中断されました: ${describe(e)}`,
      });
    } finally {
      clearTimeout(timer);
    }

    for (const [idx, slot] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
      yield {
        type: 'toolCall',
        call: {
          id: slot.id || `call_${idx}`,
          name: slot.name,
          args: parseArgs(slot.args),
        },
      };
      if (finishReason === 'unknown') finishReason = 'toolCalls';
    }

    yield { type: 'done', finishReason: signal.aborted ? 'canceled' : finishReason };
  }

  /**
   * 繋がるかだけを見る（何も送らない）。繋がらなければ、繋がらないと言って投げる。
   * 待つのは `connectTimeoutMs` まで。応えない相手（塞がれた口）を長く待たない。
   */
  async #reach(signal: AbortSignal): Promise<void> {
    const url = new URL(this.#baseUrl);
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const why = await new Promise<Error | 'timeout' | 'canceled' | undefined>((done) => {
      const socket = connect({ host, port });
      const finish = (v: Error | 'timeout' | 'canceled' | undefined) => {
        clearTimeout(timer); signal.removeEventListener('abort', onAbort); socket.destroy(); done(v);
      };
      const onAbort = () => finish('canceled');
      const timer = setTimeout(() => finish('timeout'), this.#connectTimeoutMs);
      socket.once('connect', () => finish(undefined));
      socket.once('error', (e) => finish(e));
      if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
    });
    if (why === undefined) return;
    throw new ProviderError({
      kind: why === 'canceled' ? 'canceled' : why === 'timeout' ? 'timeout' : kindFromThrown(why),
      providerId: this.id, ...(why instanceof Error ? { cause: why } : {}),
      message: `${this.id} への接続に失敗しました: ${why === 'timeout'
        ? `${this.#connectTimeoutMs / 1000}秒 待っても繋がりません` : why === 'canceled' ? '中断されました' : describe(why)}`,
    });
  }
}

/** 流れの途中で返ってきた失敗の中身を、文にする（`{message}` でも文字でも）。 */
function errorText(error: unknown): string {
  if (typeof error === 'string') return error;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' ? message : JSON.stringify(error);
}

/** 中立形式から OpenAI 形式へ。ツール結果の表現だけが違う。 */
function toWireMessage(m: ProviderMessage): Record<string, unknown> {
  if (m.role === 'tool') {
    return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
  }
  if (m.toolCalls && m.toolCalls.length > 0) {
    return {
      role: m.role,
      content: m.content || null,
      tool_calls: m.toolCalls.map((t: ToolCall) => ({
        id: t.id,
        type: 'function',
        function: { name: t.name, arguments: JSON.stringify(t.args) },
      })),
    };
  }
  return { role: m.role, content: m.content };
}

/**
 * 引数のJSONが壊れていても落とさない。
 * ローカルの小型モデルは不正なJSONを出すことがあるため、
 * ここでは生文字列を残し、実行側で検証・エラー返却させる。
 */
function parseArgs(raw: string): unknown {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { __raw: raw, __parseError: true };
  }
}

interface OpenAiStreamChunk {
  choices?: Array<{
    delta?: {
      content?: unknown;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  /** 流れの途中の失敗（Ollama・llama-server などが data 行で返すことがある） */
  error?: unknown;
}

/**
 * 失敗の理由を、人の言葉で言う。
 *
 * ここは `e.message` をそのまま出していた。実機の画面に
 * 「inproc のストリームが中断されました: **terminated**（62 秒）」と出て、
 * 打った人には何が起きたのかも、次に何をすればいいのかも分からない
 * （`terminated` は undici が本文を切ったときの語）。
 *
 * 言い換える所は既に在る（`describeNet`）。取ってくる側・llama-server・Ollama は
 * そこを通していて、**ここだけ通していなかった。**
 * 言い換えられないものは、そのままの文が返る（隠さない）。
 */
function describe(e: unknown): string {
  return describeNet(e);
}

function truncate(s: string, max = 200): string {
  return s.length > max ? `${s.slice(0, max)}...` : s;
}
