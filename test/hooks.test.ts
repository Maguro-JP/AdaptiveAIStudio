/**
 * push の手前のフックが、この clone に入っていること（`scripts/hooks.mjs`）。
 *
 * `.githooks/README.md` に「一度だけ打つ」と書いてあったが、fresh clone で誰も打たず、
 * フックが無いまま push が通った。判断（`hooksPlan`）と、**この作業場に本当に入っているか**の
 * 両方を見る。入っていなければ、ここが落ちて言う（`npm install` の `prepare` と
 * `npm run check` の始めが入れる）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
// @ts-expect-error 型定義を置かない開発用の script。ここだけ読む。
import { hooksPlan, HOOKS_PATH } from '../scripts/hooks.mjs';

const root = join(import.meta.dirname, '..');
// bundle の中（一つ上に .portable が在る）と、git の clone でない所では、入れるものが無い。
const inBundle = existsSync(join(root, '..', '.portable')) || !existsSync(join(root, '.git'));

describe('push の手前のフック', () => {
  test('clone でなければ入れない。元が無ければ入れない。無ければ入れる。在れば触らない', () => {
    const at = (files: string[], current?: string) =>
      (hooksPlan({ exists: (p: string) => files.includes(p), current }) as { action: string }).action;
    assert.equal(at(['.githooks/pre-push']), 'skip', 'clone でないのに入れようとしている');
    assert.equal(at(['.git']), 'skip', 'フックの元が無いのに入れようとしている');
    assert.equal(at(['.git', '.githooks/pre-push']), 'set');
    assert.equal(at(['.git', '.githooks/pre-push'], HOOKS_PATH), 'kept');
    assert.equal(at(['.git', '.githooks/pre-push'], 'elsewhere'), 'set', '別の所を指しているのに、入っていることにしている');
  });

  test('この作業場に入っている', { skip: inBundle ? 'bundle か、git の clone ではない' : false }, () => {
    let current: string | undefined;
    try {
      current = execFileSync('git', ['config', '--local', 'core.hooksPath'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      current = undefined;
    }
    assert.equal(current, HOOKS_PATH,
      'push の手前のフックが入っていません。`npm install`（prepare）か `npm run hooks` で入ります');
  });
});
