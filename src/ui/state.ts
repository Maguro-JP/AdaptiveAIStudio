/**
 * 画面に出す材料を、一箇所から読む。
 *
 * 画面は状態を持たない。持たせると、CLI で動かしたときと
 * 画面で動かしたときで見えているものが食い違う。
 * 保存されているものだけを読んで組み立てる。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stateDir } from '../core/autopilot-setup.ts';
import { Memory, type MemoryEntry } from '../memory/memory.ts';
import { RoleRegistry } from '../roles/registry.ts';
import { DutyRoster, describeCadence, type DutyRecord } from '../harness/duties.ts';
import { BUILTIN_DUTIES } from '../harness/builtin-duties.ts';
import type { AasConfig } from '../config.ts';

export interface UiState {
  roles: Array<{
    id: string; codename: string; name: string; disposition: string;
    access: string[]; retired?: boolean; succeededBy?: string[]; formerly?: string[];
  }>;
  memory: MemoryEntry[];
  memorySize: number;
  proposals: unknown[];
  /**
   * 溜まりすぎて落とした提案の数。
   *
   * **落としたことを黙らない。**上限（200件）で古い方から落としているが、
   * 数えているだけで、どこにも出していなかった。
   */
  proposalsDropped: number;
  /**
   * 日課。**記録ではなく、仕込んであるもの全部**を出す。
   *
   * 記録（`duties.json`）だけを渡していたので、まだ一度も回っていないと
   * 画面は空で、何が仕込まれているのかも、いつ起きるのかも分からなかった。
   */
  duties: DutyBoard[];
  models: unknown[];
}

/** 画面に出す日課、一件ぶん。 */
export interface DutyBoard {
  id: string;
  codename: string;
  name: string;
  purpose: string;
  /** いつ起きるか（「毎日 7 時」など）。 */
  when: string;
  /** 最後に済んだ時刻。まだなら undefined。 */
  lastAt?: number;
  /** いま発生しているか。 */
  due: boolean;
  /** 逃した分の埋め合わせか。 */
  catchUp: boolean;
  completions: number;
  missed: number;
}

/** 記録と、仕込んである日課を重ねて、画面に出す形にする。 */
export function dutyBoard(records: DutyRecord[], now: number): DutyBoard[] {
  const roster = new DutyRoster(BUILTIN_DUTIES);
  if (Array.isArray(records)) roster.restore(records);
  return roster.status(now).map((s) => ({
    id: s.duty.id,
    codename: s.duty.codename,
    name: s.duty.name,
    purpose: s.duty.purpose,
    when: describeCadence(s.duty.cadence),
    ...(typeof s.record.lastAt === 'number' ? { lastAt: s.record.lastAt } : {}),
    due: s.due,
    catchUp: s.isCatchUp,
    completions: s.record.completions,
    missed: s.record.missed,
  }));
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    // まだ何も無いのは異常ではない。初回起動はいつも空。
    return fallback;
  }
}

/** 提案の記録。古い形（配列そのまま）でも読めるようにしておく。 */
async function readProposals(path: string): Promise<{ items: unknown[]; dropped: number }> {
  const raw = await readJson<unknown>(path, []);
  if (Array.isArray(raw)) return { items: raw.filter((x) => typeof x === 'object' && x !== null), dropped: 0 };
  // `null` や形の違う一件で、画面の一覧ごと 500 にしない。
  const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as { items?: unknown; dropped?: unknown };
  return {
    items: Array.isArray(obj.items) ? obj.items.filter((x) => typeof x === 'object' && x !== null) : [],
    dropped: typeof obj.dropped === 'number' ? obj.dropped : 0,
  };
}

export async function collectState(config: AasConfig): Promise<UiState> {
  const dir = stateDir();
  const proposals = await readProposals(join(dir, 'proposals.json'));
  const roles = new RoleRegistry(config.roles ?? []);
  const memory = new Memory(join(dir, 'memory.jsonl'));
  await memory.load();

  return {
    roles: roles.roster().map((r) => ({
      id: r.id, codename: r.codename, name: r.name, disposition: r.disposition,
      access: r.access as string[], retired: r.retired,
      succeededBy: r.succeededBy, formerly: r.formerly,
    })),
    memory: memory.all().slice(-60).reverse(),
    memorySize: memory.size,
    // **保存の形と読み方を合わせる。**`{items, examined, dropped}` で
    // 書いてあるのに配列として読んでいたので、ここは常に「配列ではない何か」
    // だった（画面は使っていなかったので気づかれなかった）。
    proposals: proposals.items,
    proposalsDropped: proposals.dropped,
    duties: dutyBoard(await readJson<DutyRecord[]>(join(dir, 'duties.json'), []), Date.now()),
    models: await readJson<unknown[]>(join(dir, 'metrics.json'), []),
  };
}
