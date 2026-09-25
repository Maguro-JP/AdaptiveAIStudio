/**
 * 文書だけの push を、そのまま出さない。
 *
 * ci.yml の `paths-ignore` は **効かない**。GitHub は `pull_request` の
 * path 判定を「PR 全体の差分（head と base）」で行うので、PR に一度でも
 * コードが入っていれば、そのあと文書だけを押しても当たらない。
 * この repo は push では回さないため、**開いている PR への文書だけの
 * push は毎回 1 回ぶん枠を食う**（実際に食った。docs/HANDOFF.md の
 * 1 ファイルだけのコミットで run が立った）。
 *
 * 通り道は二つ。次のコードの push にまとめるか、`[skip ci]` を付けて
 * 「今回は回さない」と自分で言うか。どちらも一行で済む。
 */

/** ci.yml の paths-ignore と同じ並び。片方だけ直すと食い違う。 */
const DOCS = [
  (f) => f.endsWith('.md'),
  (f) => f.startsWith('docs/'),
  (f) => f === '.gitignore',
  (f) => f === '.gitattributes',
  (f) => f.startsWith('.claude/'),
];

/** HEAD の題に入っていれば、GitHub はその push と pull_request を起こさない。 */
export const SKIP_MARK = '[skip ci]';

/**
 * 止める理由を返す。止めなくてよければ undefined。
 *
 * @param {{ files: readonly string[], message: string }} push
 *   files   押す範囲で変わったファイル（repository の根からの path）
 *   message HEAD のコミットの題（GitHub が見るのはここだけ）
 * @returns {string | undefined}
 */
export function docsOnlyPush(push) {
  const files = push.files.filter((f) => f.length > 0);
  // 何も変わっていないなら、言うことは無い。
  if (files.length === 0) return undefined;
  if (!files.every((f) => DOCS.some((is) => is(f)))) return undefined;
  if (push.message.includes(SKIP_MARK)) return undefined;
  return `文書だけの push です（${files.length} ファイル）。このまま出すと CI が 1 回ぶん起きます。\n`
    + `  ・次のコードの push にまとめる\n`
    + `  ・題に ${SKIP_MARK} を足す（git commit --amend）\n`
    + `ci.yml の paths-ignore は、PR に一度でもコードが入っていると当たりません。`;
}
