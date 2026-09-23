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
  codename?: string;
  /** かつての呼び名。改名しても古い名前で引けるようにする。 */
  formerly?: string[];
  /** 仕事の引き継ぎ先。役職は消さず、指し先を示す。 */
  succeededBy?: string[];
  retired?: boolean;
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

/**
 * 外へ出る道と、書き込みを、同じ役職に持たせない。
 *
 * **決まりとして書いてあるのに、どこも見ていなかった。**設定から足す役職は
 * `access` をそのまま受け取るので、`['write', 'network']` と書けば通った。
 * それは、外から入ってきたものをそのままリポジトリへ書ける形で、
 * 検問所を置いた意味が無くなる。
 *
 * 落とすのは `write` の方。外へ出る道を取り上げると、その役職が何のために
 * 居るのか分からなくなる。**黙って落とさない。**何を落としたかを返す。
 */
export function dropWriteIfOutbound(access: readonly ToolAccess[]): {
  access: ToolAccess[]; dropped: boolean;
} {
  const outbound = access.includes('network') || access.includes('mcp');
  if (!outbound || !access.includes('write')) return { access: [...access], dropped: false };
  return { access: access.filter((a) => a !== 'write'), dropped: true };
}

export class RoleRegistry {
  readonly #roles = new Map<string, Role>();
  /** 旧名 → 現在のID。改名しても設定と履歴の指し先を失わせない。 */
  readonly #aliases = new Map<string, string>();

  /** 落とした権限。何を落としたかを、使う側が言えるように残す。 */
  readonly #dropped: string[] = [];

  /**
   * `builtins` を渡せるのは**確かめるため**。既定は組み込みの一覧。
   *
   * 組み込みを素通しで入れていた頃は、ここに何を入れても守りが効かなかった。
   * 効くようになったことを試験で押せる形にしておく（組み込みの一覧そのものに
   * 違反を入れて確かめることはできないので、入口を開けておく）。
   */
  constructor(
    extra: RoleOverride[] = [],
    onLog?: (text: string) => void,
    builtins: readonly Role[] = BUILTIN_ROLES,
  ) {
    /*
     * 組み込みの役職も、同じ道を通す。
     *
     * ここは素通しで入れていたので、**守りが効くのは設定から足す役職だけ**
     * だった。いまの一覧に該当は無いが（`test/roles.test.ts` で見ている）、
     * 足した人が気づけない形は残さない。
     */
    for (const r of builtins) {
      const { access, dropped } = dropWriteIfOutbound(r.access);
      if (dropped) {
        this.#dropped.push(
          `${r.id}: 外へ出る道があるので write を外しました`
          + '（外から入ってきたものを、そのままリポジトリへ書けてしまうため）',
        );
      }
      this.#roles.set(r.id, dropped ? { ...r, access } : r);
    }
    for (const o of extra) this.#apply(o);
    this.#buildAliases();
    for (const said of this.#dropped) onLog?.(said);
  }

  /** 外へ出る道があるので write を落とした役職。無ければ空。 */
  get droppedWrite(): readonly string[] { return this.#dropped; }

  /**
   * 役職を引く。旧名でも引ける。
   *
   * 引き継ぎ済みの役職を引いた場合は、引き継ぎ先を返す。
   * **いなくなったのではなく、担当が分かれただけ**なので、
   * 呼べば誰かには繋がる。
   */
  get(id: string): Role | undefined {
    const direct = this.#roles.get(id) ?? this.#roles.get(this.#aliases.get(id) ?? '');
    if (!direct) return undefined;
    if (!direct.retired) return direct;

    // 引き継ぎ先へ回す
    for (const next of direct.succeededBy ?? []) {
      const successor = this.get(next);
      if (successor) return successor;
    }
    return direct;
  }

  /** 現役の役職だけ。引き継ぎ済みは新しい割り当てを受けない。 */
  active(): Role[] {
    return this.all().filter((r) => !r.retired);
  }

  /** 名簿に載っている全員。引き継ぎ済みも含む。消さないため。 */
  roster(): Role[] {
    return this.all();
  }

  #buildAliases(): void {
    for (const role of this.#roles.values()) {
      for (const old of role.formerly ?? []) {
        if (!this.#roles.has(old)) this.#aliases.set(old, role.id);
      }
    }
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
      codename: o.codename ?? base?.codename ?? o.id.toUpperCase(),
      name: o.name ?? base?.name ?? o.id,
      responsibility: o.responsibility ?? base?.responsibility ?? '',
      disposition: o.disposition ?? base?.disposition ?? '',
      access: [],
      instructions: o.instructions ?? base?.instructions ?? [],
      outputContract: o.outputContract ?? base?.outputContract,
      prefers: o.prefers ?? base?.prefers ?? 'any',
      formerly: o.formerly ?? base?.formerly,
      succeededBy: o.succeededBy ?? base?.succeededBy,
      retired: o.retired ?? base?.retired,
    };
    const want = o.access ?? base?.access ?? ['read'];
    const { access, dropped } = dropWriteIfOutbound(want);
    if (dropped) {
      this.#dropped.push(
        `${merged.id}: 外へ出る道があるので write を外しました`
        + '（外から入ってきたものを、そのままリポジトリへ書けてしまうため）',
      );
    }
    this.#roles.set(merged.id, { ...merged, access });
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
  pool: { read: Tool[]; write: Tool[]; execute: Tool[]; network?: Tool[]; mcp?: Tool[] },
): Tool[] {
  const tools: Tool[] = [];
  for (const access of ['read', 'write', 'execute', 'network', 'mcp'] as const) {
    if (role.access.includes(access)) tools.push(...(pool[access] ?? []));
  }
  return tools;
}
