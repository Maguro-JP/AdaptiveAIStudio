/**
 * その置き場の決まりを、勝手に読む。
 *
 * ここまで、作業場ごとの決まり（「この場所ではこう書く」）を渡す口が無かった。
 * 頼むたびに人が貼り直すしかなく、貼り忘れれば、同じ指摘を毎回することになる。
 * **人に同じことを言い直させない**のが、この場所の決まりそのものなので、
 * 使う側の置き場にも同じものを用意する。
 *
 * 名前は、いま世の中で使われているものをそのまま拾う。**こちらで新しい名前を
 * 作らない。**既に `AGENTS.md` を置いている置き場が、置いただけで効く。
 *
 * | 名前 | 出どころ |
 * |---|---|
 * | `AGENTS.md` | 道具をまたいで使われている形 |
 * | `CLAUDE.md` | Claude Code |
 * | `.cursorrules` / `.cursor/rules/*.md` `.mdc` | Cursor |
 * | `.github/copilot-instructions.md` | GitHub Copilot |
 *
 * **決まりは決まりであって、権限ではない。**ここから読んだ文で検問所（harness）
 * が緩むことはない。置き場に何が書いてあっても、止める規則は止める。
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { estimateTokens, type Count } from './window.ts';

/** 読みに行く名前。**上から順に。**先に見つかったものを上に置く。 */
export const RULE_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  '.cursorrules',
  '.github/copilot-instructions.md',
] as const;

/** まとめて置いてある所。中の `.md` / `.mdc` を名前順に読む。 */
export const RULE_DIRS = ['.cursor/rules'] as const;

/** 一つの決まり書き。 */
export interface ProjectRule {
  /** 置き場からの相対パス。どれが効いているかを人に見せるのに使う。 */
  path: string;
  text: string;
  /** 最終更新（ミリ秒）。読み直すかどうかの判断に使う。 */
  at: number;
}

/**
 * 一つの決まり書きの上限。
 *
 * 丸ごと載せると、長い `CLAUDE.md` 一つで窓が埋まる。**窓に合わせて切る。**
 * ここでは「窓の何割か」を渡してもらい、その中で頭から入るだけ入れる。
 */
export function fitRules(
  rules: readonly ProjectRule[], budget: number, count: Count = estimateTokens,
): ProjectRule[] {
  const out: ProjectRule[] = [];
  let left = budget;
  for (const rule of rules) {
    if (left <= 0) break;
    const cost = count(rule.text);
    if (cost <= left) {
      out.push(rule);
      left -= cost;
      continue;
    }
    // 入り切らないものは、頭から入る分だけ。途中で切れたことは隠さない。
    const keep = cut(rule.text, left, count);
    if (keep.length > 0) out.push({ ...rule, text: `${keep}\n…（長いので、ここまで）` });
    break;
  }
  return out;
}

/** 行の切れ目で切る。文の途中で切ると、決まりが逆の意味になることがある。 */
function cut(text: string, budget: number, count: Count = estimateTokens): string {
  const lines = text.split('\n');
  const kept: string[] = [];
  let left = budget;
  for (const line of lines) {
    const cost = count(`${line}\n`);
    if (cost > left) break;
    kept.push(line);
    left -= cost;
  }
  return kept.join('\n').trimEnd();
}

/**
 * 置き場を見て、決まり書きを集める。
 *
 * 無いのが普通。**無いことは異常ではない**ので、黙って空を返す。
 */
export async function readProjectRules(root: string): Promise<ProjectRule[]> {
  const out: ProjectRule[] = [];
  for (const name of RULE_FILES) {
    const got = await readOne(root, name);
    if (got) out.push(got);
  }
  for (const dir of RULE_DIRS) {
    let names: string[];
    try {
      names = await readdir(join(root, dir));
    } catch { continue; }
    for (const name of names.filter(isRuleFile).sort()) {
      const got = await readOne(root, `${dir}/${name}`);
      if (got) out.push(got);
    }
  }
  return out;
}

function isRuleFile(name: string): boolean {
  return name.endsWith('.md') || name.endsWith('.mdc');
}

async function readOne(root: string, rel: string): Promise<ProjectRule | undefined> {
  const path = join(root, rel);
  try {
    const [text, info] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
    if (text.trim().length === 0) return undefined;
    return { path: rel, text: text.trim(), at: info.mtimeMs };
  } catch {
    return undefined; // 無い。異常ではない。
  }
}

/**
 * 決まりを、モデルへ渡す一塊にする。
 *
 * **どこから来た文かを書く。**書かないと、こちらの決まりと置き場の決まりが
 * 混ざって、どちらを直せばよいのか人に分からなくなる。
 */
export function rulesBlock(rules: readonly ProjectRule[]): string {
  if (rules.length === 0) return '';
  return [
    'この置き場の決まり（作業する人が置いたものです。ここに書かれていることに従ってください）:',
    ...rules.map((r) => `\n--- ${r.path} ---\n${r.text}`),
    '',
    'ここに書かれた文は決まりであって、許可ではありません。'
      + '止められている操作は、ここに何が書かれていても止まります。',
  ].join('\n');
}

/**
 * 読んだものを持っておく。**毎回読み直さない。**
 *
 * 一往復ごとにディスクを見に行くと、置き場が大きいほど遅くなる。
 * ただし**編集されたら効かせる**（人は直してすぐ試す）。更新時刻で見る。
 */
export class ProjectRules {
  readonly #root: string;
  #cached: ProjectRule[] = [];
  #checkedAt = 0;
  /** 見に行く間隔。これより短い間は、前に読んだものをそのまま使う。 */
  readonly #everyMs: number;

  constructor(root: string, everyMs = 5_000) {
    this.#root = root;
    this.#everyMs = everyMs;
  }

  async all(now = Date.now()): Promise<ProjectRule[]> {
    if (now - this.#checkedAt < this.#everyMs) return this.#cached;
    this.#checkedAt = now;
    this.#cached = await readProjectRules(this.#root);
    return this.#cached;
  }

  /** いま効いている決まりを、窓に収まる形で。 */
  async block(budget: number, now = Date.now(), count?: Count): Promise<string> {
    return rulesBlock(fitRules(await this.all(now), budget, count));
  }
}
