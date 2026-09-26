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
  /** 新しい側の開始行（1 から数える）。当てたあとの中身に対して戻すときに使う。 */
  readonly newFrom: number;
  /** ` `／`-`／`+` の付いた行。 */
  readonly lines: readonly string[];
  readonly added: number;
  readonly removed: number;
}

/** 差分を塊へ割る。差分でなければ空。 */
export function splitHunks(diff: string): Hunk[] {
  const out: Hunk[] = [];
  let now: { header: string; from: number; count: number; newFrom: number; lines: string[] } | undefined;
  const close = () => {
    if (!now) return;
    out.push({
      header: now.header, from: now.from, count: now.count, newFrom: now.newFrom, lines: now.lines,
      added: now.lines.filter((l) => l.startsWith('+')).length,
      removed: now.lines.filter((l) => l.startsWith('-')).length,
    });
    now = undefined;
  };
  for (const line of diff.split('\n')) {
    const head = /^@@ -(\d+),(\d+) \+(\d+),\d+ @@/.exec(line);
    if (head) {
      close();
      now = { header: line, from: Number(head[1]), count: Number(head[2]), newFrom: Number(head[3]), lines: [] };
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

/**
 * 戻す塊と、その中の行（塊の中の何番目か。省くと塊ごと）。
 *
 * 行を渡しても、**その行だけは戻さない。**その行を含む書き換えの組（続けて並ぶ `-` と `+`）を丸ごと戻す。
 * 消した行と足した行は多くの場合「書き換え」の組で、片方だけ戻すと両方が並んだ、どこにも無かった姿になる。
 */
export interface RevertPick {
  readonly hunk: number;
  readonly lines?: readonly number[];
}

/**
 * 当てたあとの中身から、選んだ塊・行だけを戻す。
 *
 * Cursor は当てた変更を塊ごと・行ごとに Reject できる。ここは塊ごとの
 * 承認しか無く、当てたあとは「戻す」で 1 ターンまるごとしか戻せなかった。
 * 半分は良くて半分は要らない、が扱えない。
 *
 * やり方は、選んだ行の向きを逆にした差分を作って、当てたあとの中身に
 * 当てる。選ばなかった `+` は残るので文脈（` `）に、選ばなかった `-` は
 * 無いままなので落とす。食い違えば `undefined`（その後に変わっている）。
 */
export function revertLines(
  current: string,
  diff: string,
  picks: readonly RevertPick[],
): string | undefined {
  const hunks = splitHunks(diff);
  const byHunk = new Map<number, Set<number> | undefined>();
  for (const p of picks) {
    if (p.hunk < 0 || p.hunk >= hunks.length) return undefined;
    if (!p.lines) { byHunk.set(p.hunk, undefined); continue; }
    if (byHunk.has(p.hunk) && byHunk.get(p.hunk) === undefined) continue;
    const set = byHunk.get(p.hunk) ?? new Set<number>();
    for (const i of p.lines) set.add(i);
    byHunk.set(p.hunk, set);
  }
  if (byHunk.size === 0) return current;

  const reversed: string[] = [];
  for (const [i, asked] of [...byHunk.entries()].sort((a, b) => a[0] - b[0])) {
    const h = hunks[i]!;
    // 整数でない番号（画面以外の口から来る）も当てない。`lines[1.5]` は無く、先で落ちる。
    if (asked !== undefined && [...asked].some((at) => !Number.isInteger(at) || at < 0 || at >= h.lines.length)) return undefined;
    const chosen = asked === undefined ? undefined : changeGroups(h.lines, asked);
    const lines: string[] = [];
    h.lines.forEach((line, at) => {
      const pick = chosen === undefined || chosen.has(at);
      if (line.startsWith('+')) lines.push(pick ? `-${line.slice(1)}` : ` ${line.slice(1)}`);
      else if (line.startsWith('-')) { if (pick) lines.push(`+${line.slice(1)}`); }
      else lines.push(line);
    });
    const count = lines.filter((l) => !l.startsWith('+')).length;
    reversed.push(`@@ -${h.newFrom},${count} +${h.newFrom},${count} @@`, ...lines);
  }
  return applyHunks(current, reversed.join('\n'), Array.from({ length: byHunk.size }, (_, k) => k));
}

/**
 * 選んだ行を、それを含む書き換えの組（続けて並ぶ `-` と `+` の行）に広げる。
 * 文脈（` `）の行を選んでも何も戻さない（変えていない行）。
 */
function changeGroups(lines: readonly string[], picked: ReadonlySet<number>): Set<number> {
  const out = new Set<number>();
  const changed = (at: number) => at >= 0 && at < lines.length && (lines[at]!.startsWith('+') || lines[at]!.startsWith('-'));
  for (const at of picked) {
    if (!changed(at)) continue;
    let from = at;
    while (changed(from - 1)) from -= 1;
    for (let k = from; changed(k); k += 1) out.add(k);
  }
  return out;
}

