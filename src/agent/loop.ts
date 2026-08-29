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
import type { Tool, ToolContext, ApprovalRequest } from './tools/types.ts';

export type AgentEvent =
  | { type: 'thinking'; delta: string }
  | { type: 'toolStart'; call: ToolCall }
  | { type: 'toolEnd'; call: ToolCall; result: string; isError: boolean }
  | { type: 'turn'; index: number; modelId?: string }
  | { type: 'fallback'; from: string; to: string; reason: string }
  | { type: 'finished'; reason: 'completed' | 'maxTurns' | 'noProgress' | 'aborted' | 'failed'; detail?: string };

export interface AgentOptions {
  candidates: string[];
  system: string;
  tools: Tool[];
  root: string;
  /** 上限。到達しても失敗ではなく、利用者に継続を尋ねるための区切り。 */
  maxTurns?: number;
  temperature?: number;
  maxTokens?: number;
  approve(req: ApprovalRequest): Promise<boolean>;
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
    const ctx: ToolContext = {
      root: this.#opts.root,
      signal,
      approve: this.#opts.approve,
    };

    // 同じツールを同じ引数で繰り返すのは、モデルが行き詰まった兆候。
    const recentCalls: string[] = [];

    for (let turn = 0; turn < maxTurns; turn += 1) {
      if (signal.aborted) { yield { type: 'finished', reason: 'aborted' }; return; }

      let text = '';
      const calls: ToolCall[] = [];
      let modelId: string | undefined;
      let failure: string | undefined;

      for await (const ev of this.#orchestrator.run(
        {
          candidates: this.#opts.candidates,
          system: this.#opts.system,
          messages: history,
          temperature: this.#opts.temperature,
          maxTokens: this.#opts.maxTokens,
          tools: this.#opts.tools.map((t) => t.schema),
        },
        signal,
      ) as AsyncGenerator<ChatEvent>) {
        if (ev.type === 'text') { text += ev.delta; yield { type: 'thinking', delta: ev.delta }; }
        else if (ev.type === 'toolCall') calls.push(ev.call);
        else if (ev.type === 'fallback') yield { type: 'fallback', from: ev.from, to: ev.to, reason: ev.reason };
        else if (ev.type === 'done') modelId = ev.modelId;
        else if (ev.type === 'failed') failure = `${ev.error.kind}: ${ev.error.message}`;
      }

      if (failure) { yield { type: 'finished', reason: 'failed', detail: failure }; return; }
      yield { type: 'turn', index: turn, modelId };

      history.push({
        role: 'assistant',
        content: text,
        ...(calls.length > 0 ? { toolCalls: calls } : {}),
      });

      // ツールを呼ばなかった = 作業が終わったか、質問して止まった
      if (calls.length === 0) { yield { type: 'finished', reason: 'completed' }; return; }

      for (const call of calls) {
        if (signal.aborted) { yield { type: 'finished', reason: 'aborted' }; return; }
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
