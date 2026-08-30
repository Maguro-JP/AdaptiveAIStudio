/**
 * PM — 依頼を作業指示書に分解する。
 *
 * 会社で言えば、窓口が受けた依頼を部署に割り振る人。
 * ここが埋まると、依頼一つで複数の作業者が同時に動き出す。
 *
 * 設計上の要点は「分解の失敗で止まらないこと」。
 * モデルは平気で壊れた計画を返す。存在しない担当を指名し、
 * 循環した依存を書き、同じ ID を二度使う。
 * だから計画は**信用せず、直す**。捨てるのは最後の手段で、
 * どうしても直せなければ「一人で全部やる」一件に畳んで進める。
 * 分解できないことは、作業をしない理由にならない。
 */
import type { ProviderMessage } from '../providers/contract.ts';
import type { ChatOrchestrator } from '../core/orchestrator.ts';
import type { WorkItem } from './team.ts';
import type { LaneConfig } from '../core/scheduler.ts';

export interface PlanItem {
  id: string;
  /** 作業者への指示。単体で読んで意味が通ること。 */
  instruction: string;
  /** 担当させる役職。権限はここから決まる。 */
  roleId: string;
  laneId?: string;
  deps?: string[];
  writes?: string[];
  /** なぜこの分け方にしたか。読む側のために残す。 */
  why?: string;
}

export interface WorkPlan {
  summary: string;
  items: PlanItem[];
  /** 計画のどこを直したか。黙って直すと、次も同じ壊れ方をする。 */
  repairs: string[];
}

export type PmEvent =
  | { type: 'thinking'; delta: string }
  | { type: 'repaired'; detail: string }
  | { type: 'planned'; plan: WorkPlan };

export interface PmContext {
  lanes: LaneConfig[];
  roleIds: string[];
  /** 分解できなかったときに一人で引き受ける役職 */
  fallbackRoleId: string;
  /** 分け過ぎを止める。細かすぎる分解は、一人でやるより遅い。 */
  maxItems?: number;
}

/** 分解の指示。形式を外すと直す手間が増えるので、形は厳しく指定する。 */
export function planPrompt(request: string, ctx: PmContext): string {
  return [
    'あなたは開発チームの進行役です。次の依頼を、作業者に配れる形に分解してください。',
    '',
    `依頼: ${request}`,
    '',
    `使える担当: ${ctx.roleIds.join(', ')}`,
    `使えるレーン: ${ctx.lanes.map((l) => l.id).join(', ')}`,
    '',
    '守ること:',
    `- ${ctx.maxItems ?? 8} 件以内。分け過ぎると、一人でやるより遅くなります`,
    '- 各件は単体で読んで意味が通ること。「上記の続き」は禁止です',
    '- 同時に進められるものは deps を空にすること。並べられるものを直列にしない',
    '- 書き換える見込みのファイルは writes に列挙すること（同じファイルを触る件は自動で直列化されます）',
    '- 調べる・書く・確かめるは別の件に分けること。担当の権限が違います',
    '',
    'JSON だけを返してください。説明文は不要です。',
    '{"summary":"全体の方針を一文で",',
    ' "items":[{"id":"t1","instruction":"...","roleId":"...","deps":[],"writes":["src/x.ts"],"why":"..."}]}',
  ].join('\n');
}

/** 応答から JSON を取り出す。前後に喋られていても拾う。 */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced ? fenced[1] : text) ?? '';
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

const asString = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;

const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(asString).filter((s): s is string => !!s) : [];

