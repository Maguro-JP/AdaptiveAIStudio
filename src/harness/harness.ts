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

  /**
   * 同じ規則で、履歴だけを別に持つものを作る。
   *
   * **並列に走らせるときは、依頼ごとに分ける。**一つを使い回すと、規則が
   * 見る積み重ねが混ざる。読んでから書く規則は**別の担当が読んだこと**で
   * 通ってしまい、広がりを抑える規則は**他人の書き込みまで数えて**止める。
   * `beginTask()` で切る形は、並列では使えない（誰かの始まりが、走っている
   * 他の担当の履歴まで消す）。
   *
   * 記録（audit）と測り（metrics）は分けない。そこは全体で一つ。
   */
  forTask(): Harness {
    return new Harness({
      rules: this.#rules,
      audit: this.#audit,
      ...(this.#metrics ? { metrics: this.#metrics } : {}),
      ...(this.#onDecision ? { onDecision: this.#onDecision } : {}),
    });
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
        // 会話ごとの入れ物が渡されていれば、そちらの積み重ねと依頼文で判じる（別の会話の読み書きを数えない）。
        const history = toolCtx.request?.history ?? this.#history;
        // 規則の数え（metrics）は依頼の札で分ける。並行する会話の拒否を、別の依頼の結末に結び付けない。
        const metricsKey = toolCtx.request?.metricsKey() ?? '';
        const metrics = this.#metrics;
        const ctx: RuleContext = {
          root: toolCtx.root,
          history,
          instruction: toolCtx.request ? toolCtx.request.instruction() : instruction(),
          ...(toolCtx.request ? { forum: toolCtx.request.forum } : {}),
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
            metrics?.recordDenial(rule.name, metricsKey);
            this.#onDecision?.({ tool: call.name, outcome: 'denied', rule: rule.name, reason: decision.reason });
            // 例外にせず、モデルが読める形で返す。考え直させるのが目的。
            return { content: `BLOCKED by ${rule.name}: ${decision.reason}`, isError: true };
          }
          if (decision.kind === 'warn') {
            await this.#audit.record({
              tool: call.name, outcome: 'warned', rule: rule.name, reason: decision.note,
            });
            metrics?.recordWarning(rule.name);
            this.#onDecision?.({ tool: call.name, outcome: 'warned', rule: rule.name, reason: decision.note });
          }
        }

        const result = await tool.run(args, toolCtx);
        history.push(call);

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

/**
 * 記録に残す要約。**全文は残さない。**
 *
 * `url` を見ていなかったので、**外へ出るときだけ記録が空**だった。
 * ファイルを読めば道が残り、命令を走らせれば命令が残るのに、
 * 外へ出た先だけ何も残らない。後から「どこへ出たのか」を辿れない。
 *
 * ただし、URL はそのまま残さない。`?token=…` のように、**問い合わせの
 * 部分に合言葉が入る**ことがある。記録そのものが漏れ口になっては元も子もない。
 * 残すのは「どこへ」（宛先と道）だけで、問い合わせと合言葉は落とす。
 * 落としたことは書く（黙って削らない）。
 */
function summarize(args: Record<string, unknown>): string {
  if (typeof args.url === 'string') return whereTo(args.url);
  const key = ['path', 'command', 'query'].find((k) => typeof args[k] === 'string');
  return key ? String(args[key]).slice(0, 120) : '';
}

/** 宛先と道だけにする。読めない形なら、印だけ残して中身は残さない。 */
function whereTo(url: string): string {
  try {
    const at = new URL(url);
    const hidden: string[] = [];
    if (at.search) hidden.push('問い合わせ');
    if (at.username || at.password) hidden.push('合言葉');
    const where = `${at.protocol}//${at.host}${at.pathname}`.slice(0, 120);
    return hidden.length > 0 ? `${where}（${hidden.join('と')}は記録しません）` : where;
  } catch {
    return '（読めない URL）';
  }
}
