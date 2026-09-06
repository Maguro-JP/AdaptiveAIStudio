/**
 * 作業場の地図 — **どこに何が在るかを、先に渡す。**
 *
 * ここまで、モデルは何も知らないところから始めていた。「設定を直して」と
 * 言われて、まず `list_files` で歩き、`search_text` で総当たりし、
 * 見当違いのファイルを何枚も開く。**探すところで窓を使い切って、
 * 直すところまで辿り着かない。**手元の小さいモデルではこれが致命傷になる。
 *
 * Aider の repo map から借りた考えを、依存ゼロで作り直したもの。
 * 向こうは tree-sitter で構文木を取り、networkx で PageRank を回す。
 * ここは**どちらも入れられない**（実行時の依存はゼロ、という前提）ので、
 *
 *   ・構文木の代わりに、既にある索引の「定義」と「使っている名前」
 *   ・networkx の代わりに、べき乗法を自分で回す（20行）
 *
 * で同じ形にしてある。
 *
 * ## なぜ「呼ばれている数」で並べるのか
 *
 * ファイル名の順でも、更新の新しい順でもない。**繋がりで並べる。**
 * 20 個のファイルから呼ばれている関数は、一度しか呼ばれない補助関数より
 * 大事で、しかも**大事なものから呼ばれているものは、それ自体も大事**。
 * これは PageRank がそのまま効く形になっている。
 *
 * ## いま何を頼まれているかで、地図が変わる
 *
 * 「認証を直して」と言われたら、認証の周りが濃い地図が要る。
 * 依頼に出てくる名前・道を起点（personalization）にして回す。
 * 起点が無ければ、素の PageRank に戻る（全体の背骨が出る）。
 *
 * 出すものは**窓から決める**。決め打ちの文字数にすると、狭い窓では
 * 地図だけで溢れる。
 */
import type { CodeIndex } from './code-index.ts';

/** 一つの見出し。「このファイルの、この行に、この名前が在る」。 */
export interface MapEntry {
  path: string;
  line: number;
  name: string;
  /** 並べるための点。大きいほど先に出す。 */
  score: number;
}

/** 減衰。PageRank の作法どおり 0.85。 */
const DAMPING = 0.85;
/** 回す数。この大きさなら 20 回で十分に落ち着く。 */
const ROUNDS = 20;

/**
 * 名前 → その名前を定義しているファイル。
 *
 * **どこにでも在る名前は、繋がりとして数えない。**`get` や `run` のような
 * 名前は 30 個のファイルが定義していることがあり、そこを繋ぐと
 * すべてがすべてと繋がって、地図が真っ黒になる。
 */
const TOO_COMMON = 12;

interface Graph {
  /** ファイルの並び（添字が節点の番号）。 */
  files: string[];
  /** from → [to, 重み] の並び。 */
  out: Map<number, Map<number, number>>;
  /** 名前 → 定義しているファイルの添字 */
  definers: Map<string, number[]>;
  /** 名前 → 呼んでいるファイルの数 */
  callers: Map<string, number>;
}

/**
 * 索引から、繋がりの図を組む。
 *
 * A が使っている名前を B が定義しているなら、**A から B へ**辺を張る。
 * 重みは `1 / √(定義しているファイルの数)`。同じ名前を何枚も定義して
 * いるなら、その繋がりは薄い（どれを指しているか分からない）。
 */
export function graphOf(index: CodeIndex): Graph {
  const files = index.files.map((f) => f.path);
  const at = new Map(files.map((p, i) => [p, i]));
  const definers = new Map<string, number[]>();
  for (const f of index.files) {
    const i = at.get(f.path)!;
    for (const s of f.symbols) {
      // **外に出している名前だけを繋ぐ。**中だけの補助まで繋ぐと、
      // `node:fs` から入れた `stat` や試験の `describe` が、たまたま同じ名前の
      // 私的な関数への参照として数えられ、順位が意味を失う（実測）。
      if (!s.exported) continue;
      const list = definers.get(s.name);
      if (list) { if (!list.includes(i)) list.push(i); } else definers.set(s.name, [i]);
    }
  }

  const out = new Map<number, Map<number, number>>();
  const callers = new Map<string, number>();
  for (const f of index.files) {
    const from = at.get(f.path)!;
    for (const name of f.refs ?? []) {
      const defs = definers.get(name);
      if (!defs || defs.length > TOO_COMMON) continue;
      const weight = 1 / Math.sqrt(defs.length);
      let counted = false;
      for (const to of defs) {
        if (to === from) continue;
        counted = true;
        const edges = out.get(from) ?? new Map<number, number>();
        edges.set(to, (edges.get(to) ?? 0) + weight);
        out.set(from, edges);
      }
      if (counted) callers.set(name, (callers.get(name) ?? 0) + 1);
    }
  }
  return { files, out, definers, callers };
}

