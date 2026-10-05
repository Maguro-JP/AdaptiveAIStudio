/**
 * 統一差分の生成。承認画面に出すためだけのもので、パッチ適用には使わない。
 * 依存を増やさないため自前で持つ。
 */
export function unifiedDiff(
  path: string,
  before: string,
  after: string,
  context = 3,
): string {
  // 終わりの改行を、空の一行として数えない。「console.log(1);\n」を書くと
  // 「+2 -0」で 2 行目が空、と出ていた。行は改行で区切られるものであって、
  // 終わりの改行の後ろに行は無い。
  const a = lines(before);
  const b = lines(after);
  const ops = diffLines(a, b);

  const hunks: string[] = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i]!.kind === 'same') { i += 1; continue; }

    // 変更の塊を、前後 context 行とともに切り出す
    let start = i;
    let sameRun = 0;
    let end = i;
    for (let j = i; j < ops.length; j += 1) {
      if (ops[j]!.kind === 'same') {
        sameRun += 1;
        if (sameRun > context * 2) break;
      } else {
        sameRun = 0;
        end = j;
      }
    }
    start = Math.max(0, start - context);
    end = Math.min(ops.length - 1, end + context);

    let aStart = 0, bStart = 0;
    for (let j = 0; j < start; j += 1) {
      if (ops[j]!.kind !== 'add') aStart += 1;
      if (ops[j]!.kind !== 'del') bStart += 1;
    }
    let aCount = 0, bCount = 0;
    const body: string[] = [];
    for (let j = start; j <= end; j += 1) {
      const op = ops[j]!;
      if (op.kind === 'same') { aCount += 1; bCount += 1; body.push(` ${op.line}`); }
      else if (op.kind === 'del') { aCount += 1; body.push(`-${op.line}`); }
      else { bCount += 1; body.push(`+${op.line}`); }
    }
    hunks.push(`@@ -${aStart + 1},${aCount} +${bStart + 1},${bCount} @@\n${body.join('\n')}`);
    i = end + 1;
  }

  if (hunks.length === 0) return '';
  return `--- a/${path}\n+++ b/${path}\n${hunks.join('\n')}`;
}

type Op = { kind: 'same' | 'del' | 'add'; line: string };

/**
 * 頭と尻の同じ行を外してから、残りを比べる。
 *
 * 外さずに行数の積で上限を見ていたので、2,000 行を超えるファイルは一行の直しでも「全部消して全部足す」になり、
 * 承認の画面で何が変わったのか読めず、塊ごとに選ぶこともできなかった。
 */
function diffLines(a: string[], b: string[]): Op[] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  const same = (lines: string[]): Op[] => lines.map((line) => ({ kind: 'same' as const, line }));
  return [
    ...same(a.slice(0, head)),
    ...lcsLines(a.slice(head, a.length - tail), b.slice(head, b.length - tail)),
    ...same(a.slice(a.length - tail)),
  ];
}

/** 素朴なLCS。個人用途のファイルサイズでは十分。 */
function lcsLines(a: string[], b: string[]): Op[] {
  const n = a.length, m = b.length;
  // 大きすぎる場合はLCSを諦め、全置換として表示する
  if (n * m > 4_000_000) {
    return [...a.map((line) => ({ kind: 'del' as const, line })),
            ...b.map((line) => ({ kind: 'add' as const, line }))];
  }

  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const ops: Op[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ kind: 'same', line: a[i]! }); i += 1; j += 1; }
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) { ops.push({ kind: 'del', line: a[i]! }); i += 1; }
    else { ops.push({ kind: 'add', line: b[j]! }); j += 1; }
  }
  while (i < n) { ops.push({ kind: 'del', line: a[i]! }); i += 1; }
  while (j < m) { ops.push({ kind: 'add', line: b[j]! }); j += 1; }
  return ops;
}

export function diffStat(diff: string): { added: number; removed: number } {
  let added = 0, removed = 0;
  // 見出し（`--- a/…`・`+++ b/…`）は最初の塊（`@@`）の前にだけ在る。塊の中で `---` や `+++` で始まる行は、中身が `--`
  // （SQL の注釈など）や `++` で始まる行の出入り。塊の中まで見出しとして飛ばしていたので、その行を数えていなかった
  let inHunk = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) { inHunk = true; continue; }
    if (!inHunk) continue;
    if (line.startsWith('+')) added += 1;
    else if (line.startsWith('-')) removed += 1;
  }
  return { added, removed };
}

/** 行に分ける。終わりの改行は一つだけ落とす（空の一行にしない）。 */
function lines(text: string): string[] {
  if (text === '') return [];
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
}
