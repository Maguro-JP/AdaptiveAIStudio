/**
 * 本物の数え方。**当てずっぽうをやめる。**
 *
 * ここまで、トークン数は係数で見積もっていた（日本語1文字=1、他4文字=1）。
 * 窓に何を残して何を落とすかは、全部その見積もりの上に立っている。
 * ずれれば、落としてはいけないものを落とす。そのときモデルは、依頼を
 * 忘れた状態で答える。**画面からは「このモデルは馬鹿だ」に見える。**
 *
 * 数え方はモデルごとに違うが、**そのモデルのファイルの中に書いてある。**
 * GGUF の `tokenizer.ggml.*` に、語彙も、点数も、繋ぎ方（merges）も入っている。
 * 既に読んでいるのに、数を数えるだけに使っていた。使う。
 *
 * 外の物は足さない。llama.cpp が実際にやっていることを、そのまま書く。
 *
 * | `tokenizer.ggml.model` | やり方 |
 * |---|---|
 * | `llama` / `spm` | 点数の高い隣同士から繋いでいく。繋げない字はバイトに落とす |
 * | `gpt2` / `bpe` | バイトを字に写して、merges の順に繋いでいく |
 *
 * **合わないものは「分からない」と返す。**推測で数えない。
 * 分からないときは、これまでの見積もり（`estimateTokens`）に戻る。
 */

/** 数える人。**本物でも見積もりでも、呼ぶ側は同じ形で使う。** */
export interface Counter {
  count(text: string): number;
}

/** GGUF から取り出した、数えるのに要るものだけ。 */
export interface VocabSpec {
  /** `llama` `spm` `gpt2` `bpe` のいずれか。 */
  model: string;
  tokens: string[];
  /** SPM で使う。語彙と同じ長さ。 */
  scores?: number[];
  /** GGUF の token_type。6 がバイト。 */
  types?: number[];
  /** BPE で使う。`"a b"` の形。 */
  merges?: string[];
}

/** GGUF のメタデータから、数えるのに要るものを取り出す。 */
export function vocabFrom(md: Map<string, unknown>): VocabSpec | undefined {
  const model = md.get('tokenizer.ggml.model');
  const tokens = md.get('tokenizer.ggml.tokens');
  if (typeof model !== 'string' || !Array.isArray(tokens)) return undefined;
  if (!tokens.every((t) => typeof t === 'string')) return undefined;
  const scores = md.get('tokenizer.ggml.scores');
  const types = md.get('tokenizer.ggml.token_type');
  const merges = md.get('tokenizer.ggml.merges');
  return {
    model,
    tokens: tokens as string[],
    scores: numbers(scores),
    types: numbers(types),
    merges: Array.isArray(merges) && merges.every((m) => typeof m === 'string')
      ? (merges as string[]) : undefined,
  };
}

function numbers(v: unknown): number[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: number[] = [];
  for (const x of v) {
    const n = typeof x === 'bigint' ? Number(x) : x;
    if (typeof n !== 'number') return undefined;
    out.push(n);
  }
  return out;
}

/**
 * バイトを字に写す表（GPT-2 のもの）。
 *
 * バイトのままだと語彙に入れられないので、**目に見える字へ一対一で写す。**
 * 空白は `Ġ`、改行は `Ċ` になる、あれ。
 */
function byteToUnicode(): Map<number, string> {
  const bs: number[] = [];
  for (let b = 0x21; b <= 0x7e; b += 1) bs.push(b);
  for (let b = 0xa1; b <= 0xac; b += 1) bs.push(b);
  for (let b = 0xae; b <= 0xff; b += 1) bs.push(b);
  const cs = [...bs];
  let n = 0;
  for (let b = 0; b < 256; b += 1) {
    if (!bs.includes(b)) { bs.push(b); cs.push(256 + n); n += 1; }
  }
  const map = new Map<number, string>();
  bs.forEach((b, i) => map.set(b, String.fromCodePoint(cs[i]!)));
  return map;
}

