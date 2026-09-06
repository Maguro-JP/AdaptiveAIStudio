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
import { stateDir } from '../../core/home.ts';
import { IndexStore, type CodeIndex } from '../code-index.ts';
import { searchIndex } from '../code-index.ts';
import { type Tool, ok, fail, requireString } from './types.ts';

/**
 * 索引の置き場。作業場ごとに持つ。
 *
 * **一つだけ持つ。**地図（`repo-map.ts`）も同じものを見る。二つ持つと、
 * 同じ木を二度歩いて、同じものを二度覚えることになる。
 */
export const indexStore = new IndexStore(join(stateDir(), 'index'));
const store = indexStore;

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
    const limit = typeof args.limit === 'number' ? Math.min(Math.max(1, args.limit), 20) : 8;

    let index: CodeIndex;
    try {
      index = await store.fresh(ctx.root);
    } catch (e) {
      return fail(`作業場を読めません: ${(e as Error).message}`);
    }
    if (index.files.length === 0) {
      return ok(`作業場に読めるコードがありません: ${ctx.root}`);
    }

    const hits = await searchIndex(index, query, {
      limit,
      read: (p) => import('node:fs/promises').then((fs) => fs.readFile(join(ctx.root, p), 'utf8')),
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

    const lines: string[] = [`${hits.length} 件（${index.files.length} ファイル中）${notAll}`];
    for (const h of hits) {
      lines.push('');
      lines.push(h.path);
      for (const s of h.symbols) lines.push(`  ${s.name}  (${h.path}:${s.line})`);
      for (const l of h.lines) lines.push(`  ${l.line}: ${l.text}`);
    }
    return ok(lines.join('\n'));
  },
};
