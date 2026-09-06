/**
 * 「ファイルを書き換える道具」を、一箇所で決める。
 *
 * ここまで、守りはどれも `name === 'write_file'` と**名前を直に見て**いた。
 * 守られた場所・読んでから書く・巻き戻し・差分の表示・作業前検査、
 * 全部で18箇所。**書き換える道具をもう一つ足した瞬間、その全部を
 * すり抜ける口になる。**（.env を守っているつもりで、別の道具からは
 * 素通り、という形になる。）
 *
 * だから、増やす前にここへ集める。
 */
import { readFile } from 'node:fs/promises';
import { safeResolve } from './paths.ts';

/** ファイルを書き換える道具。**増やすときは、必ずここに足す。** */
export const WRITE_TOOLS = ['write_file', 'edit_file'] as const;

export function isWriteTool(name: string): boolean {
  return (WRITE_TOOLS as readonly string[]).includes(name);
}

/** 呼び出しから、書き換える先の道を取る。 */
export function writePath(args: Record<string, unknown> | unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const p = (args as { path?: unknown }).path;
  return typeof p === 'string' ? p : undefined;
}

/**
 * その呼び出しで、ファイルが**どうなるか**。
 *
 * 中身を見る守り（テストを消していないか、同じものを書き続けていないか）は、
 * 書かれる後の姿が要る。`write_file` は引数にそのまま入っているが、
 * `edit_file` は「いまの中身に当ててみないと分からない」。
 * **見えないからと素通りさせない。**ここで当ててから渡す。
 */
export async function plannedContent(
  name: string,
  args: Record<string, unknown> | unknown,
  root: string,
): Promise<string | undefined> {
  if (typeof args !== 'object' || args === null) return undefined;
  const a = args as { content?: unknown; find?: unknown; replace?: unknown; all?: unknown };
  if (name === 'write_file') return typeof a.content === 'string' ? a.content : undefined;
  if (name !== 'edit_file') return undefined;

  const path = writePath(args);
  if (!path || typeof a.find !== 'string' || typeof a.replace !== 'string') return undefined;
  const abs = safeResolve(root, path);
  if (!abs) return undefined;
  const before = await readFile(abs, 'utf8').catch(() => undefined);
  if (before === undefined) return undefined;
  return applyEdit(before, a.find, a.replace, a.all === true).text;
}

/**
 * 置き換えを当てる。**当たった数も返す。**
 *
 * 数を返さないと、「一箇所のつもりが十箇所変わっていた」を止められない。
 * 小さいモデルは短い断片を渡してくるので、これは実際に起きる。
 */
/**
 * 当て方。**どう当てたかを、必ず返す。**
 *
 * 緩く当てたのに黙っていると、渡した文字列が正しかったのだと思い込んだまま、
 * 次も同じ形で渡してくる。どこまで譲ったかは、その場で言う。
 */
export type EditHow = 'exact' | 'loose' | 'anchor';

export function applyEdit(
  before: string, find: string, replace: string, all: boolean,
): { text: string; hits: number; loose?: boolean; how?: EditHow } {
  if (find.length === 0) return { text: before, hits: 0 };
  let hits = 0;
  let at = 0;
  for (;;) {
    const found = before.indexOf(find, at);
    if (found < 0) break;
    hits += 1;
    at = found + find.length;
  }
  if (hits > 0) {
    if (!all && hits > 1) return { text: before, hits };
    return {
      text: all ? before.split(find).join(replace) : before.replace(find, replace),
      hits, how: 'exact',
    };
  }
  const loose = looseEdit(before, find, replace, all);
  if (loose.hits > 0) return loose;
  return anchorEdit(before, find, replace, all);
}

/**
 * **両端で当てる。**
 *
 * 小さいモデルは、長い塊を渡すときに真ん中を書き崩す。注釈を一行落とす、
 * 空行を入れる、途中を「…」で省く。行の並びが一致しないので、緩く当てる方でも
 * 通らない。「見つかりません」と返すと、モデルは同じことを何度も試して、
 * 往復だけ増えて何も直らない。
 *
 * Cline が同じところで同じ手を使っている（block anchor matching）。
 * **最初と最後の行だけで場所を決める。**そのうえで、
 *
 *   ・行数が食い違いすぎるものは当てない（±2行まで）
 *   ・真ん中が半分も合っていないものは当てない
 *
 * **真ん中を見ずに置き換えるのは危ない。**渡された塊に無い行まで消える。
 * だから、当てたら必ず「両端で当てた」と言う（戻せるようにもしてある）。
 */
function anchorEdit(
  before: string, find: string, replace: string, all: boolean,
): { text: string; hits: number; loose?: boolean; how?: EditHow } {
  const want = trimEnds(find.split('\n')).filter((l) => l.trim().length > 0);
  // 三行に満たないものは、両端がほとんど中身そのもの。緩めても当たらない。
  if (want.length < 3) return { text: before, hits: 0 };

  const lines = before.split('\n');
  const head = want[0]!.trim();
  const tail = want[want.length - 1]!.trim();
  const span = trimEnds(find.split('\n')).length;
  const middle = want.slice(1, -1).map((l) => l.trim());

  const found: Array<{ from: number; to: number }> = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]!.trim() !== head) continue;
    for (let k = -2; k <= 2; k += 1) {
      const end = i + span - 1 + k;
      if (end <= i || end >= lines.length) continue;
      if (lines[end]!.trim() !== tail) continue;
      // 真ん中が半分も合っていないなら、別の場所とみなす。
      const inside = lines.slice(i + 1, end).map((l) => l.trim()).filter((l) => l.length > 0);
      const same = middle.filter((m) => inside.includes(m)).length;
      if (middle.length > 0 && same * 2 < middle.length) continue;
      found.push({ from: i, to: end });
      break;
    }
  }
  if (found.length === 0) return { text: before, hits: 0 };
  if (!all && found.length > 1) return { text: before, hits: found.length, loose: true, how: 'anchor' };

  const out = [...lines];
  for (const { from, to } of [...found].reverse()) {
    const shifted = reindent(replace.split('\n'), indentOf(want[0]!), indentOf(lines[from]!));
    out.splice(from, to - from + 1, ...shifted);
  }
  return { text: out.join('\n'), hits: found.length, loose: true, how: 'anchor' };
}

