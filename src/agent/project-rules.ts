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
import { isAbsent } from '../harness/put-back.ts';

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
  return fitRulesWithDropped(rules, budget, count).kept;
}

/**
 * 収まる分だけ入れて、**入らなかった見出しを名前で返す。**
 *
 * ここは行の切れ目で頭から詰めるだけだった。`## ` の見出しを跨いで切るので、
 * **途中の節が半分だけ渡り、その後ろは丸ごと消える。**しかも残るのは
 * 「…（長いので、ここまで）」の一行だけで、何が消えたかは誰にも分からない。
 *
 * 実測（この CLAUDE.md、11 節）:
 *
 *   コンテキストウィンドウ 4096 →  1 節
 *   窓  8192 →  3 節
 *   コンテキストウィンドウ 16384 →  6 節
 *   コンテキストウィンドウ 32768 → 11 節
 *
 * 手元の小さいモデルは 8192 前後になるので、**「push では CI を回さない」
 * 「C: 直下にフォルダを作らない」「実行時の依存はゼロ」あたりは、一度も
 * 渡っていなかった。**利用者が何度も言った決まりが、届いていない。
 *
 * だから**節の単位で入れる**。半端に切らない。そして入らなかった節は
 * 名前で返して、モデルにも人にも見せる。
 */
export function fitRulesWithDropped(
  rules: readonly ProjectRule[], budget: number, count: Count = estimateTokens,
): { kept: ProjectRule[]; dropped: string[] } {
  const kept: ProjectRule[] = [];
  const dropped: string[] = [];
  let left = budget;
  for (const rule of rules) {
    const cost = count(rule.text);
    if (cost <= left && left > 0) {
      kept.push(rule);
      left -= cost;
      continue;
    }
    const { text, missing } = fitSections(rule.text, left, count);
    if (text.length > 0) {
      kept.push({ ...rule, text });
      left -= count(text);
    }
    for (const m of missing) dropped.push(`${rule.path} の ${m}`);
  }
  return { kept, dropped };
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

/** 見出し（`## `）で切り分ける。頭の、見出しの前にある分も一つに数える。 */
function sections(text: string): Array<{ head: string; text: string }> {
  const out: Array<{ head: string; text: string }> = [];
  let head = '(はじめ)';
  let lines: string[] = [];
  const flush = (): void => {
    const body = lines.join('\n').trim();
    if (body.length > 0) out.push({ head, text: body });
  };
  for (const line of text.split('\n')) {
    if (/^#{1,3} /.test(line)) {
      flush();
      head = line.trim();
      lines = [line];
      continue;
    }
    lines.push(line);
  }
  flush();
  return out;
}

/**
 * 節の単位で、**上から順に、入らなくなったところで止める。**
 *
 * 一度、入らない節を飛ばして次を試す形にした。予算は埋まるが、
 * **大きくて大事な節が落ち、小さくてどうでもいい節が入る。**
 * 実際にコンテキストウィンドウ 4096 で「## 前提（勝手に変えない）」が落ちて
 * 「## 時刻」が入った。書いた人は大事なものを上に置くので、
 * **並びを崩す方が悪い。**
 *
 * 入らなかったものは全部名前で返す。呼ぶ側が人に見せる。
 */
function fitSections(
  text: string, budget: number, count: Count = estimateTokens,
): { text: string; missing: string[] } {
  const parts = sections(text);
  /*
   * 見出しが無いファイルは、節に割れない。**丸ごと落とすより、頭から入る
   * 分だけ入れる方がよい**（切ったとは言う）。節で入れる形にしたとき、
   * ここを落としてしまい、元からあったテストが捕まえた。
   */
  if (parts.length <= 1) {
    const keep = cut(text, budget, count);
    return keep.length > 0
      ? { text: `${keep}\n…（長いので、ここまで）`, missing: [] }
      : { text: '', missing: parts.map((p) => p.head) };
  }
  const kept: string[] = [];
  let left = budget;
  let at = 0;
  for (; at < parts.length; at += 1) {
    const cost = count(`${parts[at]!.text}\n\n`);
    if (cost > left) break;
    kept.push(parts[at]!.text);
    left -= cost;
  }
  return { text: kept.join('\n\n'), missing: parts.slice(at).map((p) => p.head) };
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
    } catch (e) {
      // 無いのは普通。在るのに中を見られないのは、決まりが効いていないことを言う
      if (!isAbsent(e)) out.push(unreadableRule(dir, e));
      continue;
    }
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
  } catch (e) {
    // 無い。異常ではない。**在るのに読めないのは「無い」と読まない。**読むと、その作業場の決まりを知らないまま黙って反して書く
    return isAbsent(e) ? undefined : unreadableRule(rel, e);
  }
}

/** 読めなかった決まりを、それと分かる一件にする（モデルに、効いていないことが見える）。 */
function unreadableRule(rel: string, e: unknown): ProjectRule {
  const why = (e as NodeJS.ErrnoException).code ?? (e as Error).message;
  return { path: rel, text: `（${rel} を読めませんでした: ${why}。ここに書かれた決まりは、読めるようになるまで効いていません）`, at: 0 };
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

  /** いま効いている決まりを、コンテキストウィンドウに収まる形で。入らなかった見出しも返す。 */
  async blockWithDropped(
    budget: number, now = Date.now(), count?: Count,
  ): Promise<{ text: string; dropped: string[] }> {
    const c = count ?? estimateTokens;
    const rules = await this.all(now);
    if (rules.length === 0 || budget <= 0) return { text: '', dropped: [] };
    const frame = c(rulesBlock([{ ...rules[0]!, text: '' }]));
    const { kept, dropped } = fitRulesWithDropped(rules, Math.max(0, budget - frame), c);
    const made = rulesBlock(kept);
    if (c(made) > budget) return { text: '', dropped: rules.map((r) => r.path) };
    return { text: made, dropped };
  }

  /** いま効いている決まりを、窓に収まる形で。 */
  async block(budget: number, now = Date.now(), count?: Count): Promise<string> {
    const c = count ?? estimateTokens;
    const rules = await this.all(now);
    if (rules.length === 0 || budget <= 0) return '';
    /*
     * **囲みの分も窓を食う。**見出し・区切り・締めの二文で 100 前後ある。
     * 中身だけ数えていたので、132 と渡されて 237 返していた（実測）。
     * 渡した側は残りが在ると思って次を組むので、**後ろに置いたものが
     * 丸ごと落ちる**（作業場の地図が、どの窓でも 0 になった）。
     */
    const frame = c(rulesBlock([{ ...rules[0]!, text: '' }]));
    const made = rulesBlock(fitRules(rules, Math.max(0, budget - frame), c));
    // 組み上げてから、もう一度測る。超えていたら載せない
    // （途中で切れた決まりは、書いていないより悪いことがある）。
    return c(made) <= budget ? made : '';
  }
}
