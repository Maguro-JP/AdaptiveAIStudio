/**
 * 差分を、塊（hunk）ごとに受け入れる。
 *
 * これまでは**全部通すか、全部戻すか**しかなかった。3か所直したうちの
 * 1か所だけが違う、という普通のことが起きたときに、直っている2か所ごと
 * 捨てて、同じ依頼をやり直させるしかない。狭い窓のモデルほど、
 * このやり直しが高くつく。
 *
 * ここでは `unifiedDiff` が作った差分を塊に割り、**選んだ塊だけ**を
 * 元の中身に当てて、新しい中身を組む。
 */

export interface Hunk {
  /** `@@ -a,b +c,d @@` の行そのもの。 */
  readonly header: string;
  /** 元の側の開始行（1 起点）。 */
  readonly from: number;
  /** 元の側の行数。 */
  readonly count: number;
  /** ` `／`-`／`+` の付いた行。 */
  readonly lines: readonly string[];
  readonly added: number;
  readonly removed: number;
}

/** 差分を塊へ割る。差分でなければ空。 */
export function splitHunks(diff: string): Hunk[] {
  const out: Hunk[] = [];
  let now: { header: string; from: number; count: number; lines: string[] } | undefined;
  const close = () => {
    if (!now) return;
    out.push({
      header: now.header, from: now.from, count: now.count, lines: now.lines,
      added: now.lines.filter((l) => l.startsWith('+')).length,
      removed: now.lines.filter((l) => l.startsWith('-')).length,
    });
    now = undefined;
  };
  for (const line of diff.split('\n')) {
    const head = /^@@ -(\d+),(\d+) \+\d+,\d+ @@/.exec(line);
    if (head) {
      close();
      now = { header: line, from: Number(head[1]), count: Number(head[2]), lines: [] };
      continue;
    }
    if (!now) continue; // `---` `+++` の見出し
    if (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+')) now.lines.push(line);
  }
  close();
  return out;
}

/**
 * 選んだ塊だけを当てる。
 *
 * 当たらなかった（元の中身と食い違う）ときは `undefined`。
 * **食い違ったまま書かない。**ずれた場所へ当てると、直していない所を壊す。
 */
export function applyHunks(
  before: string,
  diff: string,
  chosen: readonly number[],
): string | undefined {
  const hunks = splitHunks(diff);
  const want = [...new Set(chosen)].sort((a, b) => a - b);
  if (want.some((i) => i < 0 || i >= hunks.length)) return undefined;
  if (want.length === 0) return before;

  const src = before === '' ? [] : before.split('\n');
  const out: string[] = [];
  let at = 0; // 元の側の、次に写す行（0 起点）

  for (const i of want) {
    const h = hunks[i]!;
    const start = h.from - 1;
    if (start < at) return undefined; // 塊同士が重なっている
    out.push(...src.slice(at, start));
    let cur = start;
    for (const line of h.lines) {
      const body = line.slice(1);
      if (line.startsWith('+')) { out.push(body); continue; }
      // ` ` と `-` は元の側に在るはず。無ければ当たっていない。
      if (src[cur] !== body) return undefined;
      cur += 1;
      if (line.startsWith(' ')) out.push(body);
    }
    if (cur !== start + h.count) return undefined;
    at = cur;
  }
  out.push(...src.slice(at));
  return out.join('\n');
}
