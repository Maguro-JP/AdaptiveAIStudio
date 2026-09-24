/**
 * push の手前のフック（`.githooks/pre-push`）を、この clone に入れる。
 *
 * `.githooks/README.md` に「新しく clone したときは一度だけ `git config core.hooksPath .githooks`」
 * と書いてあったが、誰も打たなかった。クラウドの session は毎回 fresh clone で、
 * フックが無いまま push が通った（確かめずに出た）。**文章では守れなかったので、
 * `npm install` が入れる**（package.json の `prepare`）。`npm run check` の始めでも入れる。
 * 入っていなければ `test/hooks.test.ts` が落ちて言う。
 *
 * 判断（`hooksPlan`）と、実際に git を呼ぶ側（`installHooks`）を分ける。判断はテストにかける。
 * **どの結果でも 0 で終わる。**ここで止めると `npm ci` そのものが落ちる
 * （installer の作業場や bundle の中は git の clone ではない）。
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

export const HOOKS_PATH = '.githooks';

/**
 * @param {{ exists: (relPath: string) => boolean, current: string | undefined }} look
 *   `exists` は作業場からの道（`/` 区切り）を受ける。`current` はいまの `core.hooksPath`（無ければ undefined）。
 * @returns {{ action: 'skip' | 'kept' | 'set', text: string }}
 */
export function hooksPlan(look) {
  if (!look.exists('.git')) return { action: 'skip', text: 'git の clone ではないので、push の手前のフックは入れません' };
  if (!look.exists(`${HOOKS_PATH}/pre-push`)) return { action: 'skip', text: `${HOOKS_PATH}/pre-push が無いので、push の手前のフックは入れません` };
  if (look.current === HOOKS_PATH) return { action: 'kept', text: `push の手前のフックは入っています（core.hooksPath = ${HOOKS_PATH}）` };
  return { action: 'set', text: `push の手前のフックを入れました（core.hooksPath = ${HOOKS_PATH}）` };
}

/** 作業場に入れる。返すのは、何をしたか。 */
export function installHooks(root) {
  const git = (args) => {
    try {
      return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return undefined;
    }
  };
  const plan = hooksPlan({
    exists: (relPath) => existsSync(join(root, relPath)),
    current: git(['config', '--local', 'core.hooksPath']),
  });
  if (plan.action === 'set' && git(['config', '--local', 'core.hooksPath', HOOKS_PATH]) === undefined) {
    return { action: 'skip', text: 'git config が失敗したので、push の手前のフックは入っていません' };
  }
  return plan;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  console.log(installHooks(root).text);
}
