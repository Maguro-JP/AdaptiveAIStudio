/**
 * 押すツリーが外の main と同じなら、push の手前の確かめを飛ばす（`scripts/same-as-main.mjs`）。
 *
 * 飛ばしてよいのは「外に新しく出るものが無い」ときだけ。飛ばしすぎると、確かめていない
 * ものが外に出る。**飛ばさない側の形を、飛ばす側と同じだけ見る。**
 * フックが本当に飛ばす・飛ばさないは `test/pushed-tree.test.ts` で見る。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error 型定義を置かない開発用の script。ここだけ読む。
import { sameAsMain, SKIP_EXIT } from '../scripts/same-as-main.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './tmp.ts';

const M = 'm'.repeat(40);
const X = 'x'.repeat(40);

describe('main と同じツリーなら飛ばす', () => {
  test('押すブランチのツリーが全部 main と同じなら、理由を言って飛ばす', () => {
    const why = sameAsMain({ trees: [M], mainTree: M, other: false, remote: 'origin' });
    assert.ok(why, '飛ばしていない');
    assert.match(why, /origin\/main と同じ/);
    assert.match(why, /mmmmmmm/, `どのツリーかを言っていない: ${why}`);
  });

  test('一つでも違えば飛ばさない', () => {
    assert.equal(sameAsMain({ trees: [M, X], mainTree: M, other: false, remote: 'origin' }), undefined);
    assert.equal(sameAsMain({ trees: [X], mainTree: M, other: false, remote: 'origin' }), undefined);
  });

  test('タグなど、ブランチ以外が混ざれば飛ばさない（release の合図になる）', () => {
    assert.equal(sameAsMain({ trees: [M], mainTree: M, other: true, remote: 'origin' }), undefined);
  });

  test('比べる相手（手元の main）が無ければ飛ばさない。押すブランチが無くても飛ばさない', () => {
    assert.equal(sameAsMain({ trees: [M], mainTree: undefined, other: false, remote: 'origin' }), undefined);
    assert.equal(sameAsMain({ trees: [], mainTree: M, other: false, remote: 'origin' }), undefined);
  });
});

describe('フックから起こしたとき', () => {
  const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'same-as-main.mjs');
  /** origin/main を自分で置いた仮のリポジトリ。走らせる場所の clone に頼らない */
  async function repo(): Promise<{ cwd: string; head: string }> {
    const cwd = await tempDir('aas-same-as-main-repo-');
    const git = (...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    git('init', '-q');
    writeFileSync(join(cwd, 'a.txt'), 'a\n');
    git('add', '-A');
    git('-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    return { cwd, head: git('rev-parse', 'HEAD') };
  }
  const run = (path: string, cwd: string, rev: string): number | null =>
    spawnSync(process.execPath, [path, 'origin', '0', rev], { cwd, encoding: 'utf8' }).status;

  test('**飛ばす合図は 10。0 は飛ばす合図にしない**（何もせずに 0 で終わったものを「飛ばす」と読まない）', async () => {
    const { cwd, head } = await repo();
    assert.notEqual(SKIP_EXIT, 0);
    assert.equal(run(script, cwd, head), SKIP_EXIT);
    assert.equal(run(script, cwd, '0'.repeat(40)), 3, '読めないものを飛ばした');
  });

  test('**リンクを通した道から起こしても、判定を走らせる**（前は一致せずに何もせず 0 で終わった）', async () => {
    const { cwd, head } = await repo();
    const dir = await tempDir('aas-same-as-main-link-');
    symlinkSync(dirname(script), join(dir, 'scripts'), 'junction');
    assert.equal(run(join(dir, 'scripts', 'same-as-main.mjs'), cwd, head), SKIP_EXIT);
  });
});
