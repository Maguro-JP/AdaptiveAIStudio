import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { unifiedDiff, diffStat } from '../diff.ts';
import { toolOutputBudget, cutToTokens } from '../window.ts';
import { applyHunks, splitHunks } from '../hunks.ts';
import { safeResolve, realSafeResolve, isSymlink, toDisplayPath } from './paths.ts';
import { type Tool, type ToolContext, ok, fail, requireString, optionalPositiveInt } from './types.ts';
import { applyEdit, nearestTo } from './write-kind.ts';
import { Ignores } from '../ignore.ts';
import { contentOf, type FileContent } from '../../harness/put-back.ts';

/**
 * utf8 で読めない中身の代わりに、差分へ出す一行。
 *
 * 化けた中身を差分に出さないための仮の文字で、ファイルの中身ではない。画面の札から塊・行ごとに
 * 戻す口（`/api/revert`）は、この行を含む差分を断る（当てるとこの文字がファイルに書かれる）。
 */
export function opaqueLine(bytes: number): string {
  return `（utf8 で読めない中身 ${bytes} バイト）`;
}
export const OPAQUE_LINE = /^（utf8 で読めない中身 \d+ バイト）$/;

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'target', '.venv']);
const MAX_READ_BYTES = 400_000;

export const readFileTool: Tool = {
  schema: {
    name: 'read_file',
    description: 'ファイルの内容を読む。行番号つきで返る。長いファイルは offset で続きから読む。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '作業ディレクトリからの相対パス' },
        offset: { type: 'number', description: '何行目から読むか（1 から数える。省略すると先頭から）' },
        limit: { type: 'number', description: '何行読むか（省略するとコンテキストウィンドウに入るだけ）' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  async run(args, ctx) {
    const p = requireString(args, 'path');
    if (!p) return fail('path が必要です。');
    // リンクを辿った先まで見る。作業場の中のリンク一つで外が読めてしまう。
    const abs = await realSafeResolve(ctx.root, p);
    if (!abs) return fail(`作業ディレクトリの外です: ${p}`);
    try {
      const info = await stat(abs);
      if (info.size > MAX_READ_BYTES) {
        return fail(`ファイルが大きすぎます (${info.size} bytes)。search_text で絞り込んでください。`);
      }
      /*
       * **utf8 で読めないものは、読めないと言う。**文字として読むと、二進や Shift_JIS は化けた字
       * （U+FFFD）になり、モデルはそれを中身だと思って直しにかかる。判じ方は「戻す」と同じ（`contentOf`）。
       */
      const bytes = await readFile(abs);
      const text = contentOf(bytes);
      if (typeof text !== 'string') {
        return fail(
          `${p} は utf8 で読めません（二進か、別の文字コード。${bytes.length} バイト）。中身は渡しません。`,
        );
      }
      const all = text.split('\n');
      /*
       * **続きから読めるようにする。**
       *
       * ここは丸ごと読んで、コンテキストウィンドウに入る分で切っていた。
       * 切ったあとの案内は「search_text か find_code で絞ってください」で、
       * **続きを読む道を一つも持っていなかった。**既定の 8192 では 130 行ほどで
       * 切れるので、それより下に在るものは一行も読めない。当たる言葉を知って
       * いれば search_text で覗けるが、知らないから読もうとしている。
       *
       * 行の番号で切り出す。番号は**ファイルの中の本当の番号**を出す
       * （切り出した中での番号にすると、edit_file へ渡す手掛かりが狂う）。
       */
      const from = optionalPositiveInt(args, 'offset') ?? 1;
      if (from > all.length) {
        return fail(`${all.length} 行しかありません: offset=${from}`);
      }
      const limit = optionalPositiveInt(args, 'limit');
      const taken = all.slice(from - 1, limit === undefined ? undefined : from - 1 + limit);
      const numbered = taken.map((l, i) => `${from + i}\t${l}`).join('\n');
      const rest = (last: number): string =>
        `\n…（${last} 行目まで。全体は ${all.length} 行。続きは offset=${last + 1} で読めます）`;
      // **窓に収まる分だけ返す。**丸ごと返すと、一度読んだだけで溢れる。
      const budget = ctx.contextTokens ? toolOutputBudget(ctx.contextTokens) : undefined;
      if (budget !== undefined) {
        // **トークンで測る。**ここまで、トークンの予算を文字数と突き合わせて
        // いたので、日本語ではたまたま合い、英語では4分の1しか使えていなかった。
        const shown = cutToTokens(numbered, budget, ctx.count);
        if (shown.length < numbered.length) {
          /*
           * `cutToTokens` は行の切れ目まで戻すが、**1 行が入り切らないときは
           * 戻る先が無い。**そのときは行の途中で切れる（`あ` を 6 万字並べた
           * ような形。実際に在る）。
           *
           * ここで「続きは offset=2 で読めます」と出すと**嘘になる。**
           * 2 行目は無いし、offset は行でしか動かないので、この行の残りは
           * どうやっても取れない。取れないものを案内しない。
           */
          const atLineEnd = numbered[shown.length] === '\n';
          const last = from - 1 + shown.split('\n').length;
          return ok(atLineEnd
            ? `${shown}${rest(last)}`
            : `${shown}\n…（${last} 行目の途中まで。この 1 行が長すぎて入りません。`
              + 'この先は search_text か find_code で絞ってください）');
        }
      }
      const last = from - 1 + taken.length;
      if (last < all.length) return ok(`${numbered}${rest(last)}`);
      return ok(numbered);
    } catch (e) {
      return fail(`読めません: ${p} (${describe(e)})`);
    }
  },
};

export const listFilesTool: Tool = {
  schema: {
    name: 'list_files',
    description: 'ディレクトリ配下のファイル一覧を返す。.gitignore に書かれたものと node_modules や .git は除外される。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相対パス。省略時は作業ディレクトリ全体' },
      },
      additionalProperties: false,
    },
  },
  async run(args, ctx) {
    const p = typeof args.path === 'string' && args.path ? args.path : '.';
    /*
     * **リンクを辿った先まで見る。**`read_file` はそうしていたが、ここは
     * 文字の上でしか見ていなかった。作業ディレクトリの中に外を指すリンクが
     * 一つあれば、そこを path に渡すだけで**外のファイル名が並ぶ**
     * （中身は read_file が断るが、名前は出る）。実際に出した。
     * 木を降りるときは Dirent がリンクを「ファイルでもディレクトリでもない」
     * として飛ばすので、漏れるのは**名指しで渡されたとき**だけ。そこを塞ぐ。
     */
    const abs = await realSafeResolve(ctx.root, p);
    if (!abs) return fail(`作業ディレクトリの外です: ${p}`);
    const found: string[] = [];
    const walked = { capped: false };
    try {
      await walk(abs, ctx.root, found, 0, await ignoresFor(ctx.root, p), walked);
    } catch (e) {
      return fail(`一覧できません: ${p} (${describe(e)})`);
    }
    if (found.length === 0) return ok('(ファイルなし)');
    const shown = found.slice(0, 300);
    const more = found.length > shown.length ? `\n... 他 ${found.length - shown.length} 件` : '';
    // **見て回るのを途中でやめたことも言う。**「他 N 件」だけだと、
    // その N が全部だと読める。
    const stopped = walked.capped
      ? `\n（ファイルが多いので ${WALK_FILES} 個までしか見ていません。path で絞ってください）`
      : '';
    return ok(shown.join('\n') + more + stopped);
  },
};