/**
 * 字下げと行末の空白を見ないで探す。
 *
 * **小さいモデルは、空白を一つ外す。**タブと空白を取り違える、字下げの段を
 * 一つ間違える、行末の空白を落とす。中身は合っているのに、完全一致では
 * 通らない。「見つかりません」と返すと、モデルは同じことを何度も試して、
 * 往復だけ増えて何も直らない。**道具が脆いだけなのに、モデルが馬鹿に見える。**
 *
 * 見ないのは**行の中身の外側だけ**。行の並びと、行の中身そのものは一致を
 * 求める。ここを緩めると、似た別の場所を書き換えてしまう。
 *
 * 当てるときは、**ファイルの側の字下げに合わせる。**モデルが渡してきた
 * 字下げをそのまま書くと、段のずれたコードが入る。
 */
function looseEdit(
  before: string, find: string, replace: string, all: boolean,
): { text: string; hits: number; loose?: boolean; how?: EditHow } {
  const lines = before.split('\n');
  const want = trimEnds(find.split('\n'));
  if (want.length === 0) return { text: before, hits: 0 };

  const key = (line: string): string => line.trim();
  const wantKeys = want.map(key);

  const at: number[] = [];
  for (let i = 0; i + wantKeys.length <= lines.length; i += 1) {
    let same = true;
    for (let j = 0; j < wantKeys.length; j += 1) {
      if (key(lines[i + j]!) !== wantKeys[j]) { same = false; break; }
    }
    if (same) at.push(i);
  }
  if (at.length === 0) return { text: before, hits: 0 };
  if (!all && at.length > 1) return { text: before, hits: at.length, loose: true, how: 'loose' };

  // **ファイルの側の字下げに合わせる。**渡ってきた字下げをそのまま書くと、
  // 段のずれたコードが入る（見た目で気づけない壊し方）。
  const out = [...lines];
  for (const start of [...at].reverse()) {
    const shifted = reindent(replace.split('\n'), indentOf(want[0]!), indentOf(lines[start]!));
    out.splice(start, wantKeys.length, ...shifted);
  }
  return { text: out.join('\n'), hits: at.length, loose: true, how: 'loose' };
}

/**
 * 当たらなかったとき、**いちばん近い場所を、そのまま見せる。**
 *
 * ここまでは「read_file で読み直してください」と返していた。
 * 読み直しは一往復まるごと払ううえ、ファイル全体が窓に入る。**次も外す。**
 *
 * Roo Code が、当たらなかった塊のいちばん近い場所を、似ている度合いと一緒に
 * 返している。同じ考えを取り込む。ここで見せてしまえば、モデルは
 * その場で直せる（往復が一つ減る）。
 *
 * 近いものが無いとき（どの窓とも重ならない）は、何も返さない。
 * **でたらめな場所を「近いところです」と見せる方が悪い。**
 */
export function nearestTo(before: string, find: string, show = 8): string | undefined {
  const want = trimEnds(find.split('\n')).map((l) => l.trim()).filter((l) => l.length > 0);
  if (want.length === 0) return undefined;
  const lines = before.split('\n');
  const span = Math.max(want.length, 1);

  let best = { at: -1, hit: 0 };
  for (let i = 0; i + 1 <= lines.length; i += 1) {
    const inside = lines.slice(i, i + span).map((l) => l.trim());
    let hit = 0;
    for (const w of want) if (inside.includes(w)) hit += 1;
    if (hit > best.hit) best = { at: i, hit };
  }
  // 半分も重なっていないなら、近いとは言わない。
  if (best.at < 0 || best.hit * 2 < want.length) return undefined;

  const from = Math.max(0, best.at - 1);
  const to = Math.min(lines.length, best.at + span + 1);
  const body = lines.slice(from, to)
    .map((l, k) => `${String(from + k + 1).padStart(5)}: ${l}`)
    .slice(0, show)
    .join('\n');
  return `いちばん近いのはここです（${want.length} 行のうち ${best.hit} 行が一致）:\n${body}`;
}

/** 前後の空行を落とす。渡し方の癖であって、探したい中身ではない。 */
function trimEnds(lines: string[]): string[] {
  let from = 0;
  let to = lines.length;
  while (from < to && lines[from]!.trim().length === 0) from += 1;
  while (to > from && lines[to - 1]!.trim().length === 0) to -= 1;
  return lines.slice(from, to);
}

function indentOf(line: string): string {
  return /^[\t ]*/.exec(line)?.[0] ?? '';
}

/**
 * 字下げを付け替える。
 *
 * 渡ってきた側の字下げ（from）を、ファイルの側（to）へ置き換える。
 * from で始まっていない行は、そのまま（相対の段を壊さない）。
 */
function reindent(lines: string[], from: string, to: string): string[] {
  if (from === to) return lines;
  return lines.map((line) => {
    if (line.trim().length === 0) return line;
    return line.startsWith(from) ? to + line.slice(from.length) : line;
  });
}
