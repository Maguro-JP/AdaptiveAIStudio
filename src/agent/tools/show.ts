/**
 * 「ここを見てください」を、画面で開く。
 *
 * **AI から画面へ向かう道が無かった。**画面から AI へは渡るようになった
 * （いま開いているファイル・選んだ所）。逆は、答えの中に `a.ts:120` と書く
 * ことしかできず、**人が横の一覧から探し直していた。**
 *
 * ここは読むだけのツールの仲間。開くのは作業場の中のファイルだけで、中身は
 * 何も返さない（読みたいなら `read_file` を呼ぶ）。画面が無い入口（端末）では
 * 受け手が居ないので、何もしないで「開く先がありません」と返す。
 */
import { stat } from 'node:fs/promises';
import { realSafeResolve } from './paths.ts';
import { type Tool, ok, fail, requireString, optionalPositiveInt } from './types.ts';

/** 画面へ「ここを開いて」と伝える受け手。画面の無い入口では置かない。 */
export type ShowHook = (at: { path: string; line?: number }) => void;

export function createShowFileTool(onShow?: ShowHook): Tool {
  return {
    schema: {
      name: 'show_file',
      description: '利用者の画面で、そのファイルを開く（行を指定するとその行へ）。中身は返らない。'
        + '直した所や見てほしい所を示すときに使う。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '作業ディレクトリからの相対パス' },
          line: { type: 'number', description: '開いたときに見せたい行（1 から数える）' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
    async run(args, ctx) {
      const path = requireString(args, 'path');
      if (!path) return fail('path が必要です。');
      // リンクを辿った先まで見る。作業場の中のリンク一つで外を開かせられる。
      const abs = await realSafeResolve(ctx.root, path);
      if (!abs) return fail(`作業ディレクトリの外です: ${path}`);
      if (!onShow) return fail('開く先がありません（画面のない入口で動いています）。');
      // 無いファイル・フォルダを「開きました」と言わない（道を作るための解き方なので、打ち間違えた名前でも道が返る）
      const info = await stat(abs).catch((e: unknown) => e as NodeJS.ErrnoException);
      if (info instanceof Error) return fail(`開けません: ${path}（${info.code ?? info.message}）`);
      if (!info.isFile()) return fail(`ファイルではありません: ${path}`);
      const line = optionalPositiveInt(args, 'line');
      onShow({ path, ...(line === undefined ? {} : { line }) });
      return ok(line === undefined ? `画面で ${path} を開きました。` : `画面で ${path} の ${line} 行目を開きました。`);
    },
  };
}
