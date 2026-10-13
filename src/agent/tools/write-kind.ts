/**
 * 「ファイルを書き換える道具」を、一箇所で決める。
 *
 * ここまで、守りはどれも `name === 'write_file'` と**名前を直に見て**いた。
 * 守られた場所・読んでから書く・巻き戻し・差分の表示・ベースライン、
 * 全部で18箇所。**書き換える道具をもう一つ足した瞬間、その全部を
 * すり抜ける口になる。**（.env を守っているつもりで、別の道具からは
 * 素通り、という形になる。）
 *
 * だから、増やす前にここへ集める。
 */
import { isAbsent, readRegularText } from '../../harness/put-back.ts';
import { safeResolve } from './paths.ts';

/** ファイルを書き換える道具。**増やすときは、必ずここに足す。** */
export const WRITE_TOOLS = ['write_file', 'edit_file'] as const;

export function isWriteTool(name: string): boolean {
  return (WRITE_TOOLS as readonly string[]).includes(name);
}

/**
 * 外から来たツール（MCP）の名前の区切り。`<サーバ名>__<ツール名>`。
 *
 * **この場所のツールには入れない。**入れた瞬間、そのツールは
 * 「外から来たもの」として扱われる。`test/mcp-protected.test.ts` で止めている。
 */
export const EXTERNAL_SEPARATOR = '__';

/** 外から来たツールか。 */
export function isExternalTool(name: string): boolean {
  return name.includes(EXTERNAL_SEPARATOR);
}

/**
 * ファイルを書き換える**かもしれない**か。
 *
 * 守りはどれも `isWriteTool` で入口を絞っていた。名前の一致で見るので、
 * 当たるのは `write_file` と `edit_file` の二つだけ。**外から来たツールは
 * 一つも当たらない。**相手が何をするかはこちらからは分からないのに、
 * 「書かない側」に置いていたことになる。
 *
 * 分からないものは、書くかもしれない側に置く。**分からないことを理由に
 * 素通りさせない。**
 */
export function mayWriteFiles(name: string): boolean {
  return isWriteTool(name) || isExternalTool(name);
}

/** 走らせるツール。何が起きるかは命令の中身で決まるので、ここからは分からない。 */
const RUN_TOOL = 'run_command';

/**
 * 作業場のファイルを**変えうる**か。
 *
 * `mayWriteFiles` に `run_command` を足したもの。走らせた物がファイルを作る・
 * 消すのは普通のこと（生成、依存の入れ直し、片付け）。
 *
 * **先読みを捨てるのは、こちらで判じる。**捨てて外したときの損は作り直す手間
 * だけだが、古いものを渡すと、モデルは**在るファイルを無いものとして考える。**
 * 分からないものは、変えたかもしれない側に置く。
 */
export function mayChangeFiles(name: string): boolean {
  return mayWriteFiles(name) || name === RUN_TOOL;
}

/**
 * **この場所のツール**でファイルが変わるか。外のツールは含めない。
 *
 * `mayChangeFiles` と分けてある。先読みを捨てるのは作り直すだけなので、
 * 分からないものまで含めて構わない。**作業前の記録は違う。**あれはその場で
 * テストを一度走らせるので、外のツールの手前に置くと、1ターンが何十秒も伸びる
 * （実測。外のツールを呼ぶ e2e が、記録を待つ間に打ち切られた）。
 *
 * 記録のうち軽い方（テストの数）は、外のツールの手前でも取る
 * （`src/agent/before-work.ts`）。外のツールが先にテストを消しても、
 * 消す前の数が「前」になる。**重い方（作業前の成否）は、ここで決める。**
 * 外のツールが先に落ちる形にしたものは、作業前から落ちていたものとして読まれる。
 * そこはまだ塞げていない。
 */
