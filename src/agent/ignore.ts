/**
 * `.gitignore` を読んで、見ない場所を決める。
 *
 * ここまで、見ない場所は**名前の決め打ち**だった（`node_modules` `dist` …）。
 * 決め打ちなので、その置き場が実際に何を無視しているかとは関係が無い。
 *
 *   - 生成物が索引に入る。**窓を食う**うえ、直す先を間違える
 *     （生成されたファイルを直しても、次の生成で消える）
 *   - `.terraform` `target` `__generated__` のような、置き場ごとの名前は素通り
 *   - 逆に、無視されていない `dist` を勝手に見ないことがある
 *
 * その置き場が「見なくていい」と書いてあるものを、そのまま使う。
 * **こちらで名前を足さない。**
 *
 * 外の物を足さずに書く（実行時の依存はゼロ）。git の決まりのうち、
 * 実際に効くところを実装する。
 *
 * | 書き方 | 意味 |
 * |---|---|
 * | `build/` | ディレクトリだけ |
 * | `/build` | その場所の直下だけ |
 * | `*.log` | どの深さでも |
 * | `!keep.log` | 打ち消す（後の行が勝つ） |
 * | `**` | 深さをまたぐ |
 * | `#` | 注釈 |
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

interface Rule {
  /** `!` 付き。**後の行が勝つ**ので、当たった中でいちばん後ろを見る。 */
  negate: boolean;
  /** 末尾が `/`。ディレクトリにしか当たらない。 */
  dirOnly: boolean;
  re: RegExp;
}

/** 一行を規則に直す。注釈と空行は捨てる。 */
function ruleFrom(raw: string): Rule | undefined {
  let line = raw;
  // 行末の空白は無視される（`\ ` で守られているものを除く）。git が削るのは空白だけで、タブは名前の一部として残る
  line = line.replace(/(?<!\\) +$/, '');
  if (line.length === 0 || line.startsWith('#')) return undefined;

  let negate = false;
  if (line.startsWith('!')) { negate = true; line = line.slice(1); }
  else if (line.startsWith('\\#') || line.startsWith('\\!')) line = line.slice(1);
  if (line.length === 0) return undefined;

  let dirOnly = false;
  if (line.endsWith('/')) { dirOnly = true; line = line.slice(0, -1); }
  if (line.length === 0) return undefined;

  // 途中に `/` があるなら、その場所からの道として読む。無ければ名前として
  // 読み、どの深さでも当てる。
  const anchored = line.slice(0, -1).includes('/') || line.startsWith('/');
  if (line.startsWith('/')) line = line.slice(1);

  const body = toRegex(line);
  const head = anchored ? '' : '(?:.*/)?';
  return { negate, dirOnly, re: new RegExp(`^${head}${body}$`) };
}

/** 書き方を正規表現へ。`*` は `/` を跨がない。`**` は跨ぐ。 */
function toRegex(pattern: string): string {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i]!;
    if (c === '\\') { out += escape(pattern[i + 1] ?? '\\'); i += 1; continue; }
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` は「0段以上」。末尾の `**` は「この下すべて」。
        if (pattern[i + 2] === '/') { out += '(?:.*/)?'; i += 2; continue; }
        out += '.*'; i += 1; continue;
      }
      out += '[^/]*';
      continue;
    }
    if (c === '?') { out += '[^/]'; continue; }
    if (c === '[') {
      const close = pattern.indexOf(']', i + 1);
      if (close > i) { out += pattern.slice(i, close + 1).replace('[!', '[^'); i = close; continue; }
      out += '\\[';
      continue;
    }
    out += escape(c);
  }
  // その下は、祖先のフォルダが当たるかで見る（`ignores`）。ここで「その下も全部」を足すと、`/*` が `src/a.ts` そのものにも当たり、
  // `!/src/` で戻したフォルダの中身まで無視していた（「全部無視して src だけ戻す」書き方で一覧が空になった）
  return out;
}

function escape(c: string): string {
  // `\[` `\]` `\*` `\?` で書かれた字も、その字そのものとして当てる（`[` が文字の組の始まりとして残っていた）
  return /[.+^${}()|\\[\]*?]/.test(c) ? `\\${c}` : c;
}

/** 一枚ぶんの決まり（一つの `.gitignore` とその効く範囲）。 */
interface Layer {
  /** 置き場の根からの相対。空なら根そのもの。 */
  base: string;
  rules: Rule[];
}

export function parseIgnore(text: string): Rule[] {
  const rules: Rule[] = [];
  // 頭の BOM は落とす（メモ帳の古い版や PowerShell 5.1 が付ける。付いたままだと 1 行目の規則がどこにも当たらず、git が無視するものを索引と一覧に拾っていた）
  for (const line of text.replace(/^\uFEFF/, '').split('\n')) {
    const rule = ruleFrom(line.replace(/\r$/, ''));
    if (rule) rules.push(rule);
  }
  return rules;
}

/**
 * 見ない場所の判定。**木を降りながら重ねる。**
 *
 * `.gitignore` は置いてある所から下にだけ効く。降りるたびに `enter` して、
 * その階の決まりを重ねたものを使う。
 */
export class Ignores {
  readonly #layers: readonly Layer[];
  readonly #root: string;

  private constructor(root: string, layers: readonly Layer[]) {
    this.#root = root;
    this.#layers = layers;
  }

  /** 何も無い状態。置き場に `.gitignore` が無いときはこれで通る。 */
  static none(root = ''): Ignores {
    return new Ignores(root, []);
  }

  /** 置き場の根から始める。`.git/info/exclude` も、在れば効かせる。 */
  static async load(root: string): Promise<Ignores> {
    let self = new Ignores(root, []);
    const exclude = await read(join(root, '.git', 'info', 'exclude'));
    if (exclude) self = new Ignores(root, [{ base: '', rules: parseIgnore(exclude) }]);
    return self.enter('');
  }

  /** その階の `.gitignore` を重ねたものを返す。無ければそのまま。 */
  async enter(rel: string): Promise<Ignores> {
    const text = await read(join(this.#root, rel, '.gitignore'));
    if (!text) return this;
    const rules = parseIgnore(text);
    if (rules.length === 0) return this;
    return new Ignores(this.#root, [...this.#layers, { base: rel, rules }]);
  }

  /**
   * 見ないか。**後に書かれた行が勝つ。**
   *
   * `rel` は置き場の根からの相対（区切りは `/`）。
   */
  ignores(rel: string, isDir: boolean): boolean {
    // git と同じく、祖先のフォルダが無視されていれば、その下は戻せない。祖先が無視されていなければ、道そのものに規則を当てる
    const parts = rel.split('/');
    for (let k = 1; k < parts.length; k += 1) {
      if (this.#match(parts.slice(0, k).join('/'), true)) return true;
    }
    return this.#match(rel, isDir);
  }

  #match(rel: string, isDir: boolean): boolean {
    let hit: boolean | undefined;
    for (const layer of this.#layers) {
      const within = under(rel, layer.base);
      if (within === undefined) continue;
      for (const rule of layer.rules) {
        if (rule.dirOnly && !isDir) continue;
        if (!rule.re.test(within)) continue;
        hit = !rule.negate;
      }
    }
    return hit === true;
  }
}

/** `base` の下にあるなら、そこからの相対を返す。無ければ undefined。 */
function under(rel: string, base: string): string | undefined {
  if (base === '') return rel;
  if (rel === base) return '';
  return rel.startsWith(`${base}/`) ? rel.slice(base.length + 1) : undefined;
}

async function read(path: string): Promise<string | undefined> {
  try { return await readFile(path, 'utf8'); } catch { return undefined; }
}
