/**
 * ツール実行ループ — 作業者(worker)の本体。
 *
 * モデルがツールを呼ぶ → 実行する → 結果を返す → モデルが続きを考える、
 * を目的達成まで繰り返す。P1 の中核。
 *
 * 「何時間かかっても自律的に進める」ため、
 * 打ち切りは時間ではなく「進捗が無いこと」で判断する。
 */
import type { ProviderMessage, ToolCall } from '../providers/contract.ts';
import type { ChatOrchestrator, ChatEvent } from '../core/orchestrator.ts';
import type { Tool, ToolContext, ApprovalRequest, ApprovalAnswer } from './tools/types.ts';
import { ToolTextFilter } from './tool-text.ts';
import { DoneMark, DONE_MARK } from './done.ts';
import { fitToWindow, tokenBudget, trimSchemas, type Count } from './window.ts';

export type AgentEvent =
  | { type: 'thinking'; delta: string }
  | { type: 'toolStart'; call: ToolCall }
  /** 本文に紛れていた呼び出しを拾ったとき。黙って直すと原因が追えない。 */
  | { type: 'salvaged'; name: string }
  /** 合図が無いまま手を止めたので、押し戻した。黙って押し戻さない。 */
  | { type: 'nudged'; left: number }
  /** 文脈に収まらないので、古い分を減らした。**黙って落とさない。** */
  | { type: 'trimmed'; dropped: number }
  | { type: 'toolEnd'; call: ToolCall; result: string; isError: boolean }
  | { type: 'turn'; index: number; modelId?: string }
  | { type: 'fallback'; from: string; to: string; reason: string }
  /** 同じモデルにやり直した。黙ってやり直すと、落ちるまでの秒数の内訳が追えない。 */
  | { type: 'retry'; attempt: number; modelId: string; elapsedMs: number }
  | { type: 'finished'; reason: 'completed' | 'maxTurns' | 'noProgress' | 'aborted' | 'failed'; detail?: string };

export interface AgentOptions {
  candidates: string[];
  system: string;
  tools: Tool[];
  root: string;
  /** 上限。到達しても失敗ではなく、利用者に継続を尋ねるための区切り。 */
  maxTurns?: number;
  /**
   * 文脈の窓（トークン）。既定 8192（ローカルの既定と同じ）。
   *
   * 履歴がここに収まらないとき、**こちらで決めて刈る**。刈らないと
   * ライブラリが古い方から黙って落とし、最初の依頼ごと消える。
   */
  contextTokens?: number;
  /**
   * トークンの数え方。**そのモデルの本物の数え方**が分かっていれば渡す。
   * 無ければ見積もりに戻る（外のモデルには GGUF が無い）。
   */
  count?: Count;
  /**
   * 合図なしで手を止めたとき、何回まで押し戻すか。既定2回。
   *
   * 0 にすると、これまでどおり「道具を呼ばなかった＝終わった」になる。
   * 押し戻しは只ではない（一往復ぶん余計に考えさせる）ので、
   * 何度も繰り返さない。**動かないものは、動かないと言う。**
   */
  maxNudges?: number;
  temperature?: number;
  maxTokens?: number;
  approve(req: ApprovalRequest): Promise<ApprovalAnswer>;
  /** 書き込む直前の控え。**戻せるようにするため**、書く道具から呼ばれる。 */
  beforeWrite?(relPath: string, previous: string | undefined): void;
}

export class Agent {
  readonly #orchestrator: ChatOrchestrator;
  readonly #opts: AgentOptions;
  readonly #tools: Map<string, Tool>;

  constructor(orchestrator: ChatOrchestrator, opts: AgentOptions) {
    this.#orchestrator = orchestrator;
    this.#opts = opts;
    this.#tools = new Map(opts.tools.map((t) => [t.schema.name, t]));
  }

