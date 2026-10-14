/**
 * コードを当てる道具。
 *
 * `search_text` は完全一致の grep なので、**名前が分かっているときしか使えない**。
 * 分かっていないときに何も出ず、当てずっぽうにファイルを開いて回ることになる。
 * 8k の窓では、そこで力尽きる。
 *
 * こちらは「どこに在りそうか」を返す。**ファイル丸ごとではなく、
 * 当たった名前と行だけ**を返すのが要点。丸ごと返すと窓が埋まる。
 */
import { join } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { realSafeResolve } from './paths.ts';
import { stateDir } from '../../core/home.ts';
import { IndexStore, MAX_FILE, type CodeIndex } from '../code-index.ts';
import { searchIndex, lookupSymbol } from '../code-index.ts';
import { type Tool, ok, fail, requireString, optionalPositiveInt } from './types.ts';

/**
 * 索引の置き場。作業場ごとに持つ。
 *
 * **一つだけ持つ。**地図（`repo-map.ts`）も同じものを見る。二つ持つと、
 * 同じ木を二度歩いて、同じものを二度覚えることになる。
 */
export const indexStore = new IndexStore(join(stateDir(), 'index'));
const store = indexStore;

/**
 * 索引に載った道を読む。索引を作り直さない間（1.5 秒）にファイルが作業場の外を指すリンクへ替わっても、外を読まない。
 * 索引に入れない大きさのものも読まない（作った後で大きくなったもの）。
 */
export async function readIndexed(root: string, p: string): Promise<string> {
  const abs = await realSafeResolve(root, p);
  if (!abs) throw new Error(`作業ディレクトリの外です: ${p}`);
  const info = await stat(abs);
  if (!info.isFile() || info.size > MAX_FILE) throw new Error(`読みません: ${p}`);
  return readFile(abs, 'utf8');
}

export const findCodeTool: Tool = {
  schema: {
    name: 'find_code',
    description:
      '作業場の中から、関係のありそうなコードを探す。'
      + '名前が分からなくてもよい（「設定を保存している所」のような言葉で探せる）。'
      + 'ファイル名・関数名・中身の三方向から当てて、当たった行だけを返す。'
      + 'どこを直せばいいか分からないときは、まずこれを使う。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '探したいもの。日本語でよい' },
        limit: { type: 'number', description: '返すファイル数。既定 8' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  async run(args, ctx) {
    const query = requireString(args, 'query');
    if (!query) return fail('query が必要です。');
    // 数を文字列で渡してくるモデルがある（`"2"`）。それも読む（数のときだけ読んでいたので、既定の 8 件を返していた）
    const limit = Math.min(optionalPositiveInt(args, 'limit') ?? 8, 20);

    let index: CodeIndex;
    try {
      index = await store.fresh(ctx.root);
    } catch (e) {
      return fail(`作業場を読めません: ${(e as Error).message}`);
    }
    if (index.files.length === 0) {
      return ok(`作業場に読めるコードがありません: ${ctx.root}`);
    }

    const matched = { files: 0 };
    const hits = await searchIndex(index, query, {
      limit,
      matched,
      read: (p) => readIndexed(ctx.root, p),
    });
    /*
     * **索引に入っていないものがあるなら、必ず言う。**
     *
     * 上限（4000 ファイル）で切られた分は「無い」と返る。無いと言われた側は
     * コードが無いのだと思って、別のやり方を探しはじめる。
     * **静かに間違った答えを返すのが、いちばん悪い。**
     */
    const notAll = index.capped
      ? `\n（この置き場は大きいので、${index.files.length} ファイルまでしか見ていません。`
        + `あと ${index.capped} ファイルあります。見つからないときは search_text も試してください）`
      : '';

    if (hits.length === 0) {
      return ok(
        `見つかりません: ${query}\n`
        + `（${index.files.length} ファイルを見ました。言葉を変えるか、`
        + 'search_text で正確な文字列を探してください）'
        + notAll,
      );
    }

    // 上位だけを返したときは、ほかにも当たったと言う（3 件と言うと、当たったのが 3 ファイルだけだと読まれた）
    const more = matched.files > hits.length ? `。ほかに ${matched.files - hits.length} ファイル当たっています（limit を上げるか、言葉を足して絞ってください）` : '';
    const lines: string[] = [`${hits.length} 件（${index.files.length} ファイル中）${more}${notAll}`];
    for (const h of hits) {
      lines.push('');
      lines.push(h.path);
      for (const s of h.symbols) lines.push(`  ${s.name}  (${h.path}:${s.line})`);
      for (const l of h.lines) lines.push(`  ${l.line}: ${l.text}`);
    }
    return ok(lines.join('\n'));
  },
};
/**
 * 名前で引いて、そこへ飛ぶ。
 *
 * `find_code` は言葉から当てる道。**名前がもう分かっているときには遠回り**
 * になる。関数名を知っているのに、点数の高い順に 8 ファイル読まされて、
 * その中に無ければ諦めることになる。
 *
 * 索引には名前と行が既に入っている。引くだけで、宣言の場所と、使っている
 * ファイルが出る。
 */
export const findSymbolTool: Tool = {
  schema: {
    name: 'find_symbol',
    description:
      '名前（関数・クラス・型・定数）で引いて、宣言している場所と、使っている'
      + 'ファイルを返す。名前が分かっているときは find_code より速く、確実。'
      + '打ち間違いのときは、綴りの近いものを出す。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '引きたい名前。そのまま書く' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  async run(args, ctx) {
    const name = requireString(args, 'name');
    if (!name) return fail('name が必要です。');

    let index: CodeIndex;
    try {
      index = await store.fresh(ctx.root);
    } catch (e) {
      return fail(`作業場を読めません: ${(e as Error).message}`);
    }

    const got = lookupSymbol(index, name);
    // 索引に入り切っていないなら、必ず言う。無いと言われた側は
    // 「コードが無い」と読む。
    const notAll = index.capped
      ? `\n（このリポジトリは大きいので、${index.files.length} ファイルまでしか見ていません。`
        + `あと ${index.capped} ファイルあります）`
      : '';

    if (got.defined.length === 0) {
      return ok(
        `宣言が見つかりません: ${name}\n`
        + (got.near.length > 0
          ? `近い名前: ${got.near.join(', ')}\n`
          : '')
        + `（${index.files.length} ファイルを見ました。中身の文字列を探すなら search_text）`
        + notAll,
      );
    }

    const lines: string[] = [];
    lines.push(`宣言 ${got.defined.length} 件${notAll}`);
    for (const d of got.defined) {
      lines.push(`  ${d.path}:${d.line}${d.exported ? '  (export)' : ''}`);
    }
    if (got.used.length > 0) {
      lines.push('');
      lines.push(`使っている ${got.used.length} ファイル`);
      for (const p of got.used.slice(0, 30)) lines.push(`  ${p}`);
      if (got.used.length > 30) lines.push(`  … ほか ${got.used.length - 30} ファイル`);
    }
    return ok(lines.join('\n'));
  },
};
