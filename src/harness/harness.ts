/**
 * ハーネス — ツールと規則の間に立ち、実行を制御する。
 *
 * モデルは誤った選択をする。だから「正しく選んでくれること」に賭けず、
 * 誤った選択が**実行に至らない**ようにする。
 *
 * ツール自体は規則を知らない。規則はツールを知らない。
 * 両者を繋ぐのはここだけなので、ツールを増やしても規則は書き直さずに済む。
 */
import type { ToolCall } from '../providers/contract.ts';
import type { Tool, ToolContext, ToolResult } from '../agent/tools/types.ts';
import type { Rule, RuleContext } from './rules.ts';
import { AuditLog } from './audit.ts';
import type { HarnessMetrics } from './metrics.ts';

export interface HarnessOptions {
  rules: Rule[];
  audit?: AuditLog;
  /** ハーネス自身の効き具合を測る。良い規則と邪魔な規則を見分けるため。 */
  metrics?: HarnessMetrics;
  onDecision?: (e: HarnessDecision) => void;
}

export interface HarnessDecision {
  tool: string;
  outcome: 'allowed' | 'denied' | 'warned' | 'violation' | 'injected';
  rule?: string;
  reason?: string;
}

export class Harness {
  readonly #rules: Rule[];
  readonly #audit: AuditLog;
  readonly #metrics?: HarnessMetrics;
  readonly #onDecision?: (e: HarnessDecision) => void;
  #history: ToolCall[] = [];

  constructor(opts: HarnessOptions) {
    this.#rules = opts.rules;
    this.#audit = opts.audit ?? new AuditLog();
    this.#metrics = opts.metrics;
    this.#onDecision = opts.onDecision;
  }

  get audit(): AuditLog {
    return this.#audit;
  }

  get metrics(): HarnessMetrics | undefined {
    return this.#metrics;
  }

  /** 依頼ごとに履歴を切る。規則は1つの依頼の中での積み重ねを見るため。 */
  beginTask(): void {
    this.#history = [];
    this.#metrics?.beginTask();
  }

  /** 依頼の結末を伝える。拒否が誘導になったのか邪魔になったのかがここで決まる。 */
  endTask(outcome: 'completed' | 'failed'): void {
    this.#metrics?.endTask(outcome);
  }

  rules(): Array<{ name: string; description: string }> {
    return this.#rules.map((r) => ({ name: r.name, description: r.description }));
  }

  /**
   * ツールを規則で包む。
   * 呼び出し側（Agent）はこれを普通のツールとして扱えばよい。
   */
  wrap(tool: Tool, instruction: () => string): Tool {
    return {
      schema: tool.schema,
      run: async (args, toolCtx: ToolContext): Promise<ToolResult> => {
        const call: ToolCall = { id: '', name: tool.schema.name, args };
        const ctx: RuleContext = {
          root: toolCtx.root,
          history: this.#history,
          instruction: instruction(),
          signal: toolCtx.signal,
        };

        // 実行前の判定
        for (const rule of this.#rules) {
          if (!rule.pre) continue;
          const decision = await rule.pre(call, ctx);
          if (decision.kind === 'deny') {
            await this.#audit.record({
              tool: call.name, outcome: 'denied',
              rule: rule.name, reason: decision.reason, summary: summarize(args),
            });
            this.#metrics?.recordDenial(rule.name);
            this.#onDecision?.({ tool: call.name, outcome: 'denied', rule: rule.name, reason: decision.reason });
            // 例外にせず、モデルが読める形で返す。考え直させるのが目的。
            return { content: `BLOCKED by ${rule.name}: ${decision.reason}`, isError: true };
          }
          if (decision.kind === 'warn') {
            await this.#audit.record({
              tool: call.name, outcome: 'warned', rule: rule.name, reason: decision.note,
            });
            this.#metrics?.recordWarning(rule.name);
            this.#onDecision?.({ tool: call.name, outcome: 'warned', rule: rule.name, reason: decision.note });
          }
        }

        const result = await tool.run(args, toolCtx);
        this.#history.push(call);

        // 実行後の判定
        let content = result.content;
        for (const rule of this.#rules) {
          if (!rule.post) continue;
          const decision = await rule.post(call, content, ctx);
          if (decision.kind === 'inject') {
            content += `\n\n[${rule.name}] ${decision.note}`;
            this.#onDecision?.({ tool: call.name, outcome: 'injected', rule: rule.name });
          } else if (decision.kind === 'violation') {
            await this.#audit.record({
              tool: call.name, outcome: 'violation', rule: rule.name, reason: decision.reason,
            });
            this.#onDecision?.({ tool: call.name, outcome: 'violation', rule: rule.name, reason: decision.reason });
            return { content: `VIOLATION by ${rule.name}: ${decision.reason}\n${content}`, isError: true };
          }
        }

        if (!result.isError) {
          await this.#audit.record({ tool: call.name, outcome: 'allowed', summary: summarize(args) });
        }
        return { ...result, content };
      },
    };
  }

  wrapAll(tools: Tool[], instruction: () => string): Tool[] {
    return tools.map((t) => this.wrap(t, instruction));
  }
}

function summarize(args: Record<string, unknown>): string {
  const key = ['path', 'command', 'query'].find((k) => typeof args[k] === 'string');
  return key ? String(args[key]).slice(0, 120) : '';
}