/**
 * PageRank をべき乗法で回す。
 *
 * `seed` は起点（personalization）。いま頼まれていることに近いファイルへ
 * 重みを寄せる。空なら全体へ均等に置く（素の PageRank）。
 *
 * **行き止まり（どこも呼んでいないファイル）の分を捨てない。**捨てると
 * 合計が 1 から落ち続けて、点が全部小さくなり、順位の差が潰れる。
 */
export function pageRank(g: Graph, seed: Map<number, number> = new Map()): number[] {
  const n = g.files.length;
  if (n === 0) return [];
  const base = new Array<number>(n).fill(0);
  let total = 0;
  for (const [i, w] of seed) if (i >= 0 && i < n && w > 0) { base[i] = w; total += w; }
  if (total === 0) { base.fill(1 / n); } else { for (let i = 0; i < n; i += 1) base[i]! /= total; }

  let rank = base.slice();
  for (let round = 0; round < ROUNDS; round += 1) {
    const next = new Array<number>(n).fill(0);
    let dangling = 0;
    for (let i = 0; i < n; i += 1) {
      const edges = g.out.get(i);
      if (!edges || edges.size === 0) { dangling += rank[i]!; continue; }
      let sum = 0;
      for (const w of edges.values()) sum += w;
      for (const [to, w] of edges) next[to]! += rank[i]! * (w / sum);
    }
    for (let i = 0; i < n; i += 1) {
      next[i] = (1 - DAMPING) * base[i]! + DAMPING * (next[i]! + dangling * base[i]!);
    }
    rank = next;
  }
  return rank;
}

/**
 * ファイルの点を、その中の定義へ配る。
 *
 * ファイル単位で出すと「このファイルが大事」までしか言えない。
 * **人もモデルも、名前で探す。**呼ばれている数に比例して配る
 * （そのファイルの中でも、外から呼ばれているものが先に出る）。
 */
export function rankedEntries(index: CodeIndex, seed: Map<number, number> = new Map()): MapEntry[] {
  const g = graphOf(index);
  const rank = pageRank(g, seed);
  const out: MapEntry[] = [];
  index.files.forEach((f, i) => {
    const share = rank[i] ?? 0;
    const tops = f.symbols.filter((s) => s.exported);
    if (share <= 0 || tops.length === 0) return;
    // そのファイルの中の重み。外から呼ばれている数で割る。
    const weights = tops.map((s) => 1 + (g.callers.get(s.name) ?? 0));
    const sum = weights.reduce((a, b) => a + b, 0);
    tops.forEach((s, k) => {
      out.push({ path: f.path, line: s.line, name: s.name, score: share * (weights[k]! / sum) });
    });
  });
  return out.sort((a, b) => (b.score - a.score) || a.path.localeCompare(b.path) || a.line - b.line);
}

/**
 * 起点を作る。
 *
 * いまの依頼に出てくる語と、話に出たファイルへ寄せる。
 * **道の一部でも当てる。**「server を直して」で `src/ui/server.ts` に
 * 当たらないと、起点として役に立たない。
 */
