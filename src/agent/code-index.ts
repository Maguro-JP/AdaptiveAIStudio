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
import { Ignores } from './ignore.ts';

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

/**
 * 索引に入れるファイル数の上限。大きな木で無限に時間を使わない。
 *
 * **切ったことは必ず言う**（`capped`）。黙って切ると、入っていないものが
 * 「無い」と返り、無いと言われた側はコードが無いのだと思う。
 * 試験から差し替えられるようにしてある（本物の大きさを作るのは高い）。
 */
export const MAX_FILES = 4000;

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

export interface Symbol {
  name: string;
  line: number;
  /**
   * **地図に載せてよい名前か。**
   *
   * 関数・クラス・型・メソッド、および export した定数。
   * 関数の中の `const buf = ...` のような一時の名前は落とす。
   * 探すとき（`search_text` の代わり）には一時の名前も要るので、索引からは
   * 消さず、印だけ付ける。実際に印を付けずに地図を作ったら、
   * **上位が `push` `buf` `out` で埋まった。**
   */
  top?: boolean;
  /**
   * **外から使える名前か。**
   *
   * 他のファイルから参照されうるのは、これだけ。ファイルの中だけの
   * 補助関数（`function describe(e)` のような）まで繋ぐと、
   * `node:fs` から入れた `stat` や、試験の `describe` が、たまたま同じ名前の
   * 私的な関数への参照として数えられる。**上位がその手の名前で埋まった**
   * ので、繋ぐのは外に出しているものだけにした。
   */
  exported?: boolean;
}

/**
 * ファイルの中で**使われている**名前。
 *
 * 定義（`symbols`）だけでは、どのファイルが大事かを決められない。
 * 「どこから呼ばれているか」が要る。**呼ばれている数が多いものほど、
 * そのコードの背骨**で、先に見せる価値がある。
 *
 * 数え上げではなく**在るかどうか**にしてある。同じ行を百回書いた
 * ファイルが、他のファイル百個から呼ばれているのと同じ重みになるのは
 * おかしい。
 */
