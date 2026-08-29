/**
 * 人員の登録と配属。
 *
 * 役職は設定ファイルからも足せる。
 * 「こういう気質の担当がいたら拾えるはず」と思いついたときに、
 * コードを触らず配属できることを重視する。
 */
import type { Role, ToolAccess } from './role.ts';
import { BUILTIN_ROLES } from './builtin.ts';
import type { Tool } from '../agent/tools/types.ts';

export interface RoleOverride {
  id: string;
  name?: string;
  responsibility?: string;
  disposition?: string;
  access?: ToolAccess[];
  instructions?: string[];
  outputContract?: string;
  prefers?: 'strong' | 'fast' | 'any';
  /** 既存の役職を土台にする。気質だけ変えたい場合に使う。 */
  extends?: string;
}

export class RoleRegistry {
  readonly #roles = new Map<string, Role>();

  constructor(extra: RoleOverride[] = []) {
    for (const r of BUILTIN_ROLES) this.#roles.set(r.id, r);
    for (const o of extra) this.#apply(o);
  }

  get(id: string): Role | undefined {
    return this.#roles.get(id);
  }

  all(): Role[] {
    return [...this.#roles.values()];
  }

  ids(): string[] {
    return [...this.#roles.keys()];
  }

  #apply(o: RoleOverride): void {
    const base = this.#roles.get(o.extends ?? o.id);
    if (!base && (!o.name || !o.responsibility || !o.disposition || !o.access)) {
      // 土台も無く、必要な項目も揃っていないものは登録しない。
      // 中途半端な役職は、いない方がまし。
      return;
    }
    const merged: Role = {
      id: o.id,
      name: o.name ?? base?.name ?? o.id,
      responsibility: o.responsibility ?? base?.responsibility ?? '',
      disposition: o.disposition ?? base?.disposition ?? '',
      access: o.access ?? base?.access ?? ['read'],
      instructions: o.instructions ?? base?.instructions ?? [],
      outputContract: o.outputContract ?? base?.outputContract,
      prefers: o.prefers ?? base?.prefers ?? 'any',
    };
    this.#roles.set(merged.id, merged);
  }
}

/**
 * 役職の権限に合うツールだけを渡す。
 *
 * 「使わないでください」と書くのではなく、渡さない。
 * 破壊担当に書き込みを渡さないのは、信用していないからではなく、
 * 役割上必要ないから。必要のない権限は事故の原因にしかならない。
 */
export function toolsFor(
  role: Role,
  pool: { read: Tool[]; write: Tool[]; execute: Tool[] },
): Tool[] {
  const tools: Tool[] = [];
  for (const access of ['read', 'write', 'execute'] as const) {
    if (role.access.includes(access)) tools.push(...pool[access]);
  }
  return tools;
}