/** 書き込み先を比較できる形に揃える。表記揺れで錠が効かないのが一番まずい。 */
export function normalizeWrite(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

/**
 * 計画を直す。捨てずに直すのが方針。
 * 直した内容は全て repairs に残す。黙って直すと、次も同じ壊れ方をする。
 */
export function repairPlan(raw: unknown, request: string, ctx: PmContext): WorkPlan {
  const repairs: string[] = [];
  const maxItems = ctx.maxItems ?? 8;
  const laneIds = ctx.lanes.map((l) => l.id);
  const roleIds = new Set(ctx.roleIds);
  const obj = (raw ?? {}) as Record<string, unknown>;

  const rawItems = Array.isArray(obj.items) ? obj.items : [];
  const seen = new Set<string>();
  let items: PlanItem[] = [];

  for (const [i, entry] of rawItems.entries()) {
    const e = (entry ?? {}) as Record<string, unknown>;
    const instruction = asString(e.instruction);
    if (!instruction) {
      repairs.push(`${i + 1}件目に指示が無いため外しました。`);
      continue;
    }

    let id = asString(e.id) ?? `t${i + 1}`;
    if (seen.has(id)) {
      const fixed = `${id}_${i + 1}`;
      repairs.push(`ID が重複していたため ${id} を ${fixed} に変えました。`);
      id = fixed;
    }
    seen.add(id);

    let roleId = asString(e.roleId) ?? ctx.fallbackRoleId;
    if (!roleIds.has(roleId)) {
      repairs.push(`存在しない担当 ${roleId} を指名していたため ${ctx.fallbackRoleId} に替えました。`);
      roleId = ctx.fallbackRoleId;
    }

    let laneId = asString(e.laneId);
    if (laneId && !laneIds.includes(laneId)) {
      repairs.push(`存在しないレーン ${laneId} を指定していたため割り当て直しました。`);
      laneId = undefined;
    }

    items.push({
      id,
      instruction,
      roleId,
      laneId,
      deps: asStringArray(e.deps),
      writes: asStringArray(e.writes).map(normalizeWrite),
      why: asString(e.why),
    });
  }

  if (items.length > maxItems) {
    repairs.push(`${items.length} 件は分け過ぎのため、先頭 ${maxItems} 件に絞りました。`);
    items = items.slice(0, maxItems);
  }

  // 依存先の掃除。自分自身・存在しない相手を指していたら外す。
  const ids = new Set(items.map((t) => t.id));
  for (const item of items) {
    const kept: string[] = [];
    for (const dep of item.deps ?? []) {
      if (dep === item.id) {
        repairs.push(`${item.id} が自分自身を待っていたため外しました。`);
        continue;
      }
      if (!ids.has(dep)) {
        repairs.push(`${item.id} が存在しない ${dep} を待っていたため外しました。`);
        continue;
      }
      kept.push(dep);
    }
    item.deps = kept;
  }

  breakCycles(items, repairs);

  // レーン割り当て。指定が無いものを順に配り、偏らせない。
  let next = 0;
  for (const item of items) {
    if (!item.laneId) {
      item.laneId = laneIds[next % laneIds.length] ?? laneIds[0]!;
      next += 1;
    }
  }

  // 一件も残らなかった場合。分解できないことは、やらない理由にならない。
  if (items.length === 0) {
    repairs.push('分解できなかったため、一人で全て引き受ける形にしました。');
    items = [{
      id: 't1',
      instruction: request,
      roleId: ctx.fallbackRoleId,
      laneId: laneIds[0] ?? 'main',
      deps: [],
      writes: [],
    }];
  }

  return {
    summary: asString(obj.summary) ?? request,
    items,
    repairs,
  };
}

/**
 * 循環した依存を断つ。
 * 循環したままスケジューラに渡すと全件が skipped になるので、
 * ここで戻り辺を落として必ず流れる形にする。
 */
export function breakCycles(items: PlanItem[], repairs: string[]): void {
  const byId = new Map(items.map((t) => [t.id, t]));
  const state = new Map<string, 'visiting' | 'done'>();

  const visit = (id: string): void => {
    const item = byId.get(id);
    if (!item) return;
    if (state.get(id) === 'done') return;
    state.set(id, 'visiting');
    for (const dep of [...(item.deps ?? [])]) {
      if (state.get(dep) === 'visiting') {
        item.deps = (item.deps ?? []).filter((d) => d !== dep);
        repairs.push(`依存が循環していたため ${item.id} → ${dep} を外しました。`);
        continue;
      }
      visit(dep);
    }
    state.set(id, 'done');
  };

  for (const item of items) visit(item.id);
}

/** 計画を作業指示に落とす。role の情報は呼び出し側で権限に変換する。 */
export function toWorkItems(plan: WorkPlan): Array<WorkItem & { roleId: string }> {
  return plan.items.map((t) => ({
    id: t.id,
    instruction: t.instruction,
    laneId: t.laneId!,
    deps: t.deps,
    writes: t.writes,
    roleId: t.roleId,
  }));
}

/** 読める形にする。並列で走る件が見えることが大事。 */
export function formatPlan(plan: WorkPlan): string {
  const lines = [`方針: ${plan.summary}`];
  for (const t of plan.items) {
    const wait = (t.deps ?? []).length > 0 ? ` ← ${t.deps!.join(', ')} の後` : ' （すぐ着手）';
    lines.push(`  [${t.id}] ${t.roleId} @${t.laneId}${wait}`);
    lines.push(`      ${t.instruction}`);
    if ((t.writes ?? []).length > 0) lines.push(`      書き込み: ${t.writes!.join(', ')}`);
  }
  if (plan.repairs.length > 0) {
    lines.push('  計画の修正:');
    for (const r of plan.repairs) lines.push(`    - ${r}`);
  }
  return lines.join('\n');
}

/**
 * 依頼を分解する。
 * モデルが黙っても壊れた JSON を返しても、必ず流せる計画が返る。
 */
export async function* decompose(
  orchestrator: ChatOrchestrator,
  request: string,
  opts: {
    candidates: string[];
    ctx: PmContext;
    temperature?: number;
    maxTokens?: number;
  },
  signal: AbortSignal,
): AsyncGenerator<PmEvent, WorkPlan> {
  const messages: ProviderMessage[] = [
    { role: 'user', content: planPrompt(request, opts.ctx) },
  ];

  let text = '';
  try {
    for await (const ev of orchestrator.run(
      {
        candidates: opts.candidates,
        system: '作業を分解して JSON で返す進行役。JSON 以外は出力しない。',
        messages,
        // 分解は発想ではなく整理。揺らす必要がない。
        temperature: opts.temperature ?? 0.1,
        maxTokens: opts.maxTokens,
      },
      signal,
    )) {
      if (ev.type === 'text') {
        text += ev.delta;
        yield { type: 'thinking', delta: ev.delta };
      }
    }
  } catch (e) {
    // 分解に失敗しても作業自体は止めない。一人で引き受ける形に落ちる。
    yield { type: 'repaired', detail: `分解の呼び出しに失敗しました: ${(e as Error).message}` };
  }

  const plan = repairPlan(extractJson(text), request, opts.ctx);
  for (const r of plan.repairs) yield { type: 'repaired', detail: r };
  yield { type: 'planned', plan };
  return plan;
}
