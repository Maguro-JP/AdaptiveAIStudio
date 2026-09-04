/**
 * 作業場の索引 — **コードを見つけられるようにする。**
 *
 * ここまで、探す道具は `search_text`（完全一致の grep）だけだった。
 * 名前が分かっているなら足りる。**分かっていないときに何も出ない。**
 *
 *   「設定を保存している所」  → 該当なし
 *   「saveConfig」            → 出る
 *
 * 人は前者で訊く。小さいモデルも前者しか書けない。だから当てずっぽうに
 * ファイルを開いて回り、8k の窓を読み尽くして力尽きる。
 * **探すところで力尽きるので、直すところまで辿り着かない。**
 *
 * ここでやるのは三つ。
 *
 *   1. 名前を拾う（関数・クラス・型。どの行に在るかまで）
 *   2. 言葉で当てる（名前・道・中身の三方向から点を付ける）
 *   3. **切り取って返す**。ファイル丸ごとではなく、当たった行とその周り
 *
 * 3が要点。丸ごと返すと、それだけで窓が埋まる。
 */
import { readdir, readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { join, relative, sep, extname } from 'node:path';
import { createHash } from 'node:crypto';

/** 見に行かない場所。数が多く、開いても仕方がない。 */
const SKIP = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'target', '.next',
  '.venv', 'venv', '__pycache__', '.cache', 'coverage', 'vendor', '.gradle',
]);

/** 読む拡張子。分からないものは読まない（binary を掴むと遅くなるだけ）。 */
const SOURCE = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
  '.py', '.go', '.rs', '.java', '.kt', '.cs', '.rb', '.php', '.swift',
  '.c', '.h', '.cc', '.cpp', '.hpp', '.m', '.scala', '.sh', '.sql',
  '.css', '.scss', '.html', '.vue', '.svelte', '.md', '.json', '.yml', '.yaml', '.toml',
]);

/** 一つのファイルが大きすぎるなら、索引には入れない。 */
const MAX_FILE = 400_000;

/** 索引に入れるファイル数の上限。大きな木で無限に時間を使わない。 */
const MAX_FILES = 4000;

/** 索引に持つ「頭」の長さ。何のファイルかは、たいてい冒頭に書いてある。 */
const HEAD_CHARS = 600;

/**
 * 索引に持つ注釈の長さ。
 *
 * **意図は注釈に書いてある。**人が探すのは意図（「作業場を決めるところ」）で、
 * 名前（`defaultWorkRoot`）ではない。冒頭だけ見ていたので、ファイルの途中で
 * 説明されているものが沈んでいた。
 */
const NOTE_CHARS = 2400;

/**
 * 散文のファイル。**下げる。**
 *
 * 説明が書いてあるので、言葉では必ず当たる。だが直したいのはコードの方で、
 * 散文が上に来るとコードが押し出される（実際に、当たったものが全部 docs に
 * なった）。読み物として要るので落としはしない。順番を下げるだけ。
 */
const PROSE = new Set(['.md', '.txt', '.json', '.yml', '.yaml', '.toml']);

export interface Symbol { name: string; line: number }
export interface FileEntry {
  path: string;
  size: number;
  mtimeMs: number;
  symbols: Symbol[];
  /**
   * ファイルの頭。**そのファイルが何をするものか**が、たいていここに在る。
   *
   * 索引に入れておくと、探すたびに開き直さずに当てられる。
   * 開いてから当てていたので、上位に入らなかったファイルは中身を見られず、
   * 名前で当たらないもの（日本語の注釈で説明されているもの）が沈んでいた。
   */
  head: string;
}
export interface CodeIndex {
  root: string;
  builtAt: string;
  files: FileEntry[];
  /** 大きすぎる等で入れなかった数。**黙って落とさない。** */
  skipped: number;
}

/**
 * 名前の拾い方。
 *
 * **完璧を狙わない。**言語ごとの構文解析は要らない。名前と行が拾えれば、
 * 当てる目的には足りる。取りこぼしても、中身の当たりで拾える。
 */