export function changesFilesHere(name: string): boolean {
  return isWriteTool(name) || name === RUN_TOOL;
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
  if (!path) return undefined;
  const abs = safeResolve(root, path);
  if (!abs) return undefined;
  // 無いファイルへの edit は後の姿が決まらない（undefined）。**在るのに読めないのは投げる。**「分からない」として返すと、
  // 規則は後の姿が分からないものを通すので、読めない一瞬にテストを消す edit が素通りする
  let before: string;
  try {
    // **ツールと同じ形で当てる**（edit_file は LF に揃えてから当てる。CRLF のまま当てると、ツールでは当たる直しがここでは当たらず、
    // 「後の姿は前と同じ」と見て、テストを消す直しを通していた）。後の姿は LF で返す（規則は数を比べるだけ）
    before = lf(await readRegularText(abs));
  } catch (e) {
    if (isAbsent(e)) return undefined;
    throw e;
  }

  /*
   * **並べて渡された直しも、当ててから見る。**
   *
   * ここは `find` / `replace` の一組しか見ていなかった。`edits` に並べて
   * 渡す道を足したとき、この関数は `undefined` を返す。規則は
   * 「後の姿が分からないなら通す」と書いてあるので、**素通りする。**
   * 部分置換でテストを消すのを止める規則が、名前を一つ増やしただけで
   * 効かなくなる。ツールを足すときに、いちばん起きやすい形。
   */
  const raw = (args as { edits?: unknown }).edits;
  if (Array.isArray(raw)) {
    let text = before;
    for (const e of raw) {
      const one = e as { find?: unknown; replace?: unknown; all?: unknown };
      if (typeof one?.find !== 'string' || typeof one?.replace !== 'string') return undefined;
      const got = applyEdit(text, lf(one.find), lf(one.replace), one.all === true);
      // 当たらないものが混じっていたら、後の姿は決まらない。
      // **決まらないものを「これが後の姿だ」として渡さない。**
      if (got.hits === 0) return undefined;
      text = got.text;
    }
    return text;
  }

  if (typeof a.find !== 'string' || typeof a.replace !== 'string') return undefined;
  return applyEdit(before, lf(a.find), lf(a.replace), a.all === true).text;
}

/** 改行を LF に揃える（`fs.ts` の `toLf` と同じ。あちらはこのファイルを読み込むので、ここで持つ）。 */
function lf(s: string): string {
  return s.replace(/\r\n/g, '\n');
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
  /*
   * **頭の BOM は外して当て、戻して返す。**付いたまま当てると、一行目から始まる複数行の `find` は「行の頭から」と見なされず、
   * 緩い当て（行を trim して比べる。trim は BOM も落とす）に回り、一行目を BOM の無い行で置き換えていた。バッチファイルは BOM が
   * 無いと cmd.exe が CP932 として読むので、それだけで壊れる（差分にも出ない）
   */
  if (before.startsWith('\uFEFF') && !find.startsWith('\uFEFF')) {
    const inner = applyEdit(before.slice(1), find, replace, all);
    return inner.hits > 0 && inner.text !== before.slice(1) ? { ...inner, text: `\uFEFF${inner.text}` } : { ...inner, text: before };
  }

  const found = positionsOf(before, find);
  /*
   * **行の途中から当てない。**
   *
   * `indexOf` は行の切れ目を見ない。モデルが字下げを一つ落とすと、
   * 崩れた `find` が**本物の行の途中と一致する**（`  * 付け替える` は
   * `   * 付け替える` の一部）。そこへ置き換えると、消し損ねた空白が
   * 頭に残って一段ずれる。しかも「完全に一致した」ことになるので、
   * こちらは何も言わない。**モデルは直ったと思って先へ進む。**
   *
   * 複数行を渡してきたなら、行の頭から始まっているはず。そうでない
   * 当たりは、下の緩い当て（行で見る）に回す。
   *
   * 一行だけの `find` は、行の途中でよい（名前の付け替えなど）。
   */
  const lineHead = (at: number) => at === 0 || before[at - 1] === '\n';
  /*
   * 一行の `find` でも、空白から始まって行の頭の空白の途中に当たったものは、字下げを落としただけ。複数行の `replace` を
   * そこへ入れると二行目から後が浅いまま入り、しかも完全一致として何も言わなかった。行で見る道（字下げを合わせる）に回す
   */
  const droppedIndent = (at: number) => /^\s/.test(find) && replace.includes('\n')
    && !/\S/.test(before.slice(before.lastIndexOf('\n', at - 1) + 1, at));
  const aligned = find.includes('\n')
    ? found.filter(lineHead)
    : found.filter((at) => lineHead(at) || !droppedIndent(at));
  if (aligned.length > 0) {
    /*
     * 行の途中の当たりのうち、前に字下げ以外の字がある物（`x = f(a,\n  b)` の `f(a,…`）は本物の出現。捨てると、`all` では
     * 一部だけ替えて「更新」と言い、`all` でなければ「何箇所にも当たる」を言わずに行の頭の方だけを黙って替えていた。
     * 前が字下げだけの物は、字下げを落とした `find` が行の途中と一致しただけ（上の理由）なので数えない
     */
    const real = found.filter((at) => aligned.includes(at) || /\S/.test(before.slice(before.lastIndexOf('\n', at - 1) + 1, at)));
    return spliceAt(before, real, find.length, replace, all);
  }

  const loose = looseEdit(before, find, replace, all);
  if (loose.hits > 0) return loose;
  const anchor = anchorEdit(before, find, replace, all);
  if (anchor.hits > 0) return anchor;

  // 行で見る道も駄目だったときの、最後の手。行の途中から始まる完全一致。
  // ここまで来ているなら、行として読める形ではなかったということ
  // （`foo(a,\n  b)` のような、式の途中から渡された塊）。
  if (found.length > 0) return spliceAt(before, found, find.length, replace, all);
  return { text: before, hits: 0 };
}

