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
import { type Rule, type RuleContext, hasArg } from './rules.ts';
import { AuditLog } from './audit.ts';
import { fingerprint, markSeen, lastPrint, markFailedWrite } from './seen.ts';
import type { HarnessMetrics } from './metrics.ts';

export interface HarnessOptions {
  rules: Rule[];
  audit?: AuditLog;
  /** ハーネス自身の効き具合を測る。良い規則と邪魔な規則を見分けるため。 */
  metrics?: HarnessMetrics;
  onDecision?: (e: HarnessDecision) => void;
  /**
   * 依頼全体の呼び出し（担当ごとに分けた包みで共有する）。依頼の入れ物（`request`）を渡さない呼び手（端末の `aas team`）でも、
   * 数を数える規則が依頼全体で数えられるようにする。無ければ担当ごとの履歴で数える。
   */
  taskHistory?: ToolCall[];
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
  readonly #taskHistory?: ToolCall[];

  constructor(opts: HarnessOptions) {
    this.#rules = opts.rules;
    this.#audit = opts.audit ?? new AuditLog();
    this.#metrics = opts.metrics;
    this.#onDecision = opts.onDecision;
    this.#taskHistory = opts.taskHistory;
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
  forTask(taskHistory?: ToolCall[]): Harness {
    return new Harness({
      rules: this.#rules,
      audit: this.#audit,
      ...(taskHistory ? { taskHistory } : {}),
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
        const taskHistory = toolCtx.request?.taskHistory ?? this.#taskHistory;
        const ctx: RuleContext = {
          root: toolCtx.root,
          history,
          ...(taskHistory ? { taskHistory } : {}),
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

        // 中身を見る・替えるツールは、実行の前の指紋も取る（後の指紋を「見た中身」として記録してよいかを決める。下の記録の所）
        const seenPath = (call.name === 'read_file' || call.name === 'write_file' || call.name === 'edit_file')
          ? (args as Record<string, unknown>)?.['path'] : undefined;
        const printBefore = typeof seenPath === 'string' && call.name !== 'write_file' ? await fingerprint(toolCtx.root, seenPath) : undefined;
        const result = await tool.run(args, toolCtx);
        /*
         * 読めなかった read_file は「読んだ」に数えない（数えると、無かったファイルや読めなかったファイルを丸ごと書き換えさせる。
         * readBeforeWrite は結果を見られないので、積む側で分ける）。ただし次の二つは、中身を見たのと同じ扱いにする。
         * - 二進と言われた: 何のファイルかは分かっている。全文の置き換えを止めない（前からの決め）
         * - 大きすぎて断られた: 「一部を読んだ」として残す。read_file は大きいファイルを必ず断るので、残さないと edit_file でも
         *   二度と直せない。一部の扱いなので、全文を置き換える write_file は止まる
         */
        const keep = (c: ToolCall): void => { history.push(c); if (taskHistory && taskHistory !== history) taskHistory.push(c); };
        if (!(result.isError && call.name === 'read_file')) {
          keep(call);
          // やり直しを求めた失敗（待つ間に変わった・掴まれていた）は、同じ内容の繰り返しに数えない。断られた・当たらなかったは数え続ける
          if (result.isError && RETRYABLE_WRITE.test(result.content)) markFailedWrite(call);
        } else if (result.content.includes('は二進のファイルなので読めません')) keep(call);
        else if (result.content.includes('ファイルが大きすぎます')) {
          keep({ ...call, args: { ...(args as Record<string, unknown>), limit: 0 } });
        }
        /*
         * 読めた・書けた直後の中身の指紋を記録する。全文を書く前に、読んだ後で誰かが替えていないかを比べる（`./seen.ts`）。
         * 全文を見た・書いたのでなければ、新しい指紋は「見た中身」ではない。一部だけの読みと edit_file は、実行の前の中身が
         * 最後に記録した指紋と同じとき（その間に誰も替えていないとき）だけ記録する。そうしないと、読み直す代わりに一部を読む・
         * 自分で一か所を直すだけで、他の変更を含んだ指紋が「見た」ことになり、その変更を古い中身で書き戻せる。
         * 全文の読みも、前と後が同じときだけ記録する（読んでいる間に替わったら、どちらの中身を見たか分からない）。
         */
        if (!result.isError && typeof seenPath === 'string') {
          const printAfter = await fingerprint(toolCtx.root, seenPath);
          const partial = call.name === 'read_file' && (hasArg(call, 'offset') || hasArg(call, 'limit'));
          const trusted = call.name === 'write_file'
            || (call.name === 'read_file' && !partial ? printBefore === printAfter
              : printBefore !== undefined && printBefore === lastPrint(history.filter((c) => c !== call), toolCtx.root, seenPath));
          if (printAfter !== undefined && trusted) markSeen(call, printAfter);
        }

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
/** 書き込みの失敗のうち、同じ引数で出し直すのが正しいもの（待つ間に変わった・読めなくなった・一時的に掴まれていた）。 */
const RETRYABLE_WRITE = /待っているあいだに|EBUSY|EPERM|EAGAIN|ETXTBSY/;

function summarize(args: Record<string, unknown>): string {
  if (typeof args.url === 'string') return whereTo(args.url);
  const key = ['path', 'command', 'query'].find((k) => typeof args[k] === 'string');
  // 切るのは記録の側で、伏せた後（ここで切ると、切れ目の後ろにある `@` やトークンの頭が切れ、伏せられずに残る）
  return key ? String(args[key]).slice(0, 4000) : '';
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