const DECLS: RegExp[] = [
  // TS/JS
  /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
  /\b(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /\b(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
  /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]/,
  // クラスの中の関数。`  #name(` `  async name(` など
  /^\s{2,}(?:async\s+)?(?:static\s+)?[#a-zA-Z_$][\w$]*\s*\([^)]*\)\s*[:{]/,
  // Python
  /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/,
  /^\s*class\s+([A-Za-z_]\w*)/,
  // Go
  /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/,
  /^type\s+([A-Za-z_]\w*)/,
  // Rust
  /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/,
  /^\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/,
];

/**
 * 索引に持つ中身。**頭と、注釈。**
 *
 * 丸ごと持つと索引が重くなる。中身の全文が要るのは、当たった後に開くときだけ。
 */
export function digestOf(text: string): string {
  const head = text.slice(0, HEAD_CHARS);
  const notes: string[] = [];
  let n = 0;
  for (const line of text.split('\n')) {
    if (n > NOTE_CHARS) break;
    const t = line.trim();
    if (!/^(\/\/|\*|\/\*|#|--)/.test(t)) continue;
    const body = t.replace(/^(\/\/+|\*+|\/\*+|#+|--)\s?/, '').trim();
    if (body.length < 2) continue;
    notes.push(body);
    n += body.length;
  }
  return `${head} ${notes.join(' ')}`.replace(/\s+/g, ' ').slice(0, HEAD_CHARS + NOTE_CHARS);
}

/** 一行から名前を拾う。 */
export function symbolsIn(line: string): string[] {
  const out: string[] = [];
  for (const re of DECLS) {
    const m = re.exec(line);
    if (!m) continue;
    const name = m[1] ?? nameOfMethod(line);
    if (name && name.length > 1 && !RESERVED.has(name)) out.push(name);
  }
  return out;
}

/** `  async foo(a, b) {` から `foo` を取る。 */
function nameOfMethod(line: string): string | undefined {
  const m = /^\s{2,}(?:async\s+)?(?:static\s+)?([#a-zA-Z_$][\w$]*)\s*\(/.exec(line);
  const name = m?.[1]?.replace(/^#/, '');
  return name && !RESERVED.has(name) ? name : undefined;
}

/** 名前として拾っても意味の無いもの。 */
const RESERVED = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'class',
  'const', 'let', 'var', 'new', 'await', 'typeof', 'else', 'do', 'try',
]);

/** 作業場を歩いて、索引を作る。 */
export async function buildIndex(root: string): Promise<CodeIndex> {
  const files: FileEntry[] = [];
  let skipped = 0;

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 12 || files.length >= MAX_FILES) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (files.length >= MAX_FILES) return;
      if (e.name.startsWith('.') && e.name !== '.github') continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP.has(e.name)) continue;
        await walk(full, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      if (!SOURCE.has(extname(e.name).toLowerCase())) continue;
      let info;
      try { info = await stat(full); } catch { continue; }
      if (info.size > MAX_FILE) { skipped += 1; continue; }
      const rel = relative(root, full).split(sep).join('/');
      let text = '';
      try { text = await readFile(full, 'utf8'); } catch { skipped += 1; continue; }
      const symbols: Symbol[] = [];
      text.split('\n').forEach((line, i) => {
        if (symbols.length >= 200) return;
        for (const name of symbolsIn(line)) symbols.push({ name, line: i + 1 });
      });
      files.push({
        path: rel, size: info.size, mtimeMs: info.mtimeMs, symbols,
        head: digestOf(text),
      });
    }
  };
  await walk(root, 0);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { root, builtAt: new Date().toISOString(), files, skipped };
}

/** 当たったところ。**切り取って返す。** */
export interface Hit {
  path: string;
  /** 点。高いほど確からしい */
  score: number;
  /** 当たった名前 */
  symbols: Symbol[];
  /** 当たった行（行番号つき） */
  lines: { line: number; text: string }[];
}

/**
 * 言葉を、当てるための語に割る。
 *
 * **形態素解析は持ち込まない**（実行時の依存を増やさない）。代わりに、
 * 日本語は**ひらがなで切る**。助詞と語尾はひらがなで、意味を持つのは
 * 漢字とカタカナの連なりなので、それだけを残せば当たる。
 *
 *   「設定を保存している所」→ 設定 / 保存
 *   「作業場を決めるところ」→ 作業場
 *
 * 割らずに一語のまま当てていたので、この形の問いに**何も出なかった**。
 * 人はこう訊く。小さいモデルもこう書く。
 */
export function terms(query: string): string[] {
  const out: string[] = [];
  for (const raw of query.split(/[\s、。,.:;!?()（）「」『』[\]{}<>"'`|/\\]+/)) {
    const t = raw.trim();
    if (t.length < 2) continue;
    out.push(t);
    // camelCase / snake_case を割って、片方だけでも当たるようにする
    for (const part of t.split(/[_-]|(?<=[a-z0-9])(?=[A-Z])/)) {
      if (part.length >= 3 && part !== t) out.push(part.toLowerCase());
    }
  }
  // 漢字・カタカナの連なり。ひらがなが切れ目になる。
  // **丸ごとの句とは別に数える。**句は「取れた語」ではない
  // （句のままでは、そう書いてあるファイルにしか当たらない）。
  const atoms: string[] = [];
  for (const m of query.matchAll(/[\u4E00-\u9FFF\u3005]{2,}|[\u30A0-\u30FF\u30FC]{2,}/g)) {
    atoms.push(m[0]);
  }
  // 語が一つも取れないなら、一文字の漢字も採る（「道の長さ」など）。
  // よく出る字は、珍しさの重みで沈むので、雑音にはなりにくい。
  if (atoms.length === 0 && !/[A-Za-z0-9]{3,}/.test(query)) {
    for (const m of query.matchAll(/[\u4E00-\u9FFF]/g)) atoms.push(m[0]);
  }
  return [...new Set([...out, ...atoms])].slice(0, 14);
}

/**
 * 当てる。**名前・道・中身の三方向から点を付ける。**
 *
 * 名前が当たったものを上に出す（「どこで定義されているか」がいちばん要る）。
 */
export async function searchIndex(
  index: CodeIndex, query: string, opts: { limit?: number; read?: (p: string) => Promise<string> } = {},
): Promise<Hit[]> {
  const words = terms(query);
  if (words.length === 0) return [];
  const lower = words.map((w) => w.toLowerCase());
  const read = opts.read ?? ((p: string) => readFile(join(index.root, p), 'utf8'));

  // **語の珍しさで重みを付ける。**
  //
  // どの語も同じ重みにしていたので、「所」「設定」のような、どこにでも
  // 出る語が効いてしまい、当たりが散らかった（実際に散らかった）。
  // 少ないファイルにしか出ない語ほど、当たったときの確からしさが高い。
  const n = index.files.length;
  const weight = new Map<string, number>();
  for (const [i, w] of lower.entries()) {
    const original = words[i]!;
    let df = 0;
    for (const f of index.files) {
      if (f.path.toLowerCase().includes(w) || f.head.toLowerCase().includes(w)
        || f.head.includes(original) || f.symbols.some((s) => s.name.toLowerCase().includes(w))) df += 1;
    }
    // どこにでもある語は 0 に近づき、珍しい語は大きくなる。
    weight.set(w, Math.log((n + 1) / (df + 1)));
  }

  const scored: Hit[] = [];
  for (const f of index.files) {
    let score = 0;
    const hitSymbols: Symbol[] = [];
    const path = f.path.toLowerCase();
    const head = f.head.toLowerCase();
    const covered = new Set<string>();
    for (const [i, w] of lower.entries()) {
      const original = words[i]!;
      const iw = weight.get(w) ?? 1;
      if (iw <= 0.05) continue; // どこにでもある語は見ない
      let hit = false;
      if (path.includes(w)) { score += 4 * iw; hit = true; }
      // 頭と注釈で当てる。**意図は注釈に書いてある。**
      // **何度出たかも見る。**一度しか触れていないものと、そのファイルの主題に
      // なっているものを、同じ重みにしていた。ほとんどが同点になり、
      // 並びが元の順番のままになっていた（探す道具として意味を成さない）。
      const tf = count(head, w) + count(f.head, original);
      if (tf > 0) { score += 3 * iw * (1 + Math.log(Math.min(tf, 8))); hit = true; }
      for (const s of f.symbols) {
        const name = s.name.toLowerCase();
        if (name === w) { score += 12 * iw; hitSymbols.push(s); hit = true; }
        else if (name.includes(w) || w.includes(name)) { score += 6 * iw; hitSymbols.push(s); hit = true; }
      }
      if (hit) covered.add(w);
    }
    if (score === 0) continue;
    // 多くの語に当たる方が確か。一語で何度も当たるより。
    score *= covered.size;
    // 散文は下げる。読み物として要るが、直す先ではない。
    if (PROSE.has(extname(f.path).toLowerCase())) score /= 3;
    scored.push({
      path: f.path, score: Math.round(score * 10) / 10,
      symbols: dedupe(hitSymbols).slice(0, 6), lines: [],
    });
  }

  scored.sort((a, b) => b.score - a.score);
  const limit = opts.limit ?? 8;
  // 上位だけ開いて、当たった行を切り取る。**丸ごとは返さない。**
  const out: Hit[] = [];
  for (const hit of scored) {
    if (out.length >= limit) break;
    let text = '';
    try { text = await read(hit.path); } catch { continue; }
    const found: { line: number; text: string }[] = [];
    for (const [i, line] of text.split('\n').entries()) {
      if (found.length >= 4) break;
      const l = line.toLowerCase();
      if (words.some((w, k) => l.includes(lower[k]!) || line.includes(w))) {
        found.push({ line: i + 1, text: line.trim().slice(0, 200) });
      }
    }
    hit.lines = found;
    out.push(hit);
  }
  return out;
}

/** 何度出たか。数え切らない（多いものは、そこで足りる）。 */
function count(text: string, word: string): number {
  if (!word) return 0;
  let n = 0;
  let at = 0;
  for (;;) {
    const found = text.indexOf(word, at);
    if (found < 0 || n >= 8) break;
    n += 1;
    at = found + word.length;
  }
  return n;
}

function dedupe(list: Symbol[]): Symbol[] {
  const seen = new Set<string>();
  return list.filter((s) => {
    const k = `${s.name}:${s.line}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * 索引を置き場に覚える。
 *
 * 毎回歩き直すと、大きな木では数秒かかる。**触ったものだけ読み直す。**
 */
export class IndexStore {
  readonly #dir: string;
  constructor(dir: string) { this.#dir = dir; }

  #path(root: string): string {
    return join(this.#dir, `${createHash('sha256').update(root).digest('hex').slice(0, 16)}.json`);
  }

  async load(root: string): Promise<CodeIndex | undefined> {
    try {
      const raw = await readFile(this.#path(root), 'utf8');
      const parsed = JSON.parse(raw) as CodeIndex;
      return parsed.root === root ? parsed : undefined;
    } catch { return undefined; }
  }

  async save(index: CodeIndex): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    await writeFile(this.#path(index.root), JSON.stringify(index), 'utf8');
  }

  /**
   * 使える索引を出す。**古ければ作り直す。**
   *
   * 触った跡（mtime）で見る。合っていれば、そのまま使う。
   */
  async fresh(root: string, maxAgeMs = 5 * 60_000): Promise<CodeIndex> {
    const had = await this.load(root);
    if (had && Date.now() - new Date(had.builtAt).getTime() < maxAgeMs) return had;
    const made = await buildIndex(root);
    await this.save(made).catch(() => undefined);
    return made;
  }
}
