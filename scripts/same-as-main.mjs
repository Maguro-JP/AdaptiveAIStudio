/**
 * 押すツリーが、既に外に在る main と同じなら、push の手前の確かめを飛ばす。
 *
 * マージした後に作業のブランチを main へ合わせ直す push は、外に新しいものを何も出さない。
 * それでもフックは 12 分の確かめ（型チェック・テスト・画面・本物の読み込み道）を回していた
 * （2026-09-24 に 3 回）。**確かめるのは、外に出るものがあるから。**出るものが無ければ要らない。
 *
 * main が手元で確かめ済みかには頼らない。「main と同じツリー」は「外に既に在るツリー」なので、
 * この push で新しく外に出るものは無い、という理由だけで飛ばす。
 *
 * 飛ばさないもの:
 *   ・ブランチ以外（タグなど）が混ざる push。タグは release の合図になる
 *   ・ツリーが一つでも main と違う push
 *   ・手元に `<remote>/main` が無い（比べる相手が無い）
 */
import { execFileSync } from 'node:child_process';
import { isMain } from './is-main.mjs';

/**
 * 飛ばす理由を返す。飛ばさないなら undefined。
 *
 * @param {{ trees: readonly string[], mainTree: string | undefined, other: boolean, remote: string }} push
 *   trees     押すブランチそれぞれのツリー（消す push は含めない）
 *   mainTree  手元にある `<remote>/main` のツリー
 *   other     ブランチ以外の ref（タグなど）が混ざっているか
 */
export function sameAsMain({ trees, mainTree, other, remote }) {
  if (other || !mainTree || trees.length === 0) return undefined;
  if (!trees.every((t) => t === mainTree)) return undefined;
  return `== 押すツリーは ${remote}/main と同じです（${mainTree.slice(0, 7)}）。外に新しく出るものが無いので、確かめを飛ばします`;
}

/** git にツリーを訊く。訊けなければ undefined。 */
function treeOf(rev) {
  try {
    return execFileSync('git', ['rev-parse', '--verify', '-q', `${rev}^{tree}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/*
 * フックから: `node scripts/same-as-main.mjs <remote> <other:0|1> <sha>...`
 * 飛ばすなら理由を出して 10、飛ばさないなら 3 で終わる（1 は「止める」に見えるので使わない）。
 * 飛ばす合図を 0 にしない。読み込みで落ちる・直に起こされたと見分けられない、のどちらでも 0 や 1 で終わり、
 * 0 を「飛ばす」と読むと、型チェックもテストも回さずに push が通る。決めた値のときだけ飛ばし、それ以外は確かめる側に倒す。
 */
export const SKIP_EXIT = 10;

if (isMain(import.meta.url)) {
  const [remote = 'origin', other = '0', ...shas] = process.argv.slice(2);
  const trees = shas.map(treeOf);
  const why = trees.every(Boolean)
    ? sameAsMain({ trees, mainTree: treeOf(`refs/remotes/${remote}/main`), other: other === '1', remote })
    : undefined;
  if (why) {
    process.stdout.write(`${why}\n`);
    process.exit(SKIP_EXIT);
  }
  process.exit(3);
}
