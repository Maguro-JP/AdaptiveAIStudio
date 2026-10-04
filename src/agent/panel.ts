/**
 * 合議 — 気質の違う担当を同じ対象に同時に当てる。
 *
 * 一人の優秀な検査役より、真面目な人・意地の悪い人・疑い深い人を
 * 並べた方が広く拾える。人と同じで、見えているものが違うため。
 *
 * ローカルは計算が無料なので、人数を増やす代償がほとんど無い。
 * クラウドでは人数分だけ課金されるので、これは局所的な優位になる。
 */
import type { ProviderMessage } from '../providers/contract.ts';
import type { ChatOrchestrator } from '../core/orchestrator.ts';
import { Agent } from './loop.ts';
import { parseProposal } from './initiative.ts';
import type { Tool } from './tools/types.ts';
import type { Role } from '../roles/role.ts';
import { buildSystemPrompt } from '../roles/role.ts';
import { toolsFor } from '../roles/registry.ts';

export interface PanelFinding {
  roleId: string;
  roleName: string;
  title: string;
  rationale: string;
  action: string;
}

export type PanelEvent =
  | { type: 'assigned'; roleId: string; roleName: string }
  | { type: 'noFinding'; roleId: string; roleName: string }
  | { type: 'found'; finding: PanelFinding }
  | { type: 'failed'; roleId: string; error: string };

export interface PanelOptions {
  roles: Role[];
  candidates: string[];
  root: string;
  toolPool: { read: Tool[]; write: Tool[]; execute: Tool[] };
  maxTurns?: number;
  temperature?: number;
  maxTokens?: number;
  /** 同時に走らせる人数。VRAMではなくレーンの並列度に合わせる。 */
  parallel?: number;
}

/**
 * 対象について、各担当に同時に見てもらう。
 *
 * 一人が失敗しても他は続ける。全員の合意は取らない。
 * 気質が違う以上、見解が割れるのは正常であり、
 * 割れたことも含めて利用者に見せる方が有益。
 */
export async function* runPanel(
  orchestrator: ChatOrchestrator,
  target: string,
  opts: PanelOptions,
  signal: AbortSignal,
): AsyncGenerator<PanelEvent, PanelFinding[]> {
  const findings: PanelFinding[] = [];
  // 数でない並べる数（設定の NaN）は既定に倒す（Math.max(1, NaN) は NaN で、誰も走らずに所見なしで終わっていた）
  const parallel = Number.isFinite(opts.parallel) ? Math.max(1, Math.floor(opts.parallel!)) : 2;

  const inbox: PanelEvent[] = [];
  let wake: (() => void) | undefined;
  const push = (e: PanelEvent) => { inbox.push(e); wake?.(); wake = undefined; };

  const runOne = async (role: Role): Promise<void> => {
    push({ type: 'assigned', roleId: role.id, roleName: role.name });

    const agent = new Agent(orchestrator, {
      candidates: opts.candidates,
      system: buildSystemPrompt(role),
      tools: toolsFor(role, opts.toolPool),
      root: opts.root,
      maxTurns: opts.maxTurns ?? 10,
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
      // 合議は調べるだけ。承認を求める場面が来たら断る。
      approve: async () => false,
    });

    let text = '';
    let ended: string | undefined;
    const history: ProviderMessage[] = [{ role: 'user', content: target }];
    try {
      for await (const ev of agent.run(history, signal)) {
        if (ev.type === 'thinking') text += ev.delta;
        else if (ev.type === 'finished') ended = ev.detail ? `${ev.reason}: ${ev.detail}` : ev.reason;
      }
    } catch (e) {
      push({ type: 'failed', roleId: role.id, error: e instanceof Error ? e.message : String(e) });
      return;
    }
    // 言い終えなかった担当（モデルが落ちた・止めた・上限）は、「問題なし」と数えない。Agent.run は落ちても投げないので、
    // 終わり方を見ないと、全員が落ちた回に「全員が問題なしと判断しました」と出していた。途中までの文の PROPOSAL も採らない。
    // ただし終わりの合図（TASK_DONE）を書かなかっただけ（noProgress）で、PROPOSAL を言い終えていれば採る（小さいモデルでありがち）
    const parsed = parseProposal(text);
    const usable = ended === 'completed' || (ended?.startsWith('noProgress') === true && parsed !== undefined);
    if (!usable) {
      push({ type: 'failed', roleId: role.id, error: ended ?? '終わり方が分かりません' });
      return;
    }

    if (!parsed) {
      push({ type: 'noFinding', roleId: role.id, roleName: role.name });
      return;
    }
    const finding: PanelFinding = {
      roleId: role.id, roleName: role.name,
      title: parsed.title, rationale: parsed.rationale, action: parsed.action,
    };
    findings.push(finding);
    push({ type: 'found', finding });
  };

  // 人数を絞って順に流す。全員を同時に走らせるとレーンが溢れる。
  const queue = [...opts.roles];
  const running = new Set<Promise<void>>();

  const fill = () => {
    while (running.size < parallel && queue.length > 0) {
      const role = queue.shift()!;
      const p = runOne(role).finally(() => running.delete(p));
      running.add(p);
    }
  };
  fill();

  while (running.size > 0 || inbox.length > 0) {
    while (inbox.length > 0) yield inbox.shift()!;
    if (running.size === 0) break;
    await Promise.race([
      Promise.race(running),
      new Promise<void>((resolve) => { wake = resolve; }),
    ]);
    fill();
  }
  while (inbox.length > 0) yield inbox.shift()!;

  return findings;
}

/** 同じ発見を別の担当が指摘した場合にまとめる。 */
export function mergeFindings(findings: PanelFinding[]): Array<PanelFinding & { alsoBy: string[] }> {
  const groups = new Map<string, Array<PanelFinding>>();
  for (const f of findings) {
    const key = f.title.toLowerCase().replace(/[\s、。,.:：「」"'`]/g, '');
    const group = groups.get(key);
    if (group) group.push(f);
    else groups.set(key, [f]);
  }
  return [...groups.values()].map(([first, ...rest]) => ({
    ...first!,
    alsoBy: rest.map((r) => r.roleName),
  }));
}
