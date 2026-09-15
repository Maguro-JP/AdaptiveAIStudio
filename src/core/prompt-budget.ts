/**
 * システムプロンプトを、予算に収める。
 *
 * Cursor の Priompt から借りた考えを、依存ゼロで作り直したもの。向こうは
 * システムプロンプトの部品を JSX で書き、部品ごとに優先度を付け、
 * コンテキストウィンドウを超えたら優先度の低い方から落とす。ここも同じ形にする。
 *
 * ## 並べる場所と、残す優先を、別々にする
 *
 * ここが肝で、直す前は**この二つが同じものだった**。
 *
 *   const parts = [base, rules, never, brief, map];
 *   const drop  = [4, 1, 3];              // ← parts の添字を手で書いていた
 *
 * `parts` の並びは**モデルに計算し直させないための順**（変わらないものを先に置く。
 * システムプロンプトの先頭が一文字でも変われば、prompt cache が効かなくなり、
 * そこから先は全部やり直しになる）。
 * `drop` の並びは**捨ててよい順**。二つは別の理由で決まるのに、片方が
 * もう片方の添字で書かれていた。**`parts` を並べ替えたら、`drop` は黙って
 * 違うものを指す。**
 *
 * 優先を数で持てば、並べ替えても壊れない。
 *
 * ## 取り方
 *
 * 1. **優先の高い順に、要るだけ取らせる。**残りを次へ渡す
 *    （`atMost` で取り過ぎを止め、`atLeast` で後ろのぶんを予約する）
 * 2. 並べる場所の順に組み立てる
 * 3. 組み上げた全体を測り、超えていたら**優先の低い方から丸ごと落とす**
 *
 * 3 が要るのは、見出しや部品の間の空行が、中身の予算に入っていないため
 * （実測で 70〜100 トークン）。「だいたい収まる」では、コンテキストウィンドウが
 * 狭いときに効かない。
 *
 * **削らずに落とす。**途中で切れた決まりは、書いていないより悪いことがある。
 */

/** システムプロンプトの部品。 */
export interface Part {
  /** どれのことか。落としたものを言うときに使う。 */
  name: string;
  /**
   * 残す優先。**大きいほど残す。**落とすときは小さい方から。
   * 並べる場所とは関係ない（並びは配列の順）。
   */
  priority: number;
  /**
   * 予算を渡すと、その中に収まる文を返す。要らなければ空を返す。
   * **渡された予算を超えて返してよい**（超えた分は落とす側で面倒を見る）。
   */
  render: (budget: number) => string | Promise<string>;
  /** 予算を超えても落とさない。決まり本体のような、無いと話にならないもの。 */
  required?: boolean;
  /**
   * これ以上は取らせない。
   *
   * **取れるだけ取る部品が、後ろを飢えさせる。**「残りの半分」のような
   * 決め打ちを部品の中に書くと、優先で決めたはずの取り分が、部品ごとの
   * 都合で決まってしまう。上限はここに書く。
   */
  atMost?: number;
  /**
   * ここまでは予約しておく。
   *
   * 優先の高い部品に渡す予算から、あらかじめ差し引く。これが無いと、
   * 上の部品が取り切ったあとに 0 しか回らない（コンテキストウィンドウ 16852 で、
   * repo map がちょうどそうなっていた。実測）。
   */
  atLeast?: number;
}

export interface Fitted {
  /** 組み上げたシステムプロンプト。 */
  text: string;
  /** 落としたものの名前。**黙って落とさない**ために返す。 */
  dropped: string[];
}

/** 部品の間の区切り。 */
const JOIN = '\n\n';

/**
 * 部品を予算に収める。
 *
 * `parts` の**並びがそのままシステムプロンプトの並び**になる。捨てる順は `priority` で
 * 決まるので、並べ替えても捨て方は変わらない。
 */
export async function fitParts(
  parts: readonly Part[],
  budget: number,
  count: (text: string) => number,
): Promise<Fitted> {
  const text = new Array<string>(parts.length).fill('');

  // 1. 優先の高い順に、要るだけ取らせる。
  //    同じ優先なら、前に書いてある方から（並びで決まるので、いつも同じ結果）。
  const order = parts.map((_, i) => i)
    .sort((a, b) => (parts[b]!.priority - parts[a]!.priority) || (a - b));
  let left = Math.max(0, budget);
  for (const [k, i] of order.entries()) {
    /*
     * **後ろのために予約する。**
     *
     * まだ取っていない部品の `atLeast` を足して、その分は渡さない。
     * これが無いと、優先の高い部品が取り切ったあと 0 しか回らない。
     * 予約は約束であって、割り当てではない（要らなければ次へ回る）。
     */
    let reserved = 0;
    for (const j of order.slice(k + 1)) reserved += parts[j]!.atLeast ?? 0;
    let give = Math.max(0, left - reserved);
    const cap = parts[i]!.atMost;
    if (cap !== undefined) give = Math.min(give, cap);
    const made = await parts[i]!.render(give);
    text[i] = made;
    left = Math.max(0, left - count(made));
  }

  // 2〜3. 並べる場所の順に組んで、超えていたら優先の低い方から落とす。
  const dropped: string[] = [];
  const joined = () => text.filter(Boolean).join(JOIN);
  const droppable = [...order].reverse().filter((i) => !parts[i]!.required);
  for (const i of droppable) {
    if (count(joined()) <= budget) break;
    if (!text[i]) continue;
    text[i] = '';
    dropped.push(parts[i]!.name);
  }
  return { text: joined(), dropped };
}
