/**
 * 検索結果を、本文を読んで並べ直す（rerank）。
 *
 * Cursor の apply は retrieval → rerank → prompt framing → merge の四段で、
 * どれか一つが弱いと編集が失敗する。ここには rerank が無く、`scoreFiles` が
 * 一度並べて終わりだった。
 *
 * ## なぜ要るか
 *
 * `scoreFiles` が見ているのは索引の `head`（冒頭 600 字＋コメント 2400 字）
 * だけで、**本文は見ていない**。索引に本文まで入れると重くなるための割り切り
 * だが、そのぶん「本文にだけ答えがあるファイル」が沈む。
 *
 * このリポジトリの履歴 200 件で測ったところ、repo map に入らなかった 209 件の
 * うち **56 件（27%）が、依頼の語が本文にはあるのに head には無い**ものだった。
 *
 * ## やり方
 *
 * 全部のファイルを読むと遅い。**上位の候補だけ読む。**これが rerank の形で、
 * 安い方法で候補を絞り、高い方法で並べ直す。
 *
 * 読んだ内容はキャッシュする。索引を組み直すまでは同じ内容なので、
 * 二回目以降のやりとりでは読み直さない。
 */
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { terms, type CodeIndex } from './code-index.ts';

/**
 * 本文を読む数。
 *
 * 増やすほど当たるが、そのぶんファイルを読む。上位に入っていないものは、
 * そもそも本文を読んでも上位には来ない。
 */
export const RERANK_TOP = 30;

/** 散文は下げる。読み物として要るが、直す先ではない（`scoreFiles` と同じ扱い）。 */
const PROSE = new Set(['.md', '.txt', '.json', '.yml', '.yaml', '.toml']);

/**
 * repo map の予算から、どれだけ強く並べ直すかを決める。
 *
 * **数件しか見せられないときほど、上位の精度が効く。**逆に、ほとんどの
 * ファイルを見せられるなら並べ直しても入れ替わるだけで、かえって
 * 入っていたものを押し出す。
 *
 * 実測（このリポジトリの履歴 200 件、repo map に正解が入った割合）:
 *
 *   予算(文字)   並べ直さない   常に強く   予算で変える
 *   2000            53.2%        62.5%       62.5%
 *   4000            70.2%        72.9%       73.4%
 *   8000            84.8%        82.4%       84.8%
 *   16000           92.2%        92.5%       92.2%
 *
 * 常に強くすると 8000 で落ちる。予算で変えれば、どこでも同等以上になる。
 */
export function rerankShare(chars: number): number {
  if (chars <= NARROW) return 1;
  if (chars >= WIDE) return 0;
  return 1 - (chars - NARROW) / (WIDE - NARROW);
}

const NARROW = 2000;
const WIDE = 8000;

/**
 * 読んだ本文。索引を組み直すまで使い回す。**作業場ごとに持つ。**組んだ時刻だけで見ていたので、同じ時刻に組んだ別の作業場の
 * 同じ道（`src/index.ts`）の本文を使い、読み終わる前に入れ物が替わると、別の作業場の入れ物へ書いていた
 */
interface Cache {
  builtAt: string;
  text: Map<string, string>;
}
const caches = new Map<string, Cache>();

async function bodyOf(index: CodeIndex, path: string): Promise<string> {
  let cache = caches.get(index.root);
  if (!cache || cache.builtAt !== index.builtAt) {
    cache = { builtAt: index.builtAt, text: new Map() };
    caches.set(index.root, cache);
  }
  const held = cache.text.get(path);
  if (held !== undefined) return held;
  let text = '';
  try { text = (await readFile(join(index.root, path), 'utf8')).toLowerCase(); } catch { /* 消えた */ }
  cache.text.set(path, text);
  return text;
}

/** 何度出たか。数え切らない（多いものは、そこで足りる）。 */
function occurrences(text: string, word: string): number {
  if (!word) return 0;
  let n = 0;
  let at = text.indexOf(word);
  while (at >= 0 && n < 8) { n += 1; at = text.indexOf(word, at + word.length); }
  return n;
}

/**
 * 上位の候補だけ本文を読んで、seed に点を足す。
 *
 * 足すだけで、元の点は動かさない。**並べ直しは、元の順を壊すためではなく、
 * 沈んでいたものを引き上げるため。**
 *
 * `share` が 0 なら何もしない（読みにも行かない）。
 */
export async function rerankByBody(
  index: CodeIndex,
  query: string,
  seed: Map<number, number>,
  share: number,
  top = RERANK_TOP,
): Promise<Map<number, number>> {
  if (share <= 0 || seed.size === 0) return seed;
  const words = terms(query).map((w) => w.toLowerCase()).filter((w) => w.length >= 2);
  if (words.length === 0) return seed;

  const candidates = [...seed.entries()].sort((a, b) => b[1] - a[1]).slice(0, top);
  const found = new Map<number, number>();
  let best = 0;
  for (const [i] of candidates) {
    const file = index.files[i];
    if (!file) continue;
    const text = await bodyOf(index, file.path);
    if (text.length === 0) continue;
    let score = 0;
    let covered = 0;
    for (const word of words) {
      const tf = occurrences(text, word);
      if (tf > 0) { score += 1 + Math.log(Math.min(tf, 8)); covered += 1; }
    }
    if (score === 0) continue;
    // 多くの語に当たる方が確か。一語で何度も当たるより（`scoreFiles` と同じ）。
    score *= covered;
    if (PROSE.has(extname(file.path).toLowerCase())) score /= 3;
    found.set(i, score);
    if (score > best) best = score;
  }
  if (best <= 0) return seed;

  // 元の seed といちばん強いものを揃えてから足す（目盛りが違うので）。
  let seedBest = 0;
  for (const w of seed.values()) if (w > seedBest) seedBest = w;
  const out = new Map(seed);
  for (const [i, score] of found) {
    out.set(i, (out.get(i) ?? 0) + share * seedBest * (score / best));
  }
  return out;
}
