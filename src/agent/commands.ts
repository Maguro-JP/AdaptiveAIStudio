/**
 * 打ち込みのコマンド（`/fix ...`）と、作業場の skill。
 *
 * 入力欄の先頭に `/名前` を書くと、その名前の指示に置き換えて送る。
 * 名前は世の中で使われている形をそのまま拾う。**新しい形を作らない。**
 *
 * | 置き方 | 出どころ |
 * |---|---|
 * | `.claude/skills/<name>/SKILL.md` | Claude Code |
 * | `.agents/skills/<name>/SKILL.md` | ツールをまたいで使われている形 |
 *
 * SKILL.md の頭に `---` で囲んだ `name:` / `description:` があればそれを使い、
 * 無ければフォルダ名と最初の一行を使う。本文が指示で、`$ARGUMENTS` が
 * あればそこへ、無ければ末尾に、コマンドの後ろに書いた文を入れる。
 *
 * **指示は指示であって、権限ではない。**skill に何が書いてあっても、
 * 検問所（harness）が緩むことはない。
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface Command {
  /** `/` を除いた名前。ASCII のまま。 */
  name: string;
  /** 一覧に出す一言。 */
  description: string;
  source: 'builtin' | 'skill';
  /** skill なら、作業場からの相対パス。どれが効いたかを人に見せる。 */
  path?: string;
  /** 置き換える指示。`$ARGUMENTS` があればそこへ後ろの文を入れる。 */
  template: string;
}

/** 組み込み。名前は他のツールでも通じるものに揃える。 */
export const BUILTIN_COMMANDS: readonly Command[] = [
  {
    name: 'fix', source: 'builtin', description: '不具合を直す',
    template: '次の不具合を直してください。まず原因を突き止め、直したら、テストか実行で直ったことを確かめてください。\n\n$ARGUMENTS',
  },
  {
    name: 'review', source: 'builtin', description: '直さずに、指摘だけする',
    template: '次のものをレビューしてください（指定が無ければ、作業場のコミットしていない差分）。不具合・抜け・危ない所を、場所（ファイルと行）を添えて挙げてください。直さないでください。\n\n$ARGUMENTS',
  },
  {
    name: 'test', source: 'builtin', description: 'テストを書いて回す',
    template: '次の対象のテストを書いて、回してください。落ちたら、テストではなく中身を直してください。\n\n$ARGUMENTS',
  },
  {
    name: 'explain', source: 'builtin', description: '読み方を説明する',
    template: '次のものを説明してください。何をしているか、なぜそうなっているかを、読む順に。直さないでください。\n\n$ARGUMENTS',
  },
  {
    name: 'refactor', source: 'builtin', description: '振る舞いを変えずに整える',
    template: '次のものを、振る舞いを変えずに整えてください。整える前と後で、同じテストが通ることを確かめてください。\n\n$ARGUMENTS',
  },
];

/** skill を探す所。上から順。 */
export const SKILL_DIRS = ['.claude/skills', '.agents/skills'] as const;

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** SKILL.md の頭の `---` を読む。無ければ空。 */
export function parseSkill(raw: string, fallbackName: string): { name: string; description: string; body: string } {
  let name = fallbackName;
  let description = '';
  // 頭の BOM は落とす（付いていると頭書きとして読まず、name: や description: の行まで指示の本文としてモデルへ送っていた）
  const text = raw.replace(/^\uFEFF/, '');
  let body = text;
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (m) {
    body = text.slice(m[0].length);
    for (const line of m[1]!.split(/\r?\n/)) {
      const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
      if (!kv) continue;
      const v = kv[2]!.trim().replace(/^["']|["']$/g, '');
      if (kv[1] === 'name' && NAME.test(v)) name = v;
      if (kv[1] === 'description') description = v;
    }
  }
  if (!description) {
    const first = body.split(/\r?\n/).map((l) => l.replace(/^#+\s*/, '').trim()).find((l) => l);
    description = first ?? '';
  }
  return { name, description, body: body.trim() };
}

/** 作業場の skill を読む。読めない所は飛ばす（無いのが普通）。 */
export async function listSkills(root: string): Promise<Command[]> {
  const out: Command[] = [];
  const seen = new Set<string>();
  for (const dir of SKILL_DIRS) {
    const at = join(root, dir);
    const names = await readdir(at, { withFileTypes: true }).catch(() => []);
    for (const d of names.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!d.isDirectory() || !NAME.test(d.name)) continue;
      const rel = join(dir, d.name, 'SKILL.md');
      const raw = await readFile(join(root, rel), 'utf8').catch(() => undefined);
      if (raw === undefined) continue;
      const s = parseSkill(raw, d.name);
      if (seen.has(s.name)) continue;
      seen.add(s.name);
      out.push({ name: s.name, description: s.description, source: 'skill', path: rel, template: s.body });
    }
  }
  return out;
}

/** 組み込みと、作業場の skill。同じ名前なら skill が勝つ（作業場の方が近い）。 */
export async function listCommands(root: string): Promise<Command[]> {
  const skills = await listSkills(root);
  const taken = new Set(skills.map((s) => s.name));
  return [...skills, ...BUILTIN_COMMANDS.filter((b) => !taken.has(b.name))];
}

/** `/名前 後ろ` に分ける。コマンドでなければ undefined。 */
export function splitCommand(text: string): { name: string; args: string } | undefined {
  const m = /^\/([A-Za-z0-9][A-Za-z0-9_-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return undefined;
  return { name: m[1]!, args: (m[2] ?? '').trim() };
}

/** 指示に置き換える。 */
export function fill(cmd: Command, args: string): string {
  return cmd.template.includes('$ARGUMENTS')
    // 置き換えを関数で渡す。文字で渡すと、利用者の文の `$&` `$$` `$'` を置き換えの記号として読む（`$&` は `$ARGUMENTS` に化ける）
    ? cmd.template.replace(/\$ARGUMENTS/g, () => args).trim()
    : `${cmd.template}\n\n${args}`.trim();
}

export type Expanded =
  | { kind: 'plain'; text: string }
  | { kind: 'command'; text: string; command: Command; args: string }
  | { kind: 'unknown'; name: string; known: string[] };

/**
 * 打ったものを、送る文にする。
 *
 * `/plan` は分解の道で、ここでは扱わない（呼ぶ側が先に見る）。
 * 知らない名前は**送らない**。`/fxi` をそのままモデルに渡すと、
 * 打ち間違いが「コマンドは効いていない」に見える。
 */
export async function expandCommand(text: string, root: string): Promise<Expanded> {
  const hit = splitCommand(text);
  if (!hit) return { kind: 'plain', text };
  const all = await listCommands(root);
  const cmd = all.find((c) => c.name === hit.name);
  if (!cmd) return { kind: 'unknown', name: hit.name, known: all.map((c) => c.name) };
  return { kind: 'command', text: fill(cmd, hit.args), command: cmd, args: hit.args };
}
