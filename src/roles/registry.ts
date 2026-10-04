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
// 権限の語を足したら、ここにも足す（足し忘れると黙って捨てられる）。型で全部が並んでいることを確かめる
const KNOWN_ACCESS = ['read', 'write', 'execute', 'network', 'mcp'] as const satisfies readonly ToolAccess[];
type Missing = Exclude<ToolAccess, (typeof KNOWN_ACCESS)[number]>;
const allListed: [Missing] extends [never] ? true : never = true;
void allListed;

export function dropWriteIfOutbound(access: readonly ToolAccess[]): {
  access: ToolAccess[]; dropped: boolean;
} {
  const outbound = access.includes('network') || access.includes('mcp');
  /*
   * **`execute` も書く手。**`run_command` は `node -e` / `echo … >` / `git apply` でファイルを書ける（許可の先頭語に
   * node・echo・git が在る）。write だけを落とすと、外から持ち帰ったものを run_command でそのままリポジトリへ書けた。
   */
  const writes = (a: ToolAccess): boolean => a === 'write' || a === 'execute';
  if (!outbound || !access.some(writes)) return { access: [...access], dropped: false };
  return { access: access.filter((a) => !writes(a)), dropped: true };
}

/** 落とした権限の名前（知らせの文に出す。実際に落としたものだけを言う）。 */
function droppedNames(before: readonly ToolAccess[], after: readonly ToolAccess[]): string {
  return before.filter((a) => !after.includes(a)).join(' と ');
}

const OVERRIDE_TEXT = ['codename', 'name', 'responsibility', 'disposition', 'outputContract', 'extends', 'prefers'] as const;
const OVERRIDE_LIST = ['formerly', 'succeededBy', 'instructions'] as const;

/**
 * 設定の役職一件の形を確かめる。id が文字列でない一件は捨てる（`undefined`）。
 * 文字列であるべき項目が文字列でない・並びであるべき項目が文字列の並びでないときは、その項目だけを捨てる。
 * 捨てた理由は `said` で言う（黙って捨てると、書いたのに効かない理由が分からない）。権限（access）は後で別に確かめる。
 */
function sanitizeOverride(raw: unknown, said: (text: string) => void): RoleOverride | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    said('roles: 形の違う一件（オブジェクトでないもの）を読みませんでした');
    return undefined;
  }
  const o = { ...(raw as Record<string, unknown>) };
  if (typeof o.id !== 'string' || o.id.trim() === '') {
    said('roles: id の無い一件を読みませんでした');
    return undefined;
  }
  for (const key of OVERRIDE_TEXT) {
    if (o[key] !== undefined && typeof o[key] !== 'string') {
      said(`${o.id}: ${key} が文字列ではないので外しました`);
      delete o[key];
    }
  }
  for (const key of OVERRIDE_LIST) {
    const v = o[key];
    if (v === undefined) continue;
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
      said(`${o.id}: ${key} が文字列の並びではないので外しました`);
      delete o[key];
    }
  }
  if (o.prefers !== undefined && !['strong', 'fast', 'any'].includes(o.prefers as string)) {
    said(`${o.id}: prefers は strong / fast / any のどれかです。外しました`);
    delete o.prefers;
  }
  if (o.retired !== undefined && typeof o.retired !== 'boolean') {
    said(`${o.id}: retired が true / false ではないので外しました`);
    delete o.retired;
  }
  return o as unknown as RoleOverride;
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
          `${r.id}: 外へ出る道があるので ${droppedNames(r.access, access)} を外しました`
          + '（外から入ってきたものを、そのままリポジトリへ書けてしまうため）',
        );
      }
      this.#roles.set(r.id, dropped ? { ...r, access } : r);
    }
    // 設定から来る形は確かめていない（`roles` が並びでない・一件が null・instructions が文字列、で起動ごと落ちていた）。
    // 足りない側に倒す: 並びでないものは無いものとし、形の違う一件・項目は捨てて理由を言う
    if (!Array.isArray(extra)) this.#dropped.push('roles: 並びではないので読みませんでした');
    for (const raw of Array.isArray(extra) ? extra : []) {
      const o = sanitizeOverride(raw, (said) => this.#dropped.push(said));
      if (o) this.#apply(o);
    }
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
    const direct = this.#find(id);
    if (!direct) return undefined;
    // 引き継ぎ先のうち現役のものを先に選ぶ。無ければ本人（引き継ぎ済みのまま）
    return this.#active(direct, new Set()) ?? direct;
  }

  #find(id: string): Role | undefined {
    return this.#roles.get(id) ?? this.#roles.get(this.#aliases.get(id) ?? '');
  }

  /**
   * 引き継ぎを辿って、現役の役職を探す。見つからなければ undefined。
   * 輪（A→B→A・自分を指す）は通った所を覚えて止める（辿り続けると立ち上げごと落ちる）。
   * 輪の途中の引き継ぎ済みの役職では止まらず、別の引き継ぎ先の現役を探し続ける。
   */
  #active(role: Role, seen: Set<string>): Role | undefined {
    if (!role.retired) return role;
    if (seen.has(role.id)) return undefined;
    seen.add(role.id);
    for (const next of Array.isArray(role.succeededBy) ? role.succeededBy : []) {
      const r = this.#find(next);
      const found = r ? this.#active(r, seen) : undefined;
      if (found) return found;
    }
    return undefined;
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
      // 中途半端な役職は、いない方がまし。黙って捨てると、書いたのに居ない理由が分からないので言う
      this.#dropped.push(`${o.id}: extends が無く、name・responsibility・disposition・access も揃っていないので読みませんでした`);
      return;
    }
    const inherits = o.extends === undefined || o.extends === o.id;
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
      // 名前の履歴と引き継ぎは、その役職そのもののこと。別の id で extends したときは受け継がない
      // （受け継ぐと、元の旧名が新しい役職を指し、引き継ぎ済みの役職を extends して作った役職に一度も割り当てが行かなかった）
      formerly: o.formerly ?? (inherits ? base?.formerly : undefined),
      succeededBy: o.succeededBy ?? (inherits ? base?.succeededBy : undefined),
      retired: o.retired ?? (inherits ? base?.retired : undefined),
    };
    /*
     * 権限は決まった語の並びだけを受ける。文字列（`"read,write,network"`）で書くと、`includes` の部分一致で権限が付き、
     * `some` で投げて立ち上げごと落ちていた。並びでないもの・知らない語は捨てて、そう言う（足りない側に倒す）
     */
    const raw: unknown = o.access ?? base?.access ?? ['read'];
    let want: ToolAccess[];
    if (!Array.isArray(raw)) {
      want = ['read'];
      this.#dropped.push(`${merged.id}: access を並び（["read", "write"] の形）で書いていないので、read だけにしました`);
    } else {
      want = raw.filter((a): a is ToolAccess => (KNOWN_ACCESS as readonly unknown[]).includes(a));
      const unknown = raw.filter((a) => !(KNOWN_ACCESS as readonly unknown[]).includes(a));
      if (unknown.length > 0) this.#dropped.push(`${merged.id}: 知らない権限 ${unknown.map(String).join(', ')} を外しました`);
    }
    const { access, dropped } = dropWriteIfOutbound(want);
    if (dropped) {
      this.#dropped.push(
        `${merged.id}: 外へ出る道があるので ${droppedNames(want, access)} を外しました`
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
