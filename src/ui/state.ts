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
import type { AasConfig } from '../config.ts';

export interface UiState {
  roles: Array<{
    id: string; codename: string; name: string; disposition: string;
    access: string[]; retired?: boolean; succeededBy?: string[]; formerly?: string[];
  }>;
  memory: MemoryEntry[];
  memorySize: number;
  proposals: unknown[];
  duties: unknown[];
  models: unknown[];
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    // まだ何も無いのは異常ではない。初回起動はいつも空。
    return fallback;
  }
}

export async function collectState(config: AasConfig): Promise<UiState> {
  const dir = stateDir();
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
    proposals: await readJson<unknown[]>(join(dir, 'proposals.json'), []),
    duties: await readJson<unknown[]>(join(dir, 'duties.json'), []),
    models: await readJson<unknown[]>(join(dir, 'metrics.json'), []),
  };
}
