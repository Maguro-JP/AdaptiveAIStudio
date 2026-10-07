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
import { scoreFiles, type CodeIndex } from './code-index.ts';

/** 一つの見出し。「このファイルの、この行に、この名前が在る」。 */
export interface MapEntry {
  path: string;
  line: number;
  name: string;
  /** 並べるための点。大きいほど先に出す。 */
  score: number;
  /**
   * 名前が無いファイルに添える一言。
   *
   * 試験・画面・入口・記録には、外へ出す名前が一つも無い。
   * 名前で示せないので、**何が書いてあるか**で示す。
   */
  note?: string;
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

/*
 * **入る辺を一律に薄めても、順位は変わらない（測って捨てた）。**
 *
 * 試験から張る辺を 1/4 にして、模型（`test/fake-llama-lib.ts`）を下げようとした。
 * 変わらなかった。PageRank は**その節点から出る辺の合計で割る**ので、
 * 一枚のファイルの辺を全部同じ率で薄めると、割った後は元に戻る。
 * 効かせたいなら、薄める率が同じファイルの中で**辺ごとに変わる**必要がある。
 *
 * 模型が頭に来ていた本当の原因は、こちらではなく
 * 「その場で名づけている名前を、よその同じ名前への参照として数えていた」
 * （`src/agent/code-index.ts` の `refsIn`）。そちらを直したら消えた。
 */

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
    /*
     * **点が 0 でも、並びの末尾には置く。**
     *
     * 起点を立てると、起点でもなく、どこからも呼ばれていないファイルは
     * 点がちょうど 0 になる。落としていたので、そういうファイルは地図から
     * **丸ごと消えていた**。記録（.md）・設定（.json）・画面（.html）・
     * 試験がこれに当たり、起点は依頼にほぼ必ず立つので、普段いつも消えていた。
     * 外した 245 個のうち 96 個がこれだった（実測）。
     *
     * 直し方として、起点に薄く下敷きを混ぜる（personalization を薄める）のは
     * **測ったうえで採らなかった**。狭い地図ほど悪くなる。0.01〜0.15 まで
     * 試して、2000 文字で 49.4% → 48.9〜47.4%。消えていたファイルは
     * どのみち狭い地図には入らないのに、寄せた分だけが薄まるため。
     *
     * ここでは点をいじらない。**順位はそのまま**にして、0 のものを
     * 末尾に並べるだけにする。狭ければ今までどおり入らず、広ければ入る。
     */
    if (share < 0) return;
    /*
     * **外へ出す名前が一つも無いファイルも、道だけは載せる。**
     *
     * 試験・画面（app.js / style.css / index.html）・入口（cli）・記録（.md）が
     * これに当たる。名前が無いという理由で外していたが、**直す先としては
     * これらがいちばん多い**。この置き場の履歴 200 commit で測ったところ、
     * 直した先の 58% が、地図に載りようが無いファイルだった。
     * 載らないものは、どれだけ並べ方を良くしても当たらない。
     *
     * 名前で示せないので、索引が持っている冒頭（`head`）を一言に切って添える。
     */
    if (tops.length === 0) {
      out.push({ path: f.path, line: 0, name: '', score: share, note: noteOf(f.head) });
      return;
    }
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
export function seedFrom(
  index: CodeIndex,
  text: string,
  files: readonly string[] = [],
  edited: readonly string[] = [],
  opts: { search?: boolean } = {},
): Map<number, number> {
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
    // 話に出たファイルは、強い起点。
    if (files.includes(f.path)) w += 8;
    /*
     * **直前に書き換えたファイルは、いちばん強い起点。**
     *
     * Cursor が近くの編集を手がかりにしているのを見て入れた。
     * 話に出た名前より強くするのは、話に出るのは「読んだだけ」も含むのに対し、
     * 書き換えたのは**そこを直している最中**だから。次の依頼（「まだ落ちる」
     * 「そこ直して」）にはファイル名が出てこないことの方が多い。
     * 新しいものほど強い（同じ 12 件でも、いま触ったものと十往復前は違う）。
     */
    const fresh = edited.indexOf(f.path);
    if (fresh >= 0) w += 12 - fresh * (6 / Math.max(1, edited.length));
    for (const word of words) {
      // 区切りの境目で当てる（`index.ts` が `code-index.ts` にも当たり、別のファイルまで強い seed にしていた）
      if (word.includes('/') ? low.includes(word) : low === word || low.endsWith(`/${word}`) || low.includes(`/${word}/`)) w += 3;
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

  /*
   * **探す道具と同じ当て方も足す。**
   *
   * ここまでの当て方（道の一部・名前・日本語を二文字ずつ）とは別に、
   * `search_text` が使っているものを重ねる。向こうは語で割り（漢字・カタカナの
   * 連なりを見る。二文字ずつではない）、珍しい語ほど重くし、多くの語に当たった
   * ものを上げる。**同じ仕事を二通りに書いていたので、良いほうが地図に
   * 届いていなかった。**
   *
   * 片方だけにすると 8000 文字で落ちる（81.3% → 79.8%）。重ねると両方より良い。
   * 大きさが揃っていないので、それぞれ最大 1 に均してから足す。
   */
  const found = opts.search === false ? new Map() : scoreFiles(index, text);
  if (found.size > 0) {
    let max = 0;
    for (const { score } of found.values()) if (score > max) max = score;
    if (max > 0) {
      for (const [i, { score }] of found) {
        seed.set(i, (seed.get(i) ?? 0) + SEARCH_SHARE * (score / max));
      }
    }
  }
  return seed;
}

/**
 * 重ねる分。
 *
 * 1.5〜4 のあいだは、どこを採ってもほとんど同じ（実測）。尖っていないので、
 * 真ん中の 2 を採る。0 にすると、探す道具の当て方が地図に届かない。
 */
const SEARCH_SHARE = 5;



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

/**
 * 冒頭を、一言に切る。
 *
 * 索引の `head` は注釈の冒頭なので、記号や飾りが混ざる。人が読んで
 * 何のファイルか分かる長さだけ残す。**長くしない**（地図の場所は狭い）。
 */
function noteOf(head: string): string {
  const text = head
    .replace(/^[\s*/#=-]+/, '')
    .replace(/[*`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length === 0) return '';
  /*
   * **中身がそのまま出るものには、何も添えない。**
   *
   * JSON には散文が無いので、冒頭を切ると
   * `{ "name": "adaptive-ai-studio", "version` が出る。何のファイルかは
   * 道の名前で既に分かっているので、これは狭い地図の場所を捨てているだけ。
   * 目で見て気づいた（数字には出ない）。
   */
  if (/^[{[]/.test(text)) return '';
  /*
   * **一言で切る。**題のあとに見出しが続くと
   * `組織設計 — …として動かす ## 0. 肩書きではなく気質` のように、
   * 途中で切れた見出しが混ざる。題のあとの区切りで止める。
   */
  let cut = text;
  for (const stop of ['。', ' ## ', ' # ', ' > ', ' ## ']) {
    const at = cut.indexOf(stop);
    if (at > 0) cut = cut.slice(0, at);
  }
  if (cut.length <= NOTE_LIMIT) return cut.trim();
  /*
   * 切るときは、切れ端を残さない。
   * 「…決めごと セッショ」の「セッショ」が出ると、読む側は続きを探す。
   * 区切りまで戻す。戻しすぎるくらいなら、そのまま切る。
   */
  const short = cut.slice(0, NOTE_LIMIT);
  let back = short.length;
  for (const mark of [' ', '、', '，']) {
    const at = short.lastIndexOf(mark);
    if (at > NOTE_LIMIT * 0.6) back = Math.min(back, at);
  }
  return short.slice(0, back).trim();
}

/** 一言の長さ。地図の場所は狭い。**長くしない。** */
const NOTE_LIMIT = 40;

/**
 * 「そこを直している」と言い切れる強さ。
 *
 * 道の一部が当たった（+3）以上。話に出た（+8）、直前に書き換えた（+12）は
 * これを越える。
 */
const STRONG = 3;

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
  const tailOf = (n: number) => `（ほか ${n} 個のファイルは載せていません。search_text と find_code で探せます）\n`;
  const blocks = [...byFile].map(([path, defs]) => {
    // 名前を出していないファイルは、道と一言だけ。行番号を書く先が無い。
    const first = defs[0]!;
    return first.name === ''
      ? `${path}${first.note ? `  — ${first.note}` : ''}\n`
      : `${path}\n${defs.map((d) => `  ${d.line}: ${d.name}`).join('\n')}\n`;
  });
  const costs = blocks.map(count);
  const whole = count(head) + costs.reduce((a, b) => a + b, 0);
  // 入り切らないときは、但し書きの分を先に取っておく（後から足すと、詰めた分だけ取り分を超え、システムプロンプトの組み立てで repo map が丸ごと落ちた）
  const room = whole <= budget.chars ? budget.chars : budget.chars - count(tailOf(blocks.length));
  const lines: string[] = [];
  let used = count(head);
  let left = 0;
  blocks.forEach((block, i) => {
    if (used + costs[i]! > room) { left += 1; return; }
    used += costs[i]!;
    lines.push(block);
  });
  if (lines.length === 0) return '';
  const tail = left > 0 ? tailOf(left) : '';
  return head + lines.join('') + tail;
}

/**
 * いまの地図で、**探している所が足りているか。**
 *
 * 足りているなら作り直さない（前置きが変わると、相手は履歴まで計算し直す）。
 * 足りていないなら作り直す。載っていない地図を使い回しても、探し回る往復が
 * 増えるだけで、計算し直すより高くつく。
 *
 * 見るのは「起点として強く立ったファイルが、地図に載っているか」。
 * 起点が一つも立っていないなら、いまの地図のままでよい。
 *
 * **渡す起点は、`search: false` で組んだものにする。**
 * 探す道具の当て方（語の珍しさで薄く広く当てる）は、並べるには効くが、
 * 「そこを直している」の判断には使えない。「そこ」「もう一度」のような
 * 短い依頼でも、たまたま珍しい語に当たったファイルが最上位に立つので、
 * それを地図に要求すると**毎往復かならず作り直す**ことになる
 * （7 往復で 7 回。実測）。ここで見るのは、道の名前・話に出た・
 * 直前に書き換えた、という言い切れる印だけ。
 */
export function covers(map: string, index: CodeIndex, seed: Map<number, number>): boolean {
  if (map.length === 0) return false;
  const wanted = [...seed.entries()]
    .filter(([, w]) => w >= STRONG)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([i]) => index.files[i]?.path)
    .filter((p): p is string => !!p);
  if (wanted.length === 0) return true;
  // 見出し（字下げの無い行。説明は `  — ` の後ろ）の道と、まるごと一致で比べる。文字の一部で見ていたので、`a.ts` が
  // `data.ts` や `a.ts.bak` に当たり、依頼のファイルがrepo map に無いまま作り直さなかった
  const heads = new Set(map.split('\n').filter((l) => l.length > 0 && !/^\s/.test(l)).map((l) => l.split('  — ')[0]!.trimEnd()));
  return wanted.every((p) => heads.has(p));
}