/** 探した結果、一件ぶん。 */
export interface TextHit {
  /** 作業ディレクトリからの相対パス */
  path: string;
  /** 1 から数えた行番号 */
  line: number;
  /** その行（前後の空白を落とし、長すぎる分は切る） */
  text: string;
}

/** 探した結果と、**見ていない分**。 */
export interface TextSearch {
  hits: TextHit[];
  /** 件数で打ち切った */
  capped: boolean;
  /** ファイルが多すぎて、途中までしか見ていない */
  walkCapped: boolean;
  /** 大きすぎて開いていないファイルの数 */
  tooBig: number;
  /** 探しにすら行けなかったときの理由 */
  error?: string;
}

/**
 * 文字列で探す。
 *
 * **画面とツールで、同じものを使う。**ここはツールの中に書いてあったので、
 * 画面から探す口を作ろうとすると同じ処理を二度書くことになる。二度書けば、
 * 片方だけ直る日が必ず来る（.gitignore を見る／見ない、打ち切りを言う／言わない）。
 * 探すのはここ一つにして、言葉に直すのはツールの側でやる。
 */
export async function searchText(
  root: string,
  query: string,
  base: string,
  signal: AbortSignal,
): Promise<TextSearch> {
  const out: TextSearch = { hits: [], capped: false, walkCapped: false, tooBig: 0 };
  // list_files と同じ理由でリンクの先まで見る。片方だけ塞いでも漏れる。
  const abs = await realSafeResolve(root, base);
  if (!abs) return { ...out, error: `作業ディレクトリの外です: ${base}` };

  const files: string[] = [];
  const walked = { capped: false };
  /*
   * **探せなかったことを、該当なしと言わない。**
   *
   * ここは失敗を握り潰していた。無い道・ファイルを指す道・読めない道を
   * 渡すと、探しにすら行っていないのに `該当なし` と返る。モデルは
   * 「そこには無い」と読んで、別の場所を探しに行かない。打ち間違いが
   * **事実として返ってくる**のがいちばん困る形。
   */
  try {
    // **ファイルを指されたら、その一つを探す。**モデルはよく渡してくる。
    // ここで readdir に落として ENOTDIR を返すと、使い方の間違いにしか見えない。
    const info = await stat(abs);
    if (info.isFile()) files.push(toDisplayPath(root, abs));
    else await walk(abs, root, files, 0, await ignoresFor(root, base), walked);
  } catch (e) {
    return { ...out, error: `探せません: ${base} (${describe(e)})` };
  }
  out.walkCapped = walked.capped;

  /*
   * **打ち切ったことを、必ず言う。**
   *
   * 100 件で止めていて、何も言っていなかった。呼び出し元を全部直したい
   * ときに、モデルは 100 件で全部だと思う。**残りは直されないまま残る。**
   * 直したつもりで壊れているのが、いちばん見つけにくい。
   */
  for (const rel of files) {
    if (out.hits.length >= SEARCH_HITS) { out.capped = true; break; }
    if (signal.aborted) break;
    const target = await realSafeResolve(root, rel);
    if (!target) continue;
    try {
      const info = await stat(target);
      // 大きすぎて見ていないファイルも、見ていないと言う。
      if (info.size > MAX_READ_BYTES) { out.tooBig += 1; continue; }
      const text = await readFile(target, 'utf8');
      if (!text.includes(query)) continue;
      text.split('\n').forEach((line, i) => {
        if (!line.includes(query)) return;
        if (out.hits.length < SEARCH_HITS) {
          out.hits.push({ path: rel, line: i + 1, text: line.trim().slice(0, 200) });
        } else {
          out.capped = true;
        }
      });
    } catch { /* バイナリ等は読み飛ばす */ }
  }
  return out;
}