  async *run(
    history: ProviderMessage[],
    signal: AbortSignal,
  ): AsyncGenerator<AgentEvent> {
    const maxTurns = this.#opts.maxTurns ?? 40;
    const maxNudges = this.#opts.maxNudges ?? 2;
    let nudges = 0;
    /**
     * この依頼のあいだに、道具を一度でも使ったか。
     *
     * 押し戻す相手を、これで絞る。**一度も道具を使っていないなら、
     * それは訊かれて答えただけ**（「この関数は何ですか」）。答えが仕事なので、
     * 押し戻しても意味がなく、往復を二度増やすだけになる。
     * 道具を使った後で止まったなら、**作業の途中で降りた**可能性が高い。
     * 自律で回らなくなるのは、いつもそこ。
     */
    let usedTools = false;
    const budget = tokenBudget(this.#opts.contextTokens ?? 8192);
    const ctx: ToolContext = {
      root: this.#opts.root,
      signal,
      approve: this.#opts.approve,
      ...(this.#opts.beforeWrite ? { beforeWrite: this.#opts.beforeWrite } : {}),
      // 道具の返しも窓に収める。読んだ時点で収めないと、刈る段では
      // 中身がほとんど残らない（直近の結果は 1200 字まで削られる）。
      ...(this.#opts.contextTokens !== undefined ? { contextTokens: this.#opts.contextTokens } : {}),
      ...(this.#opts.count ? { count: this.#opts.count } : {}),
    };

    // 同じツールを同じ引数で繰り返すのは、モデルが行き詰まった兆候。
    const recentCalls: string[] = [];

    for (let turn = 0; turn < maxTurns; turn += 1) {
      if (signal.aborted) { yield { type: 'finished', reason: 'aborted' }; return; }

      let text = '';
      const calls: ToolCall[] = [];
      let modelId: string | undefined;
      let failure: string | undefined;
      // 小さいモデルは、呼び出しを本文に書いてしまうことがある。
      // 生の JSON を画面へ流さないよう、疑わしいところで一旦せき止める。
      const filter = new ToolTextFilter();
      // 終わりの合図を、本文から抜く。画面に TASK_DONE を出さない。
      const mark = new DoneMark();

      const fitted = fitToWindow(history, budget, this.#opts.count);
      if (fitted.trimmed) yield { type: 'trimmed', dropped: fitted.dropped };

      // 落ちたときに「何秒目で、何回目か」を言えるように。
      // 337 秒で落ちたと言われても、内訳が無いと切り分けられない。
      const began = Date.now();
      const elapsedSec = () => Math.round((Date.now() - began) / 1000);
      for await (const ev of this.#orchestrator.run(
        {
          candidates: this.#opts.candidates,
          system: this.#opts.system,
          // **窓に収まる分だけ送る。元は変えない。**
          // 元を刈ると、残してある会話まで欠ける。
          messages: fitted.messages,
          temperature: this.#opts.temperature,
          maxTokens: this.#opts.maxTokens,
          // **狭い窓では、道具の説明を一文に削る。**説明だけで 1400 トークン
          // あり、4k の窓では 34% を占める。決まりと学びを足すと、
          // 肝心の依頼と履歴の場所が残らない。広い窓では削らない。
          tools: trimSchemas(
            this.#opts.tools.map((t) => t.schema), this.#opts.contextTokens ?? 8192, 0.15,
            this.#opts.count,
          ),
        },
        signal,
      ) as AsyncGenerator<ChatEvent>) {
        if (ev.type === 'text') {
          const passed = filter.push(ev.delta);
          if (passed) {
            const shown = mark.push(passed);
            if (shown) { text += shown; yield { type: 'thinking', delta: shown }; }
          }
        }
        else if (ev.type === 'toolCall') calls.push(ev.call);
        else if (ev.type === 'fallback') yield { type: 'fallback', from: ev.from, to: ev.to, reason: ev.reason };
        else if (ev.type === 'attempt' && ev.attempt > 0) {
          yield { type: 'retry', attempt: ev.attempt, modelId: ev.modelId, elapsedMs: Date.now() - began };
        }
        else if (ev.type === 'done') modelId = ev.modelId;
        else if (ev.type === 'failed') failure = `${ev.error.kind}: ${ev.error.message}（${elapsedSec()} 秒）`;
      }

      // せき止めた分の始末。呼び出しが拾えたなら道具として扱い、
      // 拾えなければ本文としてそのまま見せる（黙って消さない）。
      if (calls.length > 0) {
        const rest = mark.push(filter.drain());
        if (rest) { text += rest; yield { type: 'thinking', delta: rest }; }
      } else {
        const salvage = filter.end();
        const passed = mark.push(salvage.text);
        if (passed) { text += passed; yield { type: 'thinking', delta: passed }; }
        salvage.calls.forEach((c, i) => {
          calls.push({ id: `salvaged-${turn}-${i}`, name: c.name, args: c.args });
        });
      }

      // 抱えている分を吐き出す。ここで合図が確定する。
      const tail = mark.end();
      if (tail.text) { text += tail.text; yield { type: 'thinking', delta: tail.text }; }
      const declaredDone = tail.done;

      if (failure) { yield { type: 'finished', reason: 'failed', detail: failure }; return; }
      yield { type: 'turn', index: turn, modelId };

      history.push({
        role: 'assistant',
        content: text,
        ...(calls.length > 0 ? { toolCalls: calls } : {}),
      });

      // 道具を呼ばずに止まった。**それだけでは「終わった」ではない。**
      // 小さいモデルは作業の途中で手を止める。「次に書き換えます」と
      // 言って返してくる。それを完了と読んでいたので、何もしていないのに
      // 完了と出ていた。自律で回し続けられなかったのは、ここで降りていたから。
      if (calls.length === 0) {
        // **何も返していないのに「完了」と言わない。**
        // 考えごとだけで予算を使い切ると、本文が空のまま止まる。
        // それを完了と出していた（実機で 18 分かけて出力 0 の「完了」）。
        if (text.trim() === '' && !declaredDone) {
          yield { type: 'finished', reason: 'noProgress', detail: '返事が空でした（モデルが本文を書かずに止まりました）' };
          return;
        }
        if (declaredDone || !usedTools || nudges >= maxNudges) {
          // 合図が出た / 一度も道具を使っていない（＝答えただけ） /
          // 押し戻しを使い切った。**動かないものは、動かないと言う。**
          const stalled = !declaredDone && usedTools;
          yield {
            type: 'finished',
            reason: stalled ? 'noProgress' : 'completed',
            ...(stalled
              ? { detail: `${DONE_MARK} が無いまま ${nudges} 回押し戻しましたが、動きませんでした。` }
              : {}),
          };
          return;
        }
        nudges += 1;
        yield { type: 'nudged', left: maxNudges - nudges };
        // 押し戻す。**次の一手を求める。**「続けて」だけでは、また同じ返事が来る。
        history.push({
          role: 'user',
          content:
            `まだ ${DONE_MARK} がありません。\n`
            + `やり終えているなら、${DONE_MARK} だけの行を書いてください。\n`
            + '終わっていないなら、説明ではなく、次の一手を道具で実行してください。',
        });
        continue;
      }

      // 何か動いたので、押し戻しの残りを戻す。長い作業の途中で
      // 使い切ってしまうと、そこから先が押し戻せない。
      nudges = 0;
      usedTools = true;

      for (const call of calls) {
        if (signal.aborted) { yield { type: 'finished', reason: 'aborted' }; return; }
        if (call.id.startsWith('salvaged-')) yield { type: 'salvaged', name: call.name };
        yield { type: 'toolStart', call };

        const tool = this.#tools.get(call.name);
        let result: string;
        let isError = false;

        if (!tool) {
          result = `ERROR: 未知のツールです: ${call.name}（利用可能: ${[...this.#tools.keys()].join(', ')}）`;
          isError = true;
        } else if (isRecord(call.args) && call.args.__parseError === true) {
          result = 'ERROR: 引数のJSONが壊れています。正しいJSONで呼び直してください。';
          isError = true;
        } else {
          const r = await tool.run(isRecord(call.args) ? call.args : {}, ctx);
          result = r.content;
          isError = r.isError === true;
        }

        yield { type: 'toolEnd', call, result, isError };
        history.push({ role: 'tool', toolCallId: call.id, content: result });
      }

      // 進捗判定: 直近3回が同一の呼び出しなら、堂々巡りとみなす
      const signature = calls.map((c) => `${c.name}:${JSON.stringify(c.args)}`).join('|');
      recentCalls.push(signature);
      if (recentCalls.length > 3) recentCalls.shift();
      if (recentCalls.length === 3 && new Set(recentCalls).size === 1) {
        yield {
          type: 'finished', reason: 'noProgress',
          detail: `同じ操作を3回繰り返しました: ${calls.map((c) => c.name).join(', ')}`,
        };
        return;
      }
    }

    yield { type: 'finished', reason: 'maxTurns', detail: `${maxTurns}ターンに到達しました。` };
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