/** 当たった位置を全部。重なりは数えない。 */
function positionsOf(before: string, find: string): number[] {
  const out: number[] = [];
  let at = 0;
  for (;;) {
    const found = before.indexOf(find, at);
    if (found < 0) return out;
    out.push(found);
    at = found + find.length;
  }
}

/**
 * その位置に流し込む。
 *
 * `String.replace` を使わない。置き換える側に `$&` や `$1` が入っていると
 * **置換の指定として読まれる**（コードや正規表現を書き換えるときに実際に
 * 混ざる）。位置が分かっているので、切って繋ぐ。
 */
function spliceAt(
  before: string, at: number[], width: number, replace: string, all: boolean,
): { text: string; hits: number; how?: EditHow } {
  if (!all && at.length > 1) return { text: before, hits: at.length };
  let text = before;
  for (const pos of [...at].reverse()) {
    text = text.slice(0, pos) + replace + text.slice(pos + width);
  }
  return { text, hits: at.length, how: 'exact' };
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
  const cut = cutEnds(find.split('\n'));
  const want = cut.lines.filter((l) => l.trim().length > 0);
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
    /*
     * **いちばん合う終わりを選ぶ。最初に見つかった終わりではなく。**
     *
     * ここは k を -2 から順に見て、最初に当たったところで打ち切っていた。
     * 終わりの行は `}` や `);` のような、どこにでもある行になりやすい。
     * そのため**本当の終わりより 2 行手前**で止まり、残りの行が置き去りに
     * なる。しかも当たったことになるので何も言わない。
     * 履歴 400 commit で測ると、真ん中に空行を入れた形・数行を省いた形の
     * 失敗は**全部これ**だった（それぞれ 43 件・53 件）。
     *
     * 渡された行数（span）は、真ん中を崩された分だけずれている。だから
     * 行数は当てにせず、**真ん中がいちばん多く一致する終わり**を採る。
     * 同じだけ合うなら、中身の行（空行を除く）の数が渡されたものに近い方。
     */
    let best: { to: number; same: number; off: number } | undefined;
    for (let k = -2; k <= 2; k += 1) {
      const end = i + span - 1 + k;
      if (end <= i || end >= lines.length) continue;
      if (lines[end]!.trim() !== tail) continue;
      const inside = lines.slice(i + 1, end).map((l) => l.trim()).filter((l) => l.length > 0);
      const same = middle.filter((m) => inside.includes(m)).length;
      // 真ん中が半分も合っていないなら、別の場所とみなす。
      if (middle.length > 0 && same * 2 < middle.length) continue;
      // 近さは空行を数えない行の数で比べる。空行を一つ足された find は行数が一つ多いので、行数で比べると
      // 塊のすぐ後ろの `}` や `});`（終わりの行と同じ形）まで延ばして選び、その行を消していた
      const off = Math.abs(inside.length - middle.length) * 10 + Math.abs(k);
      if (!best || same > best.same || (same === best.same && off < best.off)) {
        best = { to: end, same, off };
      }
    }
    // all のとき、当たった塊の中から次を探さない（重なった塊を両方当てると、後の置き換えが前の置き換えの行まで消す）
    if (best) { found.push({ from: i, to: best.to }); if (all) i = best.to; }
  }
  if (found.length === 0) return { text: before, hits: 0 };
  if (!all && found.length > 1) return { text: before, hits: found.length, loose: true, how: 'anchor' };

  const put = fitReplace(replace.split('\n'), cut.head, cut.tail);
  const out = [...lines];
  for (const { from, to } of [...found].reverse()) {
    // 行の数が違いうるので、中身が同じ行どうしを対にしてから、行ごとの差で付け替える
    // （最初の行の差を全部に足すと、元で行の頭にあった行まで字下げしていた）
    const block = lines.slice(from, to + 1);
    let cursor = 0;
    const got = want.map((w) => {
      const k = block.findIndex((l, n) => n >= cursor && l.trim() === w.trim());
      if (k < 0) return undefined;
      cursor = k + 1;
      return block[k];
    });
    const shifted = sameFrame(put, indentOf(want[0]!), indentOf(lines[from]!))
      ? reindentByLine(put, want, got)
      : put;
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
  const cut = cutEnds(find.split('\n'));
  const want = cut.lines;
  if (want.length === 0) return { text: before, hits: 0 };

  const key = (line: string): string => line.trim();
  const wantKeys = want.map(key);

  const at: number[] = [];
  for (let i = 0; i + wantKeys.length <= lines.length; i += 1) {
    let same = true;
    for (let j = 0; j < wantKeys.length; j += 1) {
      if (key(lines[i + j]!) !== wantKeys[j]) { same = false; break; }
    }
    // all のとき、重なった当たりは当てない（`}` が続く所で二度当てると、逆順に置き換えるときに余分な行まで消える）。
    // all でないときは数える（どこを指したのか決まらないので、何箇所にも当たると返す）
    if (same) { at.push(i); if (all) i += wantKeys.length - 1; }
  }
  if (at.length === 0) return { text: before, hits: 0 };
  if (!all && at.length > 1) return { text: before, hits: at.length, loose: true, how: 'loose' };

  // **ファイルの側の字下げに合わせる。**渡ってきた字下げをそのまま書くと、
  // 段のずれたコードが入る（見た目で気づけない壊し方）。
  // ただし寄せるのは、`replace` が `find` と同じ枠で書かれているときだけ。
  const put = fitReplace(replace.split('\n'), cut.head, cut.tail);
  const out = [...lines];
  for (const start of [...at].reverse()) {
    const shifted = sameFrame(put, indentOf(want[0]!), indentOf(lines[start]!))
      ? reindentByLine(put, want, lines.slice(start, start + want.length))
      : put;
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

  /*
   * 範囲を一行ずつずらし、入った行と出た行の分だけ数を足し引きする（範囲ごとに作り直していたので、手間が行数 × find の行数の 2 乗になり、
   * 長い find が外れると本体がしばらく止まった）。数え方は前と同じ: 範囲の中に在る want の行の数（want の重なりはその数だけ数える）
   */
  const trimmed = lines.map((l) => l.trim());
  const wanted = new Map<string, number>();
  for (const w of want) wanted.set(w, (wanted.get(w) ?? 0) + 1);
  const inWindow = new Map<string, number>();
  let hit = 0;
  const enter = (l: string) => {
    const n = inWindow.get(l) ?? 0;
    inWindow.set(l, n + 1);
    if (n === 0) hit += wanted.get(l) ?? 0;
  };
  const leave = (l: string) => {
    const n = inWindow.get(l)!;
    inWindow.set(l, n - 1);
    if (n === 1) hit -= wanted.get(l) ?? 0;
  };
  for (let k = 0; k < Math.min(span, trimmed.length); k += 1) enter(trimmed[k]!);
  let best = { at: -1, hit: 0 };
  for (let i = 0; i + 1 <= lines.length; i += 1) {
    if (i > 0) {
      leave(trimmed[i - 1]!);
      if (i + span - 1 < trimmed.length) enter(trimmed[i + span - 1]!);
    }
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
  return cutEnds(lines).lines;
}

/**
 * 前後の空行を落として、**何行落としたかも返す。**
 *
 * 落とした数が要るのは、`replace` の側を揃えるため（`fitReplace`）。
 */
function cutEnds(lines: string[]): { lines: string[]; head: number; tail: number } {
  let from = 0;
  let to = lines.length;
  while (from < to && lines[from]!.trim().length === 0) from += 1;
  while (to > from && lines[to - 1]!.trim().length === 0) to -= 1;
  return { lines: lines.slice(from, to), head: from, tail: lines.length - to };
}

/**
 * 置き換える側を、探した側の切り方に揃える。
 *
 * **探すときだけ端の空行を落としていた。**`find` の前後の空行は「落として
 * 探す」ので、その空行はファイルに残ったまま。なのに `replace` は落とさずに
 * そのまま流し込んでいたので、**空行が二重に入った**（履歴 400 commit で
 * 実測、これだけで数百件）。落とした数だけ、こちらからも落とす。
 *
 * 空行を**足したい**編集は壊さない。`find` が落とした数までしか削らないので、
 * `find` に端の空行が無ければ（普通はこれ）何もしない。
 */
function fitReplace(lines: string[], head: number, tail: number): string[] {
  let from = 0;
  let to = lines.length;
  while (from < to && head > 0 && lines[from]!.trim().length === 0) { from += 1; head -= 1; }
  while (to > from && tail > 0 && lines[to - 1]!.trim().length === 0) { to -= 1; tail -= 1; }
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

/**
 * 字下げを、当たった行ごとの差で付け替える。
 *
 * 最初の行で測った差だけを全部の行に足していたので、`find` の字下げが揃っていてファイルの側が揃っていないとき
 * （`foo()` は 2 字下げ、`bar()` は行の頭）、行の頭にあった行まで字下げしていた（Python や YAML では意味が変わる）。
 * `find` の字下げごとにファイルの字下げを対にして付け替える。同じ字下げが別の字下げに当たっていて対が決まらなければ、
 * 行の数が同じときだけ行ごとに当て、違えば付け替えない。
 */
function reindentByLine(put: string[], want: string[], got: ReadonlyArray<string | undefined>): string[] {
  const pairs = new Map<string, string>();
  let consistent = true;
  want.forEach((w, j) => {
    // 対になるファイルの行が無い行（崩れた行）は、対を決める材料にしない
    if (w.trim().length === 0 || got[j] === undefined) return;
    const from = indentOf(w);
    const to = indentOf(got[j]!);
    if (pairs.has(from) && pairs.get(from) !== to) consistent = false;
    else pairs.set(from, to);
  });
  if (consistent) {
    // 長い字下げから当てる（`    ` を `  ` より先に見る）
    const order = [...pairs.keys()].sort((x, y) => y.length - x.length);
    return put.map((line) => {
      if (line.trim().length === 0) return line;
      const from = order.find((f) => line.startsWith(f));
      return from === undefined ? line : pairs.get(from)! + line.slice(from.length);
    });
  }
  // 対が決まらないときは、行ごとに当てる。中身が `find` の行と同じなら、その行が当たったファイルの行の字下げ。
  // 違えば（書き換えた行）、同じ位置の `find` の行のもの。どちらも無ければ、そのまま
  let next = 0;
  return put.map((line, i) => {
    if (line.trim().length === 0) return line;
    let j = want.findIndex((w, n) => n >= next && w.trim() === line.trim() && got[n] !== undefined);
    if (j >= 0) next = j + 1;
    else j = i < want.length && got[i] !== undefined ? i : -1;
    if (j < 0) return line;
    const from = indentOf(want[j]!);
    return line.startsWith(from) ? indentOf(got[j]!) + line.slice(from.length) : line;
  });
}

/**
 * `replace` を、ファイルの字下げへ寄せてよいか。
 *
 * **寄せるのは、`replace` が `find` と同じ枠で書かれているときだけ。**
 *
 * ここは無条件に寄せていた。`find` の先頭行の字下げ（＝モデルが間違えた側）を
 * 「置き換える側もこの字下げで書かれている」と決めつけて、`replace` の
 * 全部の行から取り除いていた。**モデルは `find` だけ書き崩して、`replace` は
 * ファイルの通りに書いてくることがある**（読んだものを写すので、そちらは合う）。
 * そのとき `replace` は丸ごと一段ずれる。しかも当たったことになるので、
 * **モデルは直ったと思って先へ進む。**履歴 400 commit で測ると、
 * 字下げを一行崩しただけで 928 件中 839 件がこれだった。
 *
 * 見分け方は、`replace` の最初の中身の行が、どちらの字下げに揃っているか。
 * `find` と同じならモデルの枠。違うなら、既にファイルの側に合っている。
 */
function sameFrame(replace: string[], findIndent: string, fileIndent: string): boolean {
  if (findIndent === fileIndent) return false; // 寄せる先が同じ。何もしなくてよい
  const first = replace.find((l) => l.trim().length > 0);
  if (first === undefined) return false;
  return indentOf(first) === findIndent;
}