export const searchTextTool: Tool = {
  schema: {
    name: 'search_text',
    description: 'ファイル内容を文字列で検索し、該当箇所をファイル名:行番号つきで返す。.gitignore に書かれたものは探さない。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '検索する文字列' },
        path: { type: 'string', description: '検索範囲の相対パス。省略可' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  async run(args, ctx) {
    const query = requireString(args, 'query');
    if (!query) return fail('query が必要です。');
    const base = typeof args.path === 'string' && args.path ? args.path : '.';
    const found = await searchText(ctx.root, query, base, ctx.signal);
    if (found.error) return fail(found.error);

    const notes: string[] = [];
    if (found.capped) {
      notes.push(
        `（${SEARCH_HITS} 件で打ち切りました。**これで全部ではありません。**`
        + 'path を絞るか、query を長くして探し直してください）',
      );
    }
    if (found.walkCapped) {
      notes.push(`（ファイルが多いので ${WALK_FILES} 個までしか見ていません。path で絞ってください）`);
    }
    if (found.tooBig > 0) {
      notes.push(`（大きすぎて見ていないファイルが ${found.tooBig} 個あります）`);
    }
    const tail = notes.length > 0 ? `\n${notes.join('\n')}` : '';
    const lines = found.hits.map((h) => `${h.path}:${h.line}: ${h.text}`);
    return ok(lines.length > 0 ? lines.join('\n') + tail : `該当なし: ${query}${tail}`);
  },
};

export const writeFileTool: Tool = {
  schema: {
    name: 'write_file',
    description:
      'ファイルを作成または上書きする。内容は全文を渡すこと。実行前に差分が利用者へ提示され、承認が要る。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相対パス' },
        content: { type: 'string', description: 'ファイルの全内容' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  async run(args, ctx) {
    const p = requireString(args, 'path');
    const content = typeof args.content === 'string' ? args.content : undefined;
    if (!p) return fail('path が必要です。');
    if (content === undefined) return fail('content が必要です。');

    const abs = await realSafeResolve(ctx.root, p);
    if (!abs) return fail(`作業ディレクトリの外です: ${p}`);
    // 書く先そのものがリンクなら書かない。`link -> .env` に書けば .env が
    // 書き換わるのに、守り（protected-paths）は `link` しか見ていない。
    if (await isSymlink(safeResolve(ctx.root, p) ?? abs)) {
      return fail(`リンク越しには書きません: ${p}（実体を直接指定してください）`);
    }

    return commit(ctx, abs, p, content);
  },
};

/**
 * 同じファイルへの書き込みを、重ねない。
 *
 * 押さえているのは段取りが**宣言した**書き込み先だけ（`src/core/scheduler.ts` の
 * `writes`）で、宣言は模型の当て推量なので、同じファイルへ二人が同時に入ることが
 * ある。そうなると、読み直して見比べてから書くまでのあいだに相手の書き込みが挟まり、
 * **どちらも「書けた」と返すのに、片方の中身しか残らない。**
 *
 * 書き換える道はここ一本なので、ここで順番に通す。承認を待っているあいだは
 * 押さえない（10 分のあいだ、別の担当の書き込みまで止めることになる）。
 * 待たせるのは、読み直してから書き終えるまで。
 */
const oneAtATime = new Map<string, Promise<unknown>>();

async function serialized<T>(key: string, run: () => Promise<T>): Promise<T> {
  const prev = oneAtATime.get(key) ?? Promise.resolve();
  // 前が失敗しても列は進める（失敗した相手のせいで、以後ずっと書けない、をなくす）。
  const mine = prev.then(run, run);
  const marker = mine.then(() => undefined, () => undefined);
  oneAtATime.set(key, marker);
  try {
    return await mine;
  } finally {
    // 自分の後ろに誰も並んでいなければ、鍵を捨てる（溜めない）。
    if (oneAtATime.get(key) === marker) oneAtATime.delete(key);
  }
}

/**
 * 中身を書き込むところ。**書き換えるツールは、必ずここを通す。**
 *
 * 承認・差分・改行の合わせ方が、ツールごとに散ると必ずずれる。
 * 片方だけ承認を通さない、片方だけ CRLF を潰す、という形になる。
 */
async function commit(
  ctx: ToolContext, abs: string, shown: string, content: string,
): Promise<{ content: string; isError?: boolean }> {
  let before = '';
  let created = false;
  /**
   * 書く前の中身を、**バイト列で**持つ。utf8 で往復しないもの（Shift_JIS の文書、二進）を
   * 文字列で持つと U+FFFD に置き換わり、戻り先へ記録した中身も化ける（「戻す」を押しても元に戻らない）。
   */
  let priorBytes: Buffer | undefined;
  let prior: FileContent | undefined;
  try {
    priorBytes = await readFile(abs);
    prior = contentOf(priorBytes);
    // 差分に出すための文字。utf8 で読めないものは中身の代わりに大きさだけ見せる（化けた差分を見せない）。
    before = typeof prior === 'string' ? prior : `${opaqueLine(priorBytes.length)}\n`;
  } catch {
    created = true;
  }
  const opaque = prior !== undefined && typeof prior !== 'string';

  // 元の改行に合わせる。Windows で取ってきた木は CRLF のことがあり、
  // モデルは LF で書き戻す。そのまま書くと**1行も直していないのに
  // ファイル全体が変更扱い**になり、差分を見る意味がなくなる。
  // utf8 で読めないものは、仮の一行ではなく元のバイト列で改行を数える（latin1 は 1 バイト 1 文字で、改行を崩さない）。
  const written = matchLineEndings(content, opaque ? priorBytes!.toString('latin1') : before);

  /*
   * **空のファイルを作る道を塞がない。**
   *
   * 無いファイルに空の中身を書くと `before`（''）と同じになるので、ここで
   * 「変更なし」と返して**何も作っていなかった**。頼んだ側には変更が無いと
   * 見えるのに、ファイルは生まれていない。作るときは、空でも通す。
   */
  if (before === written && !created && !opaque) return ok(`変更なし: ${shown}`);

  const display = toDisplayPath(ctx.root, abs);
  // 差分は LF に揃えて見せる。^M が全行に並ぶと読めない。
  const diff = unifiedDiff(display, toLf(before), toLf(written));
  const answer = await ctx.approve({ kind: 'write', path: display, diff, created });
  if (answer === false) return fail(`利用者が書き込みを拒否しました: ${shown}`);

  // ここから先は、同じファイルに一人ずつ。読み直してから書き終えるまで割り込ませない。
  return serialized(abs, async () => {
    /*
     * **承認を待っているあいだに、ディスクが変わっていることがある。**
     *
     * 中身を読んだのは承認を訊く前で、返事は 10 分待つ（`src/ui/server.ts`）。
     * その間に人が外のエディタで直して保存し、それから許可を押すと、ここは
     * **待つ前に読んだ中身をそのまま書いて**直しを消していた。しかも戻り先へ
     * 控えるのも待つ前の中身なので、**戻しても直しは返ってこない。**
     * 塊を選んで通すときの当て先（`before`）も同じく古い。
     *
     * 変わっていたら書かない。読み直してから、と返す。
     */
    // バイト列で比べる。文字にしてから比べると、utf8 で読めないものは違う中身でも同じに見える。
    const nowOnDisk = await readFile(abs).catch(() => undefined);
    const same = created ? nowOnDisk === undefined : nowOnDisk !== undefined && priorBytes!.equals(nowOnDisk);
    if (!same) {
      return fail(`待っているあいだに ${shown} が変わりました。`
        + '読み直してから、もう一度書いてください（いまの中身は消していません）');
    }

    // **一部だけ通す。**通らなかった塊は、通らなかったとモデルへ返す。
    // 黙って落とすと、直したつもりのまま次へ進んで、噛み合わなくなる。
    let body = written;
    let partial = '';
    // `'all'`（この依頼のあいだは訊かない）は、ここまで来ない形にしてある
    // （画面の側で `true` に直す）。それでも、来たら通す側として扱う。
    if (answer !== true && answer !== 'all' && !(created && written === '')) {
      // 塊を当てる先（`before`）が中身そのものではないので、一部だけは当てられない。
      if (opaque) return fail(`utf8 で読めないファイルは、一部だけ通すことができません: ${shown}`);
      const all = splitHunks(diff);
      const took = [...new Set(answer.hunks)].filter((i) => i >= 0 && i < all.length).sort((a, b) => a - b);
      if (took.length === 0) return fail(`利用者が書き込みを拒否しました: ${shown}`);
      const built = applyHunks(toLf(before), diff, took);
      if (built === undefined) return fail(`選ばれた分だけを当てられません: ${shown}`);
      body = matchLineEndings(built, before);
      if (took.length < all.length) {
        partial = `（${all.length} か所のうち ${took.length} か所だけ通りました。残りは通っていません）`;
      }
    }

    if (body === before && !created && !opaque) return ok(`変更なし: ${shown}${partial}`);

    // **書き換える直前に控える。**ここを通らない書き込みは無いので、
    // 戻せないものが生まれない。
    ctx.beforeWrite?.(display, created ? undefined : prior);

    try {
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, body, 'utf8');
    } catch (e) {
      return fail(`書き込めません: ${shown} (${describe(e)})`);
    }

    const applied = unifiedDiff(display, toLf(before), toLf(body));
    const { added, removed } = diffStat(applied);
    // **書いたものを、書いた側から知らせる。**提案そのままの差分と食い違うため。
    ctx.wrote?.(display, applied, created);
    return ok((created ? `作成: ${display}（${added}行）` : `更新: ${display}（+${added} -${removed}）`) + partial);
  });
}

/**
 * ファイルの一部だけを差し替える。
 *
 * **これが無いと、ローカルの小さいモデルではコーディングが成り立たない。**
 * `write_file` は全文渡し。300行のファイルを1行直すために、300行を
 * そっくり書き戻させることになる。4B の窓（8192）では出力だけで溢れるし、
 * 溢れなくても途中で崩れて、**直していないところを壊す**。
 *
 * 当てる場所は、探す文字列で決める。行番号にしない。行番号は、
 * 直した瞬間にずれる（モデルは読んだときの番号のまま次を指す）。
 */
/**
 * 渡された直しを、並びとして受け取る。
 *
 * 一つだけのとき（`find` / `replace`）と、並べたとき（`edits`）の両方を
 * 受ける。**どちらも無いときは、そう言う。**片方だけ渡されたときも同じ。
 * 文字で理由を返し、通ったときだけ並びを返す。
 */
function parseEdits(
  args: Record<string, unknown>,
): { find: string; replace: string; all?: boolean }[] | string {
  const raw = args.edits;
  if (Array.isArray(raw)) {
    if (raw.length === 0) return 'edits が空です。直すところがありません。';
    const out: { find: string; replace: string; all?: boolean }[] = [];
    for (const [i, e] of raw.entries()) {
      const one = e as { find?: unknown; replace?: unknown; all?: unknown };
      if (typeof one?.find !== 'string') return `edits[${i}].find が必要です。`;
      if (typeof one?.replace !== 'string') return `edits[${i}].replace が必要です。`;
      if (one.find.length === 0) return `edits[${i}].find が空です。置き換える場所が決まりません。`;
      out.push({ find: one.find, replace: one.replace, ...(one.all === true ? { all: true } : {}) });
    }
    return out;
  }
  const find = typeof args.find === 'string' ? args.find : undefined;
  const replace = typeof args.replace === 'string' ? args.replace : undefined;
  if (find === undefined) return 'find が必要です。';
  if (replace === undefined) return 'replace が必要です。';
  if (find.length === 0) return 'find が空です。差し替える場所が決まりません。';
  return [{ find, replace, ...(args.all === true ? { all: true } : {}) }];
}

export const editFileTool: Tool = {
  schema: {
    name: 'edit_file',
    description:
      'ファイルの一部を差し替える。find に「いまある文字列」、replace に「置き換えた後の文字列」を渡す。'
      + '全文を書き直す必要はない。find は前後を少し含めて、file の中で一意になるようにすること。'
      + '同じファイルの複数箇所を直すときは edits に並べて一度に渡す（訊かれるのも書くのも一度で済む）。'
      + '実行前に差分が利用者へ提示され、承認が要る。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相対パス' },
        find: { type: 'string', description: 'いまファイルにある文字列（そのまま一致するもの）' },
        replace: { type: 'string', description: '置き換えた後の文字列' },
        all: { type: 'boolean', description: '複数見つかったとき、全部置き換えるなら true（既定 false）' },
        edits: {
          type: 'array',
          description:
            '複数箇所をまとめて直すとき。上から順に当てる。'
            + '一つでも当たらなければ、何も書かない（半分だけ直った形にしない）。',
          items: {
            type: 'object',
            properties: {
              find: { type: 'string' },
              replace: { type: 'string' },
              all: { type: 'boolean' },
            },
            required: ['find', 'replace'],
            additionalProperties: false,
          },
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  async run(args, ctx) {
    const p = requireString(args, 'path');
    if (!p) return fail('path が必要です。');

    /*
     * **同じファイルの直しを、一度で当てる。**
     *
     * ここは find/replace を一つずつしか受けなかった。5 か所直すなら 5 回
     * 呼ぶことになり、そのたびに差分が出て、そのたびに訊かれ、そのたびに
     * 書き込む。**戻り先も 5 つに割れる**ので、一つの直しとして戻せない。
     *
     * 並べて渡せるようにした。**一つでも当たらなければ、何も書かない。**
     * 半分だけ直った形は、直っていないより悪い（次に読んだとき、どこまで
     * 進んだのか分からない）。
     */
    const list = parseEdits(args);
    if (typeof list === 'string') return fail(list);

    const abs = await realSafeResolve(ctx.root, p);
    if (!abs) return fail(`作業ディレクトリの外です: ${p}`);
    if (await isSymlink(safeResolve(ctx.root, p) ?? abs)) {
      return fail(`リンク越しには書きません: ${p}（実体を直接指定してください）`);
    }

    const bytes = await readFile(abs).catch(() => undefined);
    if (bytes === undefined) {
      return fail(`まだありません: ${p}（新しく作るなら write_file を使ってください）`);
    }
    const before = contentOf(bytes);
    /*
     * **utf8 で読めないファイルは、一部だけ書き換えない。**
     * 文字として読んで書き戻すと、直していない行（Shift_JIS の日本語など）まで U+FFFD に化ける。
     */
    if (typeof before !== 'string') {
      return fail(`utf8 で読めないファイルです: ${p}（Shift_JIS などの文書か、二進のファイル）。`
        + '一部だけ書き換えると、直していない所まで文字が化けます。**何も書いていません。**');
    }

    // モデルは LF で書いてくる。中身が CRLF だと、**そのままでは一致しない。**
    // 「無い」と言われて、モデルは同じことを何度も試す。合わせてから探す。
    const lfBefore = toLf(before);
    let text = lfBefore;
    let loose = false;
    let how: string | undefined;
    for (const [i, e] of list.entries()) {
      // 何番目かは、二つ以上あるときだけ言う。一つのときに「1 つ目」と
      // 言われても、どれのことか分からない。
      const which = list.length > 1 ? `（${i + 1} つ目）` : '';
      const got = applyEdit(text, toLf(e.find), toLf(e.replace), e.all === true);
      if (got.hits === 0) {
        // **いちばん近い場所を、その場で見せる。**「読み直してください」だけだと
        // 一往復まるごと払ううえ、ファイル全体が窓に入り、それでも次も外す。
        const near = nearestTo(text, toLf(e.find));
        return fail(
          `見つかりません${which}: ${p} の中に find の文字列がありません。\n`
          + (near ? `${near}\n` : '')
          + 'ここにあるとおりの文字列を find に渡し直してください'
          + '（空白や改行まで一致させる必要があります）。'
          + (near ? '' : ' 見当が付かなければ read_file で読み直してください。')
          + (list.length > 1 ? '\n**何も書いていません。**並べたもの全部を渡し直してください。' : ''),
        );
      }
      if (got.hits > 1 && e.all !== true) {
        return fail(
          `${got.hits} 箇所に当てはまります${which}: ${p}。どこを直すのか決まりません。`
          + 'find に前後を少し足して一意にするか、全部直すなら all を true にしてください。'
          + (list.length > 1 ? '\n**何も書いていません。**' : ''),
        );
      }
      text = got.text;
      if (got.loose) { loose = true; how = got.how; }
    }

    // **ゆるく当てたことは黙らない。**字下げや行末の空白が違っていたので
    // こちらで合わせた、と分かるようにする。黙って当てると、渡した文字列が
    // 正しかったのだと思い込んだまま、次も同じ形で渡してくる。
    const got = await commit(ctx, abs, p, text);
    // **どう譲って当てたかを、必ず言う。**黙って当てると、渡した文字列が
    // 正しかったのだと思い込んだまま、次も同じ形で渡してくる。
    if (loose && !got.isError) {
      const note = how === 'anchor'
        ? '（最初と最後の行だけが一致したので、その間を丸ごと置き換えました。'
          + '**渡された find の真ん中は、ファイルの中身と違っていました。**'
          + '意図と違っていたら、read_file で読み直して確かめてください）'
        : '（字下げか行末の空白が違っていたので、ファイルの側に合わせて当てました）';
      return { ...got, content: `${got.content}\n${note}` };
    }
    return got;
  },
};

/** 一度に見て回るファイル数の上限。**当たったら言う。** */
const WALK_FILES = 3000;

/** 検索で返す当たりの上限。**当たったら言う。** */
const SEARCH_HITS = 100;

async function walk(
  dir: string, root: string, out: string[], depth: number, ign?: Ignores,
  capped?: { capped: boolean },
): Promise<void> {
  if (out.length >= WALK_FILES) { if (capped) capped.capped = true; return; }
  if (depth > 12) return;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.github') continue;
    if (SKIP_DIRS.has(e.name)) continue;
    const abs = join(dir, e.name);
    // **その置き場が「見なくていい」と書いたものを見ない。**
    const rel = relative(root, abs).split(sep).join('/');
    if (ign?.ignores(rel, e.isDirectory())) continue;
    if (e.isDirectory()) await walk(abs, root, out, depth + 1, await ign?.enter(rel), capped);
    else if (e.isFile()) out.push(toDisplayPath(root, abs));
  }
}

/**
 * その場所まで降りた状態の決まりを作る。
 *
 * 途中の階に置かれた `.gitignore` も効くので、根から順に降りて重ねる。
 */
async function ignoresFor(root: string, rel: string): Promise<Ignores> {
  let ign = await Ignores.load(root);
  if (rel === '.' || rel === '') return ign;
  const parts = rel.split(/[\\/]/).filter((s) => s.length > 0 && s !== '.');
  let here = '';
  for (const part of parts) {
    here = here ? `${here}/${part}` : part;
    ign = await ign.enter(here);
  }
  return ign;
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 元のファイルの改行に合わせる。
 *
 * Windows で取ってきた木は CRLF のことがあり、モデルは LF で書き戻す。
 * そのまま書くと、1行も直していないのにファイル全体が変更扱いになる。
 * 差分を見て承認する仕組みなので、これは致命的で、
 * **利用者は毎回「全部書き換わった」ものを承認させられる**ことになる。
 *
 * 混ざっている場合は多い方に寄せる。元が空（新規）なら、そのまま。
 */
export function matchLineEndings(content: string, before: string): string {
  if (before === '') return content;

  const crlf = (before.match(/\r\n/g) ?? []).length;
  const lf = (before.match(/\n/g) ?? []).length - crlf;
  if (crlf === 0 || crlf < lf) return toLf(content);

  return toLf(content).replace(/\n/g, '\r\n');
}

/** 改行を LF に揃える。比べるときと、差分を見せるときに使う。 */
export function toLf(s: string): string {
  return s.replace(/\r\n/g, '\n');
}
