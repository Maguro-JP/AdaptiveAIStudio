/**
 * 配ったものには **npm が入っていない**（同梱しているのは node だけ）。
 *
 * それでも打ち方を `npm test` と組み立てていたので、配った先では
 * **作業前の控えも、書いたあとの検証も、一度も回らない。**
 * 「書いて終わりにしない」が AdaptiveAIStudio の中心なのに、そこが黙って抜けていた。
 * 落ちたのが「直っていないから」なのか「打てなかったから」なのかも
 * 区別できない。
 *
 * 走らせる場所で結果が変わらないよう、**呼べるかどうかは渡してもらう。**
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { scriptCommand } from '../src/agent/prefetch.ts';

const scripts = {
  test: 'node scripts/run-tests.mjs',
  check: 'node scripts/check.mjs',
  build: 'tsc -p .',
};

describe('打ち方を決める', () => {
  test('npm があるなら、これまでどおり', () => {
    const can = () => true;
    assert.equal(scriptCommand('npm', 'test', scripts, can), 'npm test');
    assert.equal(scriptCommand('npm', 'check', scripts, can), 'npm run check');
    assert.equal(scriptCommand('pnpm', 'test', scripts, can), 'pnpm test');
  });

  test('npm が無ければ、書いてある中身をそのまま打つ', () => {
    // node は入口が PATH に足している。npm と npx は入っていない。
    const can = (c: string) => c === 'node';
    assert.equal(scriptCommand('npm', 'test', scripts, can), 'node scripts/run-tests.mjs');
    assert.equal(scriptCommand('npm', 'check', scripts, can), 'node scripts/check.mjs');
  });

  test('node で始まらないものは、打ち方を返さない', () => {
    // 打てない命令を返すと、落ちた理由が二つに割れて読めなくなる。
    const can = (c: string) => c === 'node';
    assert.equal(scriptCommand('npm', 'build', scripts, can), undefined);
  });

  test('その名前の script が無ければ、返さない', () => {
    assert.equal(scriptCommand('npm', 'lint', scripts, (c) => c === 'node'), undefined);
  });
});
