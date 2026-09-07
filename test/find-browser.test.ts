/**
 * 押して回るための、ブラウザを探す。
 *
 * ここは `/opt/pw-browsers/…` を決め打っていた。**この機械にしか無い道。**
 * Windows で `npm run check` を回すと、押して回る部分だけが静かに飛ぶ。
 * つまり**配る先で回したときに限って、いちばん壊れやすい所を見ない**。
 *
 * OS の分岐は、この機械で試せる形にする（`test/os-branch.test.ts` と同じ考え）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error 型を持たない script を、そのまま呼んで確かめる。
import { browserCandidates, findBrowser } from '../scripts/find-browser.mjs';

const none = () => false;
const all = () => true;

describe('走らせる場所ごとに、ブラウザを探す', () => {
  test('**Windows では Edge を先に見る**', () => {
    // Edge は Windows に必ず入っている。Chrome を先にすると、
    // Chrome を入れていない機械で飛ぶ。
    const list = browserCandidates('win32', { ProgramFiles: 'C:\\PF', 'ProgramFiles(x86)': 'C:\\PF86' }) as string[];
    assert.ok(list.length > 0);
    assert.match(list[0]!, /msedge\.exe$/, `Edge を先に見ていない: ${list[0]}`);
    assert.ok(list.some((p) => p.includes('chrome.exe')), 'Chrome も見ていない');
    assert.ok(list.every((p) => p.includes('\\')), `Windows の道になっていない: ${list.join(' ')}`);
  });

  test('mac と linux では、その場所を見る（対）', () => {
    const mac = browserCandidates('darwin', {}) as string[];
    assert.ok(mac.every((p) => p.startsWith('/Applications/')), mac.join(' '));
    const linux = browserCandidates('linux', {}) as string[];
    assert.ok(linux.some((p) => p.includes('/usr/bin/')), linux.join(' '));
  });

  test('**この機械の道を、どこでも使わない**', () => {
    // 決め打っていた道が Windows の候補に混ざっていたら、また静かに飛ぶ。
    const win = browserCandidates('win32', {}) as string[];
    assert.ok(!win.some((p) => p.includes('/opt/pw-browsers')),
      `この機械の道が混ざっている: ${win.join(' ')}`);
  });

  test('在るものを選ぶ', () => {
    const got = findBrowser({ platform: 'win32', env: { ProgramFiles: 'C:\\PF' }, exists: all });
    assert.equal(got.ok, true);
    assert.match(got.browser, /msedge\.exe$/);
  });

  test('**名指しされたら、それだけを見る**', () => {
    // 指定したのに黙って別のものを使われる方が困る。
    const got = findBrowser({
      platform: 'win32', env: { AAS_SWEEP_BROWSER: 'D:\\my\\chrome.exe' }, exists: all,
    });
    assert.equal(got.browser, 'D:\\my\\chrome.exe');
  });

  test('名指しされたものが無ければ、そう言う（対）', () => {
    const got = findBrowser({
      platform: 'win32', env: { AAS_SWEEP_BROWSER: 'D:\\ない.exe' }, exists: none,
    });
    assert.equal(got.ok, false);
    assert.match(got.why, /AAS_SWEEP_BROWSER/);
    assert.match(got.why, /D:\\ない\.exe/, '何が無かったのかを言っていない');
  });

  test('**見つからないときは、どこを見たかまで言う**', () => {
    // 「ありません」だけだと、次に何をすればいいか分からない。
    const got = findBrowser({ platform: 'win32', env: {}, exists: none });
    assert.equal(got.ok, false);
    assert.match(got.why, /msedge\.exe/, '見た先を言っていない');
    assert.match(got.why, /AAS_SWEEP_BROWSER/, '次の一手を言っていない');
  });
});
