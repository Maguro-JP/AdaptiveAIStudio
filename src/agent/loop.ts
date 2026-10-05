/**
 * ツール実行ループ — 作業者(worker)の本体。
 *
 * モデルがツールを呼ぶ → 実行する → 結果を返す → モデルが続きを考える、
 * を目的達成まで繰り返す。P1 の中核。
 *
 * 「何時間かかっても自律的に進める」ため、
 * 打ち切りは時間ではなく「進捗が無いこと」で判断する。
 */
import type { Priority } from '../providers/contract.ts';
import type { ProviderMessage, ToolCall } from '../providers/contract.ts';
import type { ChatOrchestrator, ChatEvent } from '../core/orchestrator.ts';
import type { Tool, ToolContext, ApprovalRequest, ApprovalAnswer, RequestScope } from './tools/types.ts';
import { ToolTextFilter } from './tool-text.ts';
import { DoneMark, DONE_MARK } from './done.ts';
import { fitToWindow, historyBudget, estimateTokens, trimSchemas, TOOL_SHARE, type Count } from './window.ts';

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
  /**
   * 口を借りる優先度。作る側が決めて渡す（本番の会話は最優先、役職は既定の中）。
   * 同じ Agent を本番と裏の両方が使うので、ここに決め打ちしない。
   */
  priority?: Priority;
  approve(req: ApprovalRequest): Promise<ApprovalAnswer>;
  /** 書き込む直前の控え。**戻せるようにするため**、書く道具から呼ばれる。 */
  beforeWrite?(relPath: string, previous: string | Buffer | undefined): void;
  /** 書けたときの、実際に書いた分の差分。画面の札をこれで描く。 */
  wrote?(relPath: string, diff: string, created: boolean): void;
  /** 依頼ごとの入れ物（会話ごとの規則の履歴・依頼文・協議）。ツールへそのまま渡す。 */
  request?: RequestScope;
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
    /*
     * **狭いコンテキストウィンドウでは、ツールの説明を一文に削る。**説明だけで 1400 トークン
     * あり、4k のコンテキストウィンドウでは 34% を占める。決まりと学びを足すと、
     * 肝心の依頼と履歴の場所が残らない。広いコンテキストウィンドウでは削らない。
     *
     * **取り分はここに書かない。**ここは 0.15 を明に渡していた。
     * `window.ts` は「0.15 では一文に切っても入らず、説明が丸ごと落ちて
     * 呼び分けができなくなる」と書いて `TOOL_SHARE` を 0.25 に直したのに、
     * **本番で `trimSchemas` を呼ぶのはここ一箇所だけ**なので、直した側は
     * 誰からも読まれていなかった。本番のツール13個・既定の
     * コンテキストウィンドウ 8192 で測ると、0.15 では 13 個すべての説明が
     * 落ちる（run_command の許可コマンドの一覧も、fetch_url の許可先も、
     * edit_file の使い方も届かない）。
     * 数は `window.ts` に一つだけ置く。
     */
    const tools = trimSchemas(
      this.#opts.tools.map((t) => t.schema), this.#opts.contextTokens ?? 8192, TOOL_SHARE,
      this.#opts.count,
    );
    // 履歴の取り分は、実際に送るシステムプロンプトとツールの説明のかさを引いて決める（引かずに足すとコンテキストウィンドウを超えていた）
    const measure = this.#opts.count ?? estimateTokens;
    const budget = historyBudget(
      this.#opts.contextTokens ?? 8192, measure(this.#opts.system) + measure(JSON.stringify(tools)),
    );
    const ctx: ToolContext = {
      root: this.#opts.root,
      signal,
      approve: this.#opts.approve,
      ...(this.#opts.beforeWrite ? { beforeWrite: this.#opts.beforeWrite } : {}),
      ...(this.#opts.wrote ? { wrote: this.#opts.wrote } : {}),
      ...(this.#opts.request ? { request: this.#opts.request } : {}),
      // 道具の返しも窓に収める。読んだ時点で収めないと、刈る段では
      // 中身がほとんど残らない（直近の結果は 1200 字まで削られる）。
      ...(this.#opts.contextTokens !== undefined ? { contextTokens: this.#opts.contextTokens } : {}),
      // 返す長さは、履歴の取り分から決める（コンテキストウィンドウから決めると、取り分より大きな結果を返していた）
      ...(this.#opts.contextTokens !== undefined ? { historyTokens: budget } : {}),
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
      // 出力の上限で切れたか（言い終えていない）。切れた返事を「答え終えた」と読まない。
      let cutOff = false;
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
          ...(this.#opts.priority !== undefined ? { priority: this.#opts.priority } : {}),
          tools,
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
        else if (ev.type === 'done') { modelId = ev.modelId; cutOff = ev.finishReason === 'length'; }
        else if (ev.type === 'failed') failure = `${ev.error.kind}: ${ev.error.message}（${elapsedSec()} 秒）`;
      }

      // せき止めた分の始末。呼び出しが拾えたなら道具として扱い、
      // 拾えなければ本文としてそのまま見せる（黙って消さない）。
      if (calls.length > 0) {
        const rest = mark.push(filter.drain());
        if (rest) { text += rest; yield { type: 'thinking', delta: rest }; }
      } else {
        const salvage = filter.end((name) => this.#tools.has(name));
        if (salvage.calls.length > 0) mark.newLine();
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

      if (failure) {
        // 利用者がもう見た文は残す（止めたときと同じ。残さないと、次の指示が落ちた指示と一つに繋がる）。呼び出しは載せない（結果が無い）
        if (text.trim()) history.push({ role: 'assistant', content: text });
        yield { type: 'finished', reason: 'failed', detail: failure }; return;
      }
      /*
       * 返事の途中で止められた。相手は止められると黙って終わるので、ここで見ないと、途中までの文を普通の返事として
       * 「完了」にし、ツールを使った後なら「まだ TASK_DONE がありません」を記録に積んでいた。
       */
      if (signal.aborted) {
        // 利用者がもう見た途中までの文は残す（残さないと、次の指示が止めた指示と一つに繋がり、止めた作業をやり直させる）
        if (text.trim()) history.push({ role: 'assistant', content: text });
        yield { type: 'finished', reason: 'aborted' }; return;
      }
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
        /*
         * **出力の上限で切れた返事を、答え終えたことにしない。**ツールを使っていない返事は、ここで「完了」になる。
         * 切れたまま完了と出すと、利用者は途中までの答えを答えだと思う。続きを求め、求められないなら切れたと言う。
         */
        if (cutOff && !declaredDone) {
          if (nudges >= maxNudges) {
            yield {
              type: 'finished', reason: 'noProgress',
              detail: maxNudges === 0
                ? '返事が出力の上限で切れました（続きは求めていません。押し戻しは切ってあります）。'
                : `返事が出力の上限で切れました（${nudges} 回続きを求めましたが、言い終えませんでした）。`,
            };
            return;
          }
          nudges += 1;
          yield { type: 'nudged', left: maxNudges - nudges };
          history.push({
            role: 'user',
            nudge: true,
            content: '返事が出力の上限で切れています。切れたところから続きを書いてください。'
              + '書き直さず、続きだけを、短くまとめて書いてください。',
          });
          continue;
        }
        if (declaredDone || !usedTools || nudges >= maxNudges) {
          // 合図が出た / 一度も道具を使っていない（＝答えただけ） /
          // 押し戻しを使い切った。**動かないものは、動かないと言う。**
          const stalled = !declaredDone && usedTools;
          yield {
            type: 'finished',
            reason: stalled ? 'noProgress' : 'completed',
            ...(stalled
              ? {
                // 押し戻しを切ってあるときに「0 回押し戻しましたが、動きませんでした」と
                // 言っていた。押し戻していないのだから嘘になる（本物の重みで確かめた回に
                // 実際に出た）。**やっていないことを、やったと書かない。**
                detail: maxNudges === 0
                  ? `${DONE_MARK} が無いまま手を止めました（押し戻しは切ってあります）。`
                  : `${DONE_MARK} が無いまま ${nudges} 回押し戻しましたが、動きませんでした。`,
              }
              : {}),
          };
          return;
        }
        nudges += 1;
        yield { type: 'nudged', left: maxNudges - nudges };
        // 押し戻す。**次の一手を求める。**「続けて」だけでは、また同じ返事が来る。
        history.push({
          role: 'user',
          nudge: true,
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

      for (const [at, call] of calls.entries()) {
        if (signal.aborted) {
          // 呼んだのに結果の無いツールを残さない（残すと、以後の依頼を相手が 400 で断り、この会話が続けられなくなる）
          for (const left of calls.slice(at)) history.push({ role: 'tool', toolCallId: left.id, content: 'ERROR: 中断されました（実行していません）' });
          yield { type: 'finished', reason: 'aborted' }; return;
        }
        if (call.id.startsWith('salvaged-')) yield { type: 'salvaged', name: call.name };
        yield { type: 'toolStart', call };

        const tool = this.#tools.get(call.name);
        let result: string;
        let isError = false;

        if (!tool) {
          result = `ERROR: 未知のツールです: ${call.name}（利用可能: ${[...this.#tools.keys()].join(', ')}）`;
          isError = true;
        } else if (isRecord(call.args) && call.args.__parseError === true) {
          // 上限で切れて壊れたなら、同じ大きさで呼び直しても同じところで切れる。
          result = cutOff
            ? 'ERROR: 出力の上限で、引数のJSONが途中で切れました。一度に書く量を減らし（小さく分けて）呼び直してください。'
            : 'ERROR: 引数のJSONが壊れています。正しいJSONで呼び直してください。';
          isError = true;
        } else if (!isRecord(call.args)) {
          // 物でない引数（文字列に二重に包んだ JSON など）で `{}` として動かすと、「path が必要です」になり、本当の誤りが届かなかった
          result = 'ERROR: 引数はJSONのオブジェクト（{ ... }）で渡してください。文字列に包まず、そのまま渡して呼び直してください。';
          isError = true;
        } else {
          // ツールが投げても、結果の無い呼び出しを残さない（残すと、以後の依頼を相手が 400 で断る）
          try {
            const r = await tool.run(call.args, ctx);
            result = r.content;
            isError = r.isError === true;
          } catch (e) {
            result = `ERROR: ツールが落ちました: ${e instanceof Error ? e.message : String(e)}`;
            isError = true;
          }
        }

        yield { type: 'toolEnd', call, result, isError };
        history.push({ role: 'tool', toolCallId: call.id, content: result });
      }
      // 最後のツールの最中に止めた。ここで見ないと、同じ手の繰り返しや回数切れで終わったことにしていた
      if (signal.aborted) { yield { type: 'finished', reason: 'aborted' }; return; }

      // 進捗判定: 同じ手を繰り返していたら、堂々巡りとみなす。
      const signature = calls.map((c) => `${c.name}:${JSON.stringify(c.args)}`).join('|');
      recentCalls.push(signature);
      if (recentCalls.length > CYCLE_WINDOW) recentCalls.shift();
      const period = cyclePeriod(recentCalls);
      if (period !== undefined) {
        yield {
          type: 'finished', reason: 'noProgress',
          detail: period === 1
            ? `同じ操作を3回繰り返しました: ${calls.map((c) => c.name).join(', ')}`
            : `${period} 手で同じところを回っています: ${calls.map((c) => c.name).join(', ')}`,
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

/** 周期を見るのに覚えておく手の数。3 手周期を 2 周ぶん見るので 6。 */
export const CYCLE_WINDOW = 6;

/**
 * 同じところを回っているか。回っていれば、その周期を返す。
 *
 * **1 手の繰り返しだけを見ていた。**直近 3 回が同じ呼び出しなら止める形で、
 * `read_file(a)` を延々と繰り返す形は捕まる。けれど
 * **`read_file(a)` → `search_text(x)` → `read_file(a)` → … は一度も捕まらない。**
 * 引数まで同じ 2 手を往復しているので、返ってくるものも毎回同じで、進んでいない。
 * それでも ターンの上限（既定 40）まで回り続ける。**一番よく見る行き詰まりの形が、
 * 素通りしていた。**
 *
 * 1 手なら 3 回、2 手以上なら 2 周ぶんで止める。引数ごと同じ手が並んでいる
 * ことを見るので、同じツールで別のファイルを触る形は当たらない。
 */
export function cyclePeriod(recent: readonly string[]): number | undefined {
  // 1 手の繰り返しは 3 回で止める（ここは今までと同じ）。
  if (recent.length >= 3) {
    const last3 = recent.slice(-3);
    if (new Set(last3).size === 1) return 1;
  }
  for (let p = 2; p <= Math.floor(CYCLE_WINDOW / 2); p += 1) {
    if (recent.length < p * 2) continue;
    const block = recent.slice(-p);
    const before = recent.slice(-p * 2, -p);
    // 塊の中が全部同じなら、それは 1 手の繰り返し（上で見ている）。
    if (new Set(block).size < 2) continue;
    if (block.every((sig, i) => sig === before[i])) return p;
  }
  return undefined;
}
