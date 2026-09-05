import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { unifiedDiff, diffStat } from '../diff.ts';
import { toolOutputBudget, cutToTokens } from '../window.ts';
import { applyHunks, splitHunks } from '../hunks.ts';
import { safeResolve, realSafeResolve, isSymlink, toDisplayPath } from './paths.ts';
import { type Tool, type ToolContext, ok, fail, requireString } from './types.ts';
import { applyEdit } from './write-kind.ts';
import { Ignores } from '../ignore.ts';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'target', '.venv']);
const MAX_READ_BYTES = 400_000;

export const readFileTool: Tool = {
  schema: {
    name: 'read_file',
    description: 'ファイルの内容を読む。行番号つきで返る。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '作業ディレクトリからの相対パス' } },
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
      const text = await readFile(abs, 'utf8');
      const numbered = text.split('\n').map((l, i) => `${i + 1}\t${l}`).join('\n');
      // **窓に収まる分だけ返す。**丸ごと返すと、一度読んだだけで溢れる。
      const budget = ctx.contextTokens ? toolOutputBudget(ctx.contextTokens) : undefined;
      if (budget !== undefined) {
        // **トークンで測る。**ここまで、トークンの予算を文字数と突き合わせて
        // いたので、日本語ではたまたま合い、英語では4分の1しか使えていなかった。
        const shown = cutToTokens(numbered, budget, ctx.count);
        if (shown.length < numbered.length) {
          const lines = shown.split('\n').length;
          return ok(`${shown}\n…（${lines} 行目まで。この先は search_text か find_code で絞ってください）`);
        }
      }
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
    const abs = safeResolve(ctx.root, p);
    if (!abs) return fail(`作業ディレクトリの外です: ${p}`);
    const found: string[] = [];
    try {
      await walk(abs, ctx.root, found, 0, await ignoresFor(ctx.root, p));
    } catch (e) {
      return fail(`一覧できません: ${p} (${describe(e)})`);
    }
    if (found.length === 0) return ok('(ファイルなし)');
    const shown = found.slice(0, 300);
    const more = found.length > shown.length ? `\n... 他 ${found.length - shown.length} 件` : '';
    return ok(shown.join('\n') + more);
  },
};

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
    const abs = safeResolve(ctx.root, base);
    if (!abs) return fail(`作業ディレクトリの外です: ${base}`);

    const files: string[] = [];
    await walk(abs, ctx.root, files, 0, await ignoresFor(ctx.root, base)).catch(() => undefined);
    const hits: string[] = [];
    for (const rel of files) {
      if (hits.length >= 100) break;
      if (ctx.signal.aborted) break;
      const target = await realSafeResolve(ctx.root, rel);
      if (!target) continue;
      try {
        const info = await stat(target);
        if (info.size > MAX_READ_BYTES) continue;
        const text = await readFile(target, 'utf8');
        if (!text.includes(query)) continue;
        text.split('\n').forEach((line, i) => {
          if (hits.length < 100 && line.includes(query)) {
            hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 200)}`);
          }
        });
      } catch { /* バイナリ等は読み飛ばす */ }
    }
    return ok(hits.length > 0 ? hits.join('\n') : `該当なし: ${query}`);
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
 * 中身を書き込むところ。**書き換える道具は、必ずここを通す。**
 *
 * 承認・差分・改行の合わせ方が、道具ごとに散ると必ずずれる。
 * 片方だけ承認を通さない、片方だけ CRLF を潰す、という形になる。
 */
async function commit(
  ctx: ToolContext, abs: string, shown: string, content: string,
): Promise<{ content: string; isError?: boolean }> {
  let before = '';
  let created = false;
  try {
    before = await readFile(abs, 'utf8');
  } catch {
    created = true;
  }

  // 元の改行に合わせる。Windows で取ってきた木は CRLF のことがあり、
  // モデルは LF で書き戻す。そのまま書くと**1行も直していないのに
  // ファイル全体が変更扱い**になり、差分を見る意味がなくなる。
  const written = matchLineEndings(content, before);

  if (before === written) return ok(`変更なし: ${shown}`);

  const display = toDisplayPath(ctx.root, abs);
  // 差分は LF に揃えて見せる。^M が全行に並ぶと読めない。
  const diff = unifiedDiff(display, toLf(before), toLf(written));
  const answer = await ctx.approve({ kind: 'write', path: display, diff, created });
  if (answer === false) return fail(`利用者が書き込みを拒否しました: ${shown}`);

  // **一部だけ通す。**通らなかった塊は、通らなかったとモデルへ返す。
  // 黙って落とすと、直したつもりのまま次へ進んで、噛み合わなくなる。
  let body = written;
  let partial = '';
  if (answer !== true) {
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

  if (body === before) return ok(`変更なし: ${shown}${partial}`);

  try {
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, body, 'utf8');
  } catch (e) {
    return fail(`書き込めません: ${shown} (${describe(e)})`);
  }

  const { added, removed } = diffStat(unifiedDiff(display, toLf(before), toLf(body)));
  return ok((created ? `作成: ${display}（${added}行）` : `更新: ${display}（+${added} -${removed}）`) + partial);
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
export const editFileTool: Tool = {
  schema: {
    name: 'edit_file',
    description:
      'ファイルの一部を差し替える。find に「いまある文字列」、replace に「置き換えた後の文字列」を渡す。'
      + '全文を書き直す必要はない。find は前後を少し含めて、file の中で一意になるようにすること。'
      + '実行前に差分が利用者へ提示され、承認が要る。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相対パス' },
        find: { type: 'string', description: 'いまファイルにある文字列（そのまま一致するもの）' },
        replace: { type: 'string', description: '置き換えた後の文字列' },
        all: { type: 'boolean', description: '複数見つかったとき、全部置き換えるなら true（既定 false）' },
      },
      required: ['path', 'find', 'replace'],
      additionalProperties: false,
    },
  },
  async run(args, ctx) {
    const p = requireString(args, 'path');
    const find = typeof args.find === 'string' ? args.find : undefined;
    const replace = typeof args.replace === 'string' ? args.replace : undefined;
    if (!p) return fail('path が必要です。');
    if (find === undefined) return fail('find が必要です。');
    if (replace === undefined) return fail('replace が必要です。');
    if (find.length === 0) return fail('find が空です。差し替える場所が決まりません。');

    const abs = await realSafeResolve(ctx.root, p);
    if (!abs) return fail(`作業ディレクトリの外です: ${p}`);
    if (await isSymlink(safeResolve(ctx.root, p) ?? abs)) {
      return fail(`リンク越しには書きません: ${p}（実体を直接指定してください）`);
    }

    const before = await readFile(abs, 'utf8').catch(() => undefined);
    if (before === undefined) {
      return fail(`まだありません: ${p}（新しく作るなら write_file を使ってください）`);
    }

    // モデルは LF で書いてくる。中身が CRLF だと、**そのままでは一致しない。**
    // 「無い」と言われて、モデルは同じことを何度も試す。合わせてから探す。
    const lfBefore = toLf(before);
    const { text, hits, loose } = applyEdit(lfBefore, toLf(find), toLf(replace), args.all === true);
    if (hits === 0) {
      return fail(
        `見つかりません: ${p} の中に find の文字列がありません。`
        + 'read_file で読み直して、そこにあるとおりの文字列を渡してください'
        + '（空白や改行まで一致させる必要があります）。',
      );
    }
    if (hits > 1 && args.all !== true) {
      return fail(
        `${hits} 箇所に当てはまります: ${p}。どこを直すのか決まりません。`
        + 'find に前後を少し足して一意にするか、全部直すなら all を true にしてください。',
      );
    }

    // **ゆるく当てたことは黙らない。**字下げや行末の空白が違っていたので
    // こちらで合わせた、と分かるようにする。黙って当てると、渡した文字列が
    // 正しかったのだと思い込んだまま、次も同じ形で渡してくる。
    const got = await commit(ctx, abs, p, text);
    if (loose && !got.isError) {
      return {
        ...got,
        content: `${got.content}\n（字下げか行末の空白が違っていたので、ファイルの側に合わせて当てました）`,
      };
    }
    return got;
  },
};

async function walk(
  dir: string, root: string, out: string[], depth: number, ign?: Ignores,
): Promise<void> {
  if (depth > 12 || out.length >= 3000) return;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.github') continue;
    if (SKIP_DIRS.has(e.name)) continue;
    const abs = join(dir, e.name);
    // **その置き場が「見なくていい」と書いたものを見ない。**
    const rel = relative(root, abs).split(sep).join('/');
    if (ign?.ignores(rel, e.isDirectory())) continue;
    if (e.isDirectory()) await walk(abs, root, out, depth + 1, await ign?.enter(rel));
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
