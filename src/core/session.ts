/**
 * 対話の核 — 入口から切り離した本体。
 *
 * これまで対話の手順は CLI の中に書かれていた。
 * 動きはするが、画面から同じことをしようとすると、
 * 同じ手順をもう一度書くことになる。書けば必ずずれる。
 *
 * だから核を外に出す。入口（CLI・画面・その先の何か）は
 * 出来事を受け取って見せるだけにして、何が起きるかはここだけが決める。
 *
 * 承認もここでは決めない。呼ぶ側に訊く。
 * 端末なら「y/N」、画面なら押しボタンになるが、
 * **訊かずに進めない**という一点だけは、ここが守る。
 */
import { resolve, join } from 'node:path';
import type { AasConfig } from '../config.ts';
import { buildRegistry } from './build.ts';
import { ChatOrchestrator } from './orchestrator.ts';
import { setupAutopilot, resolveCandidates, stateDir, type AutopilotBundle } from './autopilot-setup.ts';
import { buildHarness } from './harness-setup.ts';
import { Agent } from '../agent/loop.ts';
import { readFileTool, listFilesTool, searchTextTool, writeFileTool } from '../agent/tools/fs.ts';
import { createRunCommandTool } from '../agent/tools/shell.ts';
import { createFetchUrlTool } from '../agent/tools/network.ts';
import { Prefetcher, describeSnapshot } from '../agent/prefetch.ts';
import { Memory, formatRecall } from '../memory/memory.ts';
import { RoleRegistry } from '../roles/registry.ts';
import type { Tool, ApprovalRequest } from '../agent/tools/types.ts';
import type { ProviderMessage } from '../providers/contract.ts';

export const DEFAULT_SYSTEM = `あなたはソフトウェア開発の作業者です。与えられた作業ディレクトリで実際に手を動かします。

守ること:
- 推測でファイルを書かない。まず read_file / list_files / search_text で現状を確認する。
- write_file には必ずファイルの全内容を渡す。一部だけ渡すと残りが消える。
- 変更したら run_command でテストやビルドを実行し、結果を確認する。
- 作業が終わったら、何をしたかを簡潔に日本語で報告する。ツールは呼ばない。
- 分からないことは推測せず、質問して止まる。

時間はいくらかかっても構わない。正確さを優先すること。`;

export type SessionEvent =
  | { type: 'text'; delta: string }
  | { type: 'toolStart'; name: string; summary: string }
  | { type: 'toolEnd'; name: string; ok: boolean; summary: string }
  | { type: 'fallback'; from: string; to: string; reason: string }
  | { type: 'recalled'; text: string }
  | { type: 'finished'; reason: string; detail?: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; text: string };

export interface SessionOptions {
  /** 承認の訊き方。入口ごとに違う。 */
  approve(req: ApprovalRequest): Promise<boolean>;
  /** 画面や端末へ流したいもの。省略可。 */
  onLog?(level: 'info' | 'warn' | 'error', text: string): void;
}

export class Session {
  readonly config: AasConfig;
  readonly root: string;
  readonly candidates: string[];
  readonly memory: Memory;
  readonly roles: RoleRegistry;
  readonly orchestrator: ChatOrchestrator;
  readonly pilot: AutopilotBundle;

  readonly #tools: Tool[];
  readonly #opts: SessionOptions;
  readonly #prefetch: Prefetcher;
  /** ハーネスの規則へ「いま何を頼まれているか」を渡すための箱。 */
  readonly #holder: { instruction: string };
  readonly #history: ProviderMessage[] = [];
  #running?: AbortController;
  #instruction = '';

  private constructor(init: {
    config: AasConfig; root: string; candidates: string[];
    memory: Memory; roles: RoleRegistry; orchestrator: ChatOrchestrator;
    pilot: AutopilotBundle; tools: Tool[]; prefetch: Prefetcher; opts: SessionOptions;
    holder: { instruction: string };
  }) {
    this.config = init.config;
    this.root = init.root;
    this.candidates = init.candidates;
    this.memory = init.memory;
    this.roles = init.roles;
    this.orchestrator = init.orchestrator;
    this.pilot = init.pilot;
    this.#tools = init.tools;
    this.#prefetch = init.prefetch;
    this.#opts = init.opts;
    this.#holder = init.holder;
  }