export type Refs = string[];
export interface FileEntry {
  path: string;
  size: number;
  mtimeMs: number;
  symbols: Symbol[];
  /** この中で使われている名前（定義ではなく、呼んでいる側）。 */
  refs?: Refs;
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
  /**
   * 上限に当たって、索引に入れなかったファイルの数。
   *
   * **黙って切らない。**入っていないものは「無い」と返る。無いと言われた側は
   * コードが無いのだと思う。**静かに間違った答えを返すのが、いちばん悪い。**
   */
  capped?: number;
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

/**
 * その行が、**地図に載せる値打ちのある定義**か。
 *
 * 関数・クラス・型・メソッドの宣言、または export した定数。
 * 中で使うだけの `const` は落とす（そこに用のある人はいない）。
 */
export function isTopDecl(line: string): boolean {
  if (/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s/.test(line)) return true;
  if (/^\s*(?:export\s+)?(?:abstract\s+)?class\s/.test(line)) return true;
  if (/^\s*(?:export\s+)?(?:interface|type|enum)\s/.test(line)) return true;
  if (/^\s*(?:async\s+)?def\s|^\s*class\s/.test(line)) return true;
  if (/^func\s|^type\s/.test(line)) return true;
  if (/^\s*(?:pub\s+)?(?:async\s+)?fn\s|^\s*(?:pub\s+)?(?:struct|enum|trait)\s/.test(line)) return true;
  // クラスの中のメソッド。深く入り込んだものは、たいてい中の細工。
  if (/^\s{2,4}(?:async\s+)?(?:static\s+)?[#a-zA-Z_$][\w$]*\s*\([^)]*\)\s*[:{]/.test(line)) return true;
  // export した定数は、外から使うために置いてある。
  if (/^export\s+(?:const|let|var)\s/.test(line)) return true;
  return false;
}

/**
 * その行が、**外から使える定義**か。
 *
 * 他のファイルから参照されうるのはこれだけ。中だけの補助は、名前が
 * ぶつかっても偶然でしかない。
 */
export function isExportedDecl(line: string): boolean {
  if (/^\s*export\s/.test(line)) return true;                       // TS / JS
  if (/^\s*(?:async\s+)?def\s|^class\s/.test(line)) return true;    // Python（頭に在れば外から入れられる）
  if (/^func\s+(?:\([^)]*\)\s*)?[A-Z]|^type\s+[A-Z]/.test(line)) return true; // Go（大文字が公開）
  if (/^\s*pub\s/.test(line)) return true;                          // Rust
  return false;
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

/**
 * ファイルの中で使われている名前を拾う。
 *
 * **注釈と文字列は外す。**日本語の注釈が多い置き場なので、そのままだと
 * 語ではないものまで名前として拾う。完全な構文解析はしない（tree-sitter を
 * 入れると実行時の依存が増える。ここは依存ゼロで通す）。
 * 取りこぼしはあるが、**どこから呼ばれているか**の傾きが分かればよい。
 *
 * 同じ名前を何度書いても一度と数える。同じ行を百回書いたファイルが、
 * 百個のファイルから呼ばれているのと同じ重みになるのはおかしい。
 *
 * **`.` の後ろは拾わない。**`arr.push(x)` の `push` は、どこかのファイルが
 * 定義した `push` を呼んでいるのではない。拾っていたときは、地図の上位が
 * `push` `path` `split` で埋まった（実測）。誰の物か分からない名前は、
 * 繋がりの手がかりにならない。
 */
export function refsIn(text: string): Refs {
  const stripped = text
    // 行の注釈と塊の注釈。文字列も落とす（中の語は名前ではない）。
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/^\s*#[^\n]*/gm, ' ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, ' ')
    .replace(/"(?:[^"\\\n]|\\.)*"/g, ' ')
    .replace(/`(?:[^`\\]|\\.)*`/g, ' ');
  const outside = importedFromPackages(text);
  const seen = new Set<string>();
  for (const m of stripped.matchAll(/(^|[^\w$.])([A-Za-z_$][\w$]*)/g)) {
    const name = m[2]!;
    // 一文字は雑音。予約語も外す。
    if (name.length < 3 || RESERVED.has(name) || COMMON.has(name)) continue;
    // **外から入れた名前は、この置き場の誰かを指してはいない。**
    if (outside.has(name)) continue;
    seen.add(name);
    if (seen.size >= 800) break;
  }
  return [...seen];
}

/**
 * 外（package や node: の中）から入れている名前。
 *
 * `import { describe } from 'node:test'` と書いたファイルの `describe` は、
 * この置き場の誰かの `describe` ではない。除かずに数えていたとき、
 * **地図のいちばん上が `cleanup.ts` の私的な `describe` になった**（実測）。
 * 相対の道（`./` `../`）から入れたものは、この置き場の中なので残す。
 */
export function importedFromPackages(text: string): Set<string> {
  const out = new Set<string>();
  const add = (names: string | undefined): void => {
    for (const part of (names ?? '').split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) out.add(name);
    }
  };
  for (const m of text.matchAll(/import\s+([^;'"]*?)\s*from\s*['"]([^'"]+)['"]/g)) {
    const spec = m[2] ?? '';
    if (spec.startsWith('.') || spec.startsWith('/')) continue;
    const clause = m[1] ?? '';
    add(/\{([^}]*)\}/.exec(clause)?.[1]);
    // `import x from 'pkg'` / `import * as x from 'pkg'`
    const bare = clause.replace(/\{[^}]*\}/g, '').replace(/\*\s*as\s*/g, '').trim();
    add(bare);
  }
  // Python の `from x import a, b`（相対は `.` で始まる）
  for (const m of text.matchAll(/^\s*from\s+([\w.]+)\s+import\s+([^\n#]+)/gm)) {
    if ((m[1] ?? '').startsWith('.')) continue;
    add(m[2]);
  }
  return out;
}

/**
 * どこにでも在る語。**在っても何も分からない**ので、繋がりとして数えない。
 * 拾うと、すべてのファイルがすべてのファイルと繋がってしまう。
 */
const COMMON = new Set([
  'true', 'false', 'null', 'undefined', 'this', 'self', 'super', 'void',
  'import', 'export', 'from', 'default', 'async', 'await', 'yield',
  'string', 'number', 'boolean', 'object', 'any', 'unknown', 'never',
  'public', 'private', 'protected', 'static', 'readonly', 'abstract',
  'interface', 'type', 'enum', 'struct', 'trait', 'impl', 'fn', 'def',
  'throw', 'finally', 'break', 'continue', 'case', 'delete', 'instanceof',
  'and', 'not', 'the', 'for', 'with', 'pub', 'use', 'mod', 'package',
]);

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
export async function buildIndex(root: string, max = MAX_FILES): Promise<CodeIndex> {
  const files: FileEntry[] = [];
  let skipped = 0;

  const walk = async (dir: string, depth: number, ign: Ignores): Promise<void> => {
    if (depth > 12 || files.length >= max) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (files.length >= max) return;
      if (e.name.startsWith('.') && e.name !== '.github') continue;
      const full = join(dir, e.name);
      // **その置き場が「見なくていい」と書いたものは、索引にも入れない。**
      // 生成物が索引に入ると、窓を食ううえ、直す先を間違える。
      const relHere = relative(root, full).split(sep).join('/');
      if (ign.ignores(relHere, e.isDirectory())) continue;
      if (e.isDirectory()) {
        if (SKIP.has(e.name)) continue;
        await walk(full, depth + 1, await ign.enter(relHere));
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
        const top = isTopDecl(line);
        const exported = top && isExportedDecl(line);
        for (const name of symbolsIn(line)) {
          symbols.push({
            name, line: i + 1,
            ...(top ? { top: true } : {}),
            ...(exported ? { exported: true } : {}),
          });
        }
      });
      files.push({
        path: rel, size: info.size, mtimeMs: info.mtimeMs, symbols,
        refs: refsIn(text),
        head: digestOf(text),
      });
    }
  };
  await walk(root, 0, await Ignores.load(root));
  files.sort((a, b) => a.path.localeCompare(b.path));
  // 上限で止めたなら、まだ残っている数を数えて言う（数えるだけなら安い）。
  const capped = files.length >= max ? await countSource(root) - files.length : 0;
  return {
    root, builtAt: new Date().toISOString(), files, skipped,
    ...(capped > 0 ? { capped } : {}),
  };
}

/**
 * 索引に入れうるファイルの数を数える。**中身は読まない。**
 *
 * 上限で切ったときに「あと何件あるか」を言うためだけに使う。
 * 名前を見るだけなので、組むのに比べればずっと安い。
 */
async function countSource(root: string): Promise<number> {
  let n = 0;
  const walk = async (dir: string, depth: number, ign: Ignores): Promise<void> => {
    if (depth > 12) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.github') continue;
      const full = join(dir, e.name);
      const rel = relative(root, full).split(sep).join('/');
      if (ign.ignores(rel, e.isDirectory())) continue;
      if (e.isDirectory()) {
        if (SKIP.has(e.name)) continue;
        await walk(full, depth + 1, await ign.enter(rel));
      } else if (e.isFile() && SOURCE.has(extname(e.name).toLowerCase())) n += 1;
    }
  };
  await walk(root, 0, await Ignores.load(root));
  return n;
}

/** 当たったところ。**切り取って返す。** */
/** コードのファイルか。文章（`.md` など）は、呼んでいる側に数えない。 */
function isCodePath(path: string): boolean {
  return /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|json|py|go|rs|java|kt|rb|php|cs|c|h|cc|cpp|hpp|swift|sh|bash|zsh|sql|vue|svelte)$/i
    .test(path);
}

/** 名前で引いた結果。 */
export interface SymbolLookup {
  /** どこで宣言されているか。 */
  defined: { path: string; line: number; exported: boolean }[];
  /** その名前を使っているファイル（宣言している所は除く）。 */
  used: string[];
  /** 見つからなかったとき、綴りの近いもの。 */
  near: string[];
}

/**
 * 名前を、そのまま引く。
 *
 * `find_code` は言葉から当てる道で、**名前がもう分かっているときには
 * 遠回り**になる。関数名が分かっているのに、点数の高い順に 8 ファイル
 * 読まされて、その中に無ければ諦める——実際にそうなる。
 *
 * 索引には名前と行が既に入っているので、引くだけで済む。
 * 大文字小文字は、まず厳密に。当たらなければ落として当てる（`ok` と `OK`）。
 * それでも無ければ、**綴りの近いものを出す。**「無い」で終わると、
 * 打ち間違いなのか本当に無いのかが分からない。
 */
export function lookupSymbol(index: CodeIndex, name: string): SymbolLookup {
  const wanted = name.trim();
  if (wanted === '') return { defined: [], used: [], near: [] };

  const pick = (eq: (a: string) => boolean): SymbolLookup['defined'] => {
    const out: SymbolLookup['defined'] = [];
    for (const f of index.files) {
      for (const sym of f.symbols) {
        if (!eq(sym.name)) continue;
        out.push({ path: f.path, line: sym.line, exported: sym.exported === true });
      }
    }
    return out;
  };

  let defined = pick((a) => a === wanted);
  const lower = wanted.toLowerCase();
  if (defined.length === 0) defined = pick((a) => a.toLowerCase() === lower);

  const definedIn = new Set(defined.map((d) => d.path));
  const used: string[] = [];
  for (const f of index.files) {
    if (definedIn.has(f.path)) continue;
    // **文章に出てくるのは「使っている」ではない。**索引には `.md` も入って
    // いるので、そのままだと決めごとの文書が使用箇所として並ぶ（実際に
    // `docs/DECISIONS.md` が出た）。呼んでいる側だけを返す。
    if (!isCodePath(f.path)) continue;
    if ((f.refs ?? []).some((r) => r === wanted || r.toLowerCase() === lower)) used.push(f.path);
  }

  /*
   * 近い名前。
   *
   * 最初は「含む」だけで見ていた。**短い名前が何にでも当たる。**
   * `loadConfg` と打ったのに出たのは `load, on, lo` で、肝心の
   * `loadConfig` は出なかった（含む関係に無いため）。打ち間違いの多くは
   * 一文字足りない・多い・入れ替わりなので、**頭からどこまで同じか**で見る。
   */
  const near: string[] = [];
  if (defined.length === 0) {
    const scored = new Map<string, number>();
    for (const f of index.files) {
      for (const sym of f.symbols) {
        const a = sym.name.toLowerCase();
        if (Math.abs(a.length - lower.length) > 3) continue;
        let same = 0;
        while (same < a.length && same < lower.length && a[same] === lower[same]) same += 1;
        if (same < Math.max(3, Math.floor(lower.length * 0.5))) continue;
        const best = scored.get(sym.name);
        if (best === undefined || same > best) scored.set(sym.name, same);
      }
    }
    near.push(...[...scored.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([n]) => n));
  }

  // 宣言は、外に出しているものを先に。呼ぶ側が知りたいのはたいていそちら。
  defined.sort((a, b) => (a.exported === b.exported ? a.path.localeCompare(b.path) : a.exported ? -1 : 1));
  used.sort();
  return { defined, used, near };
}

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
/**
 * 依頼と、どのファイルがどれだけ近いか。**探す道具と地図で、同じ付け方を使う。**
 *
 * ここを切り出す前は、探す道具（`searchIndex`）と地図の起点（`seedFrom`）が
 * **別々の当て方**を持っていた。地図の側は日本語を二文字ずつに割って冒頭と
 * 突き合わせるだけの、弱いものだった。同じことを二通りに書くと、良いほうの
 * 直しがもう片方に届かない。
 *
 * 付け方は三方向。名前・道・中身。珍しい語ほど重く（idf）、何度も出るほど
 * 重く（頭打ちあり）、**多くの語に当たったものほど重く**する。
 */
export function scoreFiles(index: CodeIndex, query: string): Map<number, { score: number; symbols: Symbol[] }> {
  const out = new Map<number, { score: number; symbols: Symbol[] }>();
  const words = terms(query);
  if (words.length === 0) return out;
  const lower = words.map((w) => w.toLowerCase());

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

  index.files.forEach((f, fi) => {
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
    if (score === 0) return;
    // 多くの語に当たる方が確か。一語で何度も当たるより。
    score *= covered.size;
    // 散文は下げる。読み物として要るが、直す先ではない。
    if (PROSE.has(extname(f.path).toLowerCase())) score /= 3;
    out.set(fi, { score, symbols: hitSymbols });
  });
  return out;
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

  const scored: Hit[] = [];
  for (const [fi, { score, symbols }] of scoreFiles(index, query)) {
    scored.push({
      path: index.files[fi]!.path, score: Math.round(score * 10) / 10,
      symbols: dedupe(symbols).slice(0, 6), lines: [],
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
  /**
   * いま持っている索引。**引くたびにディスクから読み直さない。**
   *
   * 4000 ファイルで 3.4MB ある。引くたびに読んで組み直すと、それだけで
   * 100ms 近く払う。**探すところで払うと、直すところまで辿り着けない。**
   */
  #held?: CodeIndex;

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
  async fresh(root: string, maxAgeMs = 5 * 60_000, now = Date.now()): Promise<CodeIndex> {
    const usable = (x: CodeIndex | undefined): x is CodeIndex =>
      !!x && x.root === root && now - new Date(x.builtAt).getTime() < maxAgeMs;
    if (usable(this.#held)) return this.#held;
    const had = await this.load(root);
    if (usable(had)) { this.#held = had; return had; }
    const made = await buildIndex(root);
    this.#held = made;
    await this.save(made).catch(() => undefined);
    return made;
  }
}