const BYTE_TO_UNICODE = byteToUnicode();

/**
 * 前もって切る所（GPT-2 のもの）。
 *
 * ここで切っておかないと、単語をまたいで繋がってしまう。
 */
const PRE_SPLIT = /'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu;

/** バイト単位の BPE。`gpt2` / `bpe` の数え方。 */
class BpeTokenizer implements Counter {
  readonly #rank: Map<string, number>;

  constructor(spec: VocabSpec) {
    this.#rank = new Map((spec.merges ?? []).map((m, i) => [m, i]));
  }

  count(text: string): number {
    let n = 0;
    for (const piece of text.match(PRE_SPLIT) ?? []) {
      n += this.#pieces(piece).length;
    }
    return n;
  }

  /** 一区切りを、繋げるだけ繋いだ形にする。 */
  #pieces(piece: string): string[] {
    let parts: string[] = [];
    for (const b of Buffer.from(piece, 'utf8')) parts.push(BYTE_TO_UNICODE.get(b) ?? '');
    if (parts.length <= 1) return parts;

    for (;;) {
      let best = -1;
      let at = -1;
      for (let i = 0; i + 1 < parts.length; i += 1) {
        const rank = this.#rank.get(`${parts[i]} ${parts[i + 1]}`);
        if (rank === undefined) continue;
        if (best < 0 || rank < best) { best = rank; at = i; }
      }
      if (at < 0) break;
      parts = [...parts.slice(0, at), parts[at]! + parts[at + 1]!, ...parts.slice(at + 2)];
    }
    // 語彙に無いものは、これ以上割れない。数の上では1つと数える。
    return parts;
  }
}

/**
 * SPM（`llama`）の数え方。
 *
 * llama.cpp と同じ順で動かす。**点数のいちばん高い隣同士から繋ぐ。**
 * 空白は `▁` に置き換え、頭に一つ足す。繋げなかった塊はバイトに落ちる。
 *
 * **素直に書くと、長い文で固まる。**毎回すべての隣を見て最大を探すと、
 * 繋ぐ回数 × 隣の数で二乗になる。5万文字で 8.6 秒かかった（実測）。
 * 道具の結果は数万文字になるので、数えるたびにそれだけ止まる。
 *
 * なので llama.cpp と同じ形にする。**繋げる候補を山（heap）に積んでおき、
 * 繋いだところの周りだけ積み直す。**古くなった候補は取り出したときに捨てる。
 */
class SpmTokenizer implements Counter {
  readonly #ids: Map<string, number>;
  readonly #scores: number[];

  constructor(spec: VocabSpec) {
    this.#ids = new Map(spec.tokens.map((t, i) => [t, i]));
    this.#scores = spec.scores ?? spec.tokens.map(() => 0);
  }