  static async create(config: AasConfig, opts: SessionOptions): Promise<Session> {
    const agentCfg = config.agent ?? {};
    const root = resolve(agentCfg.root ?? process.cwd());

    const registry = buildRegistry(config);
    const orchestrator = new ChatOrchestrator(registry);
    const pilot = await setupAutopilot(config, registry);
    const { candidates, note } = resolveCandidates(config, pilot);
    if (candidates.length === 0) throw new Error(`使えるモデルがありません: ${note}`);

    const log = (level: 'info' | 'warn' | 'error', text: string) => opts.onLog?.(level, text);

    // ハーネス。守らせるのではなく、実行させないことで守る。
    const holder = { instruction: '' };
    const harness = await buildHarness(config, (d) => {
      if (d.outcome === 'denied') log('error', `⛔ ${d.rule}: ${d.reason ?? ''}`);
      else if (d.outcome === 'warned') log('warn', `⚠ ${d.rule}: ${d.reason ?? ''}`);
    });

    const netCfg = config.network ?? {};
    const raw: Tool[] = [
      readFileTool, listFilesTool, searchTextTool, writeFileTool,
      createRunCommandTool({ allowed: agentCfg.allowedCommands }),
      ...(netCfg.enabled === false ? [] : [createFetchUrlTool({
        allowedHosts: netCfg.allowedHosts, maxBytes: netCfg.maxBytes, timeoutMs: netCfg.timeoutMs,
      })]),
    ];

    const prefetch = new Prefetcher(root, () => undefined);
    prefetch.start();

    const memory = new Memory(join(stateDir(), 'memory.jsonl'));
    await memory.load();

    const session = new Session({
      config, root, candidates, memory,
      roles: new RoleRegistry(config.roles ?? []),
      orchestrator, pilot, prefetch, opts, holder,
      tools: harness.wrapAll(raw, () => holder.instruction),
    });
    return session;
  }

  get busy(): boolean { return this.#running !== undefined; }

  /** いま動いているものを止める。止めても対話は続く。 */
  abort(): void { this.#running?.abort(); }

  /** 指示を受けて、起きたことを順に返す。 */
  async *send(instruction: string): AsyncGenerator<SessionEvent> {
    if (this.#running) {
      yield { type: 'log', level: 'warn', text: 'いま別の作業をしています。' };
      return;
    }
    const ac = new AbortController();
    this.#running = ac;
    this.#instruction = instruction;
    this.#holder.instruction = instruction;

    try {
      // 関係することを思い出して添える。無関係なら何も足さない。
      const recalled = this.#recall(instruction);
      if (recalled) yield { type: 'recalled', text: recalled };

      this.#history.push({
        role: 'user',
        content: recalled ? `${instruction}\n\n---\n${recalled}` : instruction,
      });

      const agent = new Agent(this.orchestrator, {
        candidates: this.candidates,
        system: await this.#system(),
        tools: this.#tools,
        root: this.root,
        maxTurns: this.config.agent?.maxTurns ?? 40,
        temperature: this.config.temperature,
        maxTokens: this.config.maxTokens,
        approve: this.#opts.approve,
      });

      for await (const ev of agent.run(this.#history, ac.signal)) {
        switch (ev.type) {
          case 'thinking':
            yield { type: 'text', delta: ev.delta };
            break;
          case 'toolStart':
            yield { type: 'toolStart', name: ev.call.name, summary: summarize(ev.call.args) };
            break;
          case 'toolEnd':
            if (!ev.isError && ev.call.name === 'write_file') this.#prefetch.invalidate();
            yield {
              type: 'toolEnd', name: ev.call.name, ok: !ev.isError,
              summary: firstLine(ev.result),
            };
            break;
          case 'fallback':
            yield { type: 'fallback', from: ev.from, to: ev.to, reason: ev.reason };
            break;
          case 'finished':
            yield { type: 'finished', reason: ev.reason, detail: ev.detail };
            break;
        }
      }
    } catch (e) {
      // 一度の失敗で対話ごと終わらせない。次の指示は受けられる。
      yield { type: 'log', level: 'error', text: (e as Error).message };
      yield { type: 'finished', reason: 'failed', detail: (e as Error).message };
    } finally {
      this.#running = undefined;
      await this.memory.save().catch(() => undefined);
    }
  }

  #recall(text: string): string {
    const related = this.memory.recall(text, { limit: 6 });
    const failed = this.memory.failedBefore(text, 2);
    const merged = [...related];
    for (const f of failed) if (!merged.some((e) => e.id === f.id)) merged.push(f);
    return formatRecall(merged);
  }

  /** 依頼のたびに、その時点で分かっている状況を渡す。調べ直させるより速い。 */
  async #system(): Promise<string> {
    const base = this.config.system ?? DEFAULT_SYSTEM;
    const snap = await this.#prefetch.snapshotWithin(3000);
    const brief = snap ? describeSnapshot(snap) : '';
    return brief ? `${base}\n\n${brief}` : base;
  }

  get instruction(): string { return this.#instruction; }

  async close(): Promise<void> {
    this.abort();
    this.memory.compact();
    await this.memory.save().catch(() => undefined);
  }
}

function summarize(args: unknown): string {
  if (typeof args !== 'object' || args === null) return '';
  const o = args as Record<string, unknown>;
  const key = ['path', 'command', 'query', 'url'].find((k) => typeof o[k] === 'string');
  return key ? String(o[key]).slice(0, 100) : '';
}

function firstLine(text: string): string {
  return (text.split('\n')[0] ?? '').slice(0, 160);
}
