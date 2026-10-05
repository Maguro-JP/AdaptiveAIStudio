/**
 * 画面で選んでいる所を、AI に書き換えさせる。
 *
 * **ここまで、AI がファイルを直す道は「ディスクへ書く」しか無かった。**
 * 画面で直している最中（まだ保存していない）に書かれると、ファイルと欄が
 * 二つに割れる。人は自分の直しを預けて AI の版を出すしかなく、**選んだ所だけ
 * 直してほしいのに、それ以外の書きかけも道連れになる。**
 *
 * ここは欄の中だけを書き換える。**保存はしない。**人が見て、良ければ保存する。
 * 入れ替える範囲は**利用者が選んだ所**で、AI は文だけを出す（範囲まで AI に
 * 決めさせると、選んでいない所を書き換えられる）。
 */
import { realSafeResolve } from './paths.ts';
import { type Tool, ok, fail } from './types.ts';

/** 画面で、いま選んでいる所。送ってきた画面が決める。 */
export interface EditorSelection {
  /** 作業場からの相対の道。 */
  path: string;
  /** 選んでいる行（1 から。両端を含む）。 */
  from: number;
  to: number;
  /** 選んでいる字そのもの。画面で「まだそこに在るか」を見るために渡す。 */
  text: string;
}

/** いま選んでいる所を教える相手。画面が無い入口では置かない。 */
export type SelectionSource = () => EditorSelection | undefined;

/** 画面へ「ここをこう書き換えて」と伝える受け手。画面が無い入口では置かない。 */
export type PatchHook = (at: EditorSelection & { replacement: string }) => void;

export function createReplaceSelectionTool(where?: SelectionSource, onPatch?: PatchHook): Tool {
  return {
    schema: {
      name: 'replace_selection',
      description: '利用者が画面で選んでいる所を、書き換えた文に入れ替える（欄の中だけ。保存はしない）。'
        + '選んでいる所が無いときは使えない。ファイルそのものを直すなら edit_file を使う。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '選んでいる所と入れ替える文（選んだ範囲そのものを置き換える）' },
        },
        required: ['text'],
        additionalProperties: false,
      },
    },
    async run(args, ctx) {
      // 空にする（選んだ所を消す）ことも指示になるので、長さは見ない。
      // **文字かどうかだけ見る。**空を落とすと「消して」が効かない。
      const text = args.text;
      if (typeof text !== 'string') return fail('text が必要です（入れ替える文を文字で渡してください）。');
      if (!where || !onPatch) return fail('書き換える先がありません（画面のない入口で動いています）。');
      const at = where();
      if (!at) {
        return fail('画面で選んでいる所がありません。'
          + 'ファイルそのものを直すなら、read_file で読んでから edit_file を使ってください。');
      }
      // 画面から来た道なので、そのまま信じない（作業場の中だけ）。
      const abs = await realSafeResolve(ctx.root, at.path);
      if (!abs) return fail(`作業ディレクトリの外です: ${at.path}`);
      onPatch({ ...at, replacement: text });
      // 画面へは送るだけで、当たったかの返事は無い（選んだ所が動いた・開いていない・画面が無いと当たらない）。書き換えたと言い切らない
      return ok(`画面で選んでいる ${at.path} の ${at.from}〜${at.to} 行目へ、入れ替える文を送りました。`
        + '選んだ所が動いていたり、画面で開いていなかったりすると当たりません。当たったかは、ここからは見えません。'
        + '**保存はしていません。**利用者が見て、良ければ保存します。');
    },
  };
}
