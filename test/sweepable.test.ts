/**
 * sweep を動かせるかの判定。
 *
 * `npm run check:bundle` は、Chromium が無い機械では**最後まで通らなかった**
 * （`playwright-core` の読み込みで死ぬ）。確かめる命令が途中で死ぬと、その先
 * （起こした画面を止めて、止まったことまで見る）を一度も見ないまま終わる。
 *
 * 回せないときは、**理由を言って先へ進む**。飛ばしたことは終わりに出す。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error 型を持たない script を、そのまま呼んで確かめる。
import { sweepable } from '../scripts/sweepable.mjs';

const anyBrowser = { platform: 'win32', env: { ProgramFiles: 'C:\\Program Files' }, exists: () => true };
const haveLib = () => '/somewhere/playwright-core/index.js';

describe('sweep を動かせるかを決める', () => {
  test('playwright-core とブラウザが在れば、回せる', () => {
    assert.deepEqual(sweepable({ resolve: haveLib, ...anyBrowser }), { ok: true });
  });

  test('**playwright-core が無ければ、入れ方まで言う**', () => {
    const got = sweepable({
      resolve: () => { throw new Error('Cannot find module'); },
      ...anyBrowser,
    }) as { ok: boolean; why: string };
    assert.equal(got.ok, false);
    assert.match(got.why, /playwright-core/);
    assert.match(got.why, /npm i --no-save/, '入れ方を言っていない');
  });

  test('**ブラウザが無ければ、探した先を言う**', () => {
    const got = sweepable({
      resolve: haveLib, platform: 'win32', env: { ProgramFiles: 'C:\\Program Files' }, exists: () => false,
    }) as { ok: boolean; why: string };
    assert.equal(got.ok, false);
    assert.ok(got.why.length > 0, '理由が空');
    assert.match(got.why, /msedge|chrome/i, '探した先を言っていない');
  });

  test('名指しされたブラウザが無いときも、そう言う（対）', () => {
    const got = sweepable({
      resolve: haveLib, platform: 'linux', env: { AAS_SWEEP_BROWSER: '/nope/chrome' }, exists: () => false,
    }) as { ok: boolean; why: string };
    assert.equal(got.ok, false);
    assert.match(got.why, /\/nope\/chrome/);
  });
});