  count(text: string): number {
    if (text.length === 0) return 0;
    const body = `▁${text.replace(/ /g, '▁')}`;

    // 字（コードポイント）ごとに並べ、前後を指しておく。繋いだら繋ぎ替える。
    const parts = [...body];
    const prev = new Int32Array(parts.length);
    const next = new Int32Array(parts.length);
    const alive = new Uint8Array(parts.length).fill(1);
    for (let i = 0; i < parts.length; i += 1) {
      prev[i] = i - 1;
      next[i] = i + 1 < parts.length ? i + 1 : -1;
    }

    const heap = new BigramHeap();
    const offer = (left: number, right: number): void => {
      if (left < 0 || right < 0) return;
      const joined = parts[left]! + parts[right]!;
      const id = this.#ids.get(joined);
      if (id === undefined) return;
      heap.push({ left, right, score: this.#scores[id] ?? 0, size: joined.length });
    };
    for (let i = 0; i + 1 < parts.length; i += 1) offer(i, i + 1);

    for (;;) {
      const top = heap.pop();
      if (!top) break;
      // 積んだ後に片方が繋がっていたら、その候補はもう無効。
      if (!alive[top.left] || !alive[top.right]) continue;
      if (next[top.left] !== top.right) continue;
      if (parts[top.left]!.length + parts[top.right]!.length !== top.size) continue;

      parts[top.left] = parts[top.left]! + parts[top.right]!;
      alive[top.right] = 0;
      const after = next[top.right]!;
      next[top.left] = after;
      if (after >= 0) prev[after] = top.left;

      offer(prev[top.left]!, top.left);
      offer(top.left, after);
    }

    // 語彙に無い塊は、バイトに落ちる。**落ちた分だけ数が増える。**
    let n = 0;
    for (let i = 0; i >= 0; i = next[i]!) {
      const part = parts[i]!;
      if (this.#ids.has(part)) n += 1;
      else n += Buffer.byteLength(part, 'utf8');
      if (next[i] === -1) break;
    }
    return n;
  }
}

interface Bigram { left: number; right: number; score: number; size: number }

/**
 * 点数の高い順に取り出す山。
 *
 * **同じ点数なら、前にある方から。**ここを崩すと、llama.cpp と結果が変わる
 * （どちらから繋ぐかで、残る形が変わる）。
 */
class BigramHeap {
  readonly #items: Bigram[] = [];

  push(item: Bigram): void {
    const items = this.#items;
    items.push(item);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!before(items[i]!, items[parent]!)) break;
      [items[i], items[parent]] = [items[parent]!, items[i]!];
      i = parent;
    }
  }

  pop(): Bigram | undefined {
    const items = this.#items;
    if (items.length === 0) return undefined;
    const top = items[0]!;
    const last = items.pop()!;
    if (items.length === 0) return top;
    items[0] = last;
    let i = 0;
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let best = i;
      if (l < items.length && before(items[l]!, items[best]!)) best = l;
      if (r < items.length && before(items[r]!, items[best]!)) best = r;
      if (best === i) break;
      [items[i], items[best]] = [items[best]!, items[i]!];
      i = best;
    }
    return top;
  }
}

/** 先に取り出す方か。点数が高い方、同じなら前にある方。 */
function before(a: Bigram, b: Bigram): boolean {
  return a.score !== b.score ? a.score > b.score : a.left < b.left;
}

/**
 * そのモデルの数え方を作る。**分からないなら作らない。**
 *
 * 知らない `tokenizer.ggml.model` に出会ったら undefined を返す。
 * ここで適当に BPE を当てると、静かに全部の数がずれる。
 */
export function tokenizerFor(spec: VocabSpec): Counter | undefined {
  const kind = spec.model.toLowerCase();
  if (kind === 'gpt2' || kind === 'bpe') {
    if (!spec.merges || spec.merges.length === 0) return undefined;
    return new BpeTokenizer(spec);
  }
  if (kind === 'llama' || kind === 'spm') return new SpmTokenizer(spec);
  return undefined;
}

/**
 * 一度読んだ数え方を、置いておく。
 *
 * 語彙は数万件あるので、読むのも表を作るのも安くない。一往復ごとにやると、
 * それだけで待たせる。**道で覚える。**同じファイルなら同じ数え方になるので、
 * 何本のモデルを同時に動かしていても混ざらない（勝手に変わる状態を持たない）。
 */
const CACHED = new Map<string, Counter | undefined>();

/**
 * GGUF から、そのモデルの数え方を作る。
 *
 * 読めない・知らない数え方なら undefined。**そのときは見積もりに戻る。**
 * ここで当てずっぽうを返すと、静かに全部の勘定がずれる。
 */
export async function counterForGguf(
  path: string,
  read: (p: string) => Promise<{ metadata: Map<string, unknown> }>,
): Promise<Counter | undefined> {
  const hit = CACHED.get(path);
  if (hit !== undefined || CACHED.has(path)) return hit;
  let made: Counter | undefined;
  try {
    const spec = vocabFrom((await read(path)).metadata);
    made = spec ? tokenizerFor(spec) : undefined;
  } catch {
    made = undefined; // 読めないファイル。異常として投げない
  }
  CACHED.set(path, made);
  return made;
}