export function seedFrom(index: CodeIndex, text: string, files: readonly string[] = []): Map<number, number> {
  const seed = new Map<number, number>();
  const words = new Set(
    (text.toLowerCase().match(/[a-z_$][\w$./-]{2,}/g) ?? []).map((w) => w.replace(/[.,]+$/, '')),
  );
  // **日本語でも当てる。**この置き場の利用者は日本語で頼む。英字の語だけを
  // 見ていたときは、「添付を窓に合わせて切りたい」で起点が一つも立たず、
  // 素の PageRank と同じ地図が出た（実測）。
  // 注釈は索引の `head` に入っているので、そこと二文字ずつで突き合わせる。
  // **珍しい断片だけを使う。**「文字」「窓の」のような、どの注釈にも在る
  // 断片まで数えると、どのファイルにも薄く点が付き、英字で当たった強い印が
  // 埋もれる（`undo を直したい` で `UndoStore` が一位から落ちた。実測）。
  const rare = rareBits(japaneseBits(text), index);
  index.files.forEach((f, i) => {
    let w = 0;
    const low = f.path.toLowerCase();
    // 話に出たファイルは、いちばん強い起点。
    if (files.includes(f.path)) w += 8;
    for (const word of words) {
      if (word.includes('/') ? low.includes(word) : low.includes(`/${word}`) || low.endsWith(word)) w += 3;
    }
    for (const s of f.symbols) if (s.exported && words.has(s.name.toLowerCase())) w += 2;
    if (rare.length > 0) {
      let hit = 0;
      for (const bit of rare) if (f.head.includes(bit)) hit += 1;
      // 当たった割合で見る。長い注釈のファイルが、当たり数だけで勝たないように。
      if (hit > 0) w += 4 * (hit / rare.length);
    }
    if (w > 0) seed.set(i, w);
  });
  return seed;
}

/**
 * 日本語を、二文字ずつに割る。
 *
 * 語に割るには辞書が要る（実行時の依存はゼロ、という前提なので入れない）。
 * 二文字ずつなら「添付」「付を」…と重なりで拾えて、辞書なしで当たる。
 * 助詞だけの断片は当たっても意味が無いので落とす。
 */
function japaneseBits(text: string): string[] {
  const out = new Set<string>();
  for (const run of text.match(/[ぁ-んァ-ヶ一-龠々ー]{2,}/g) ?? []) {
    for (let i = 0; i + 2 <= run.length; i += 1) {
      const bit = run.slice(i, i + 2);
      if (!PARTICLES.has(bit)) out.add(bit);
    }
  }
  return [...out];
}

/**
 * どのファイルにも在る断片を落とす。
 *
 * 全体の 1 割より多くのファイルに在る断片は、在っても何も分からない。
 * 探す言葉としては、珍しいものほど効く。
 */
function rareBits(bits: readonly string[], index: CodeIndex): string[] {
  if (bits.length === 0 || index.files.length === 0) return [];
  const limit = Math.max(2, Math.floor(index.files.length * 0.1));
  return bits.filter((bit) => {
    let seen = 0;
    for (const f of index.files) {
      if (f.head.includes(bit)) { seen += 1; if (seen > limit) return false; }
    }
    return seen > 0;
  });
}

/** 助詞ばかりの断片。どのファイルにも在るので、当たっても何も分からない。 */
const PARTICLES = new Set([
  'した', 'して', 'する', 'され', 'れる', 'ている', 'てい', 'いる', 'ます', 'から',
  'こと', 'もの', 'ため', 'とき', 'ない', 'たい', 'よう', 'その', 'この', 'あと',
]);

/**
 * 地図を、渡せる形にする。
 *
 * **窓から決めた分だけ出す。**決め打ちの文字数にすると、狭い窓では
 * 地図だけで溢れる（添付と指名で同じことをして、実際に溢れた）。
 * 入り切らなかったことは言う。黙って切ると、載っていないものを
 * 「無い」と思わせる。
 */
export function renderMap(
  entries: readonly MapEntry[],
  budget: { chars: number },
  count = (t: string) => t.length,
): string {
  if (entries.length === 0) return '';
  const byFile = new Map<string, MapEntry[]>();
  for (const e of entries) {
    const list = byFile.get(e.path);
    if (list) { if (list.length < 40) list.push(e); } else byFile.set(e.path, [e]);
  }

  const head = '作業場の地図（呼ばれている数の多い順。行番号は定義の位置）:\n';
  const lines: string[] = [];
  let used = count(head);
  let left = 0;
  for (const [path, defs] of byFile) {
    const block = `${path}\n${defs.map((d) => `  ${d.line}: ${d.name}`).join('\n')}\n`;
    const cost = count(block);
    if (used + cost > budget.chars) { left += 1; continue; }
    used += cost;
    lines.push(block);
  }
  if (lines.length === 0) return '';
  const tail = left > 0
    ? `（ほか ${left} 個のファイルは載せていません。search_text と find_code で探せます）\n`
    : '';
  return head + lines.join('') + tail;
}
