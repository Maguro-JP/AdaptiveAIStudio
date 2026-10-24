/**
 * 画面をアプリのウィンドウで開く。どの OS の分岐も、ここで通す。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join, delimiter } from 'node:path';
import { appBrowserCandidates, findAppBrowser, appWindowCommand } from '../src/core/app-window.ts';

describe('アプリのウィンドウを開く部品を探す', () => {
  test('Windows: Edge を Chrome より先に、Program Files から探す', () => {
    const env = { 'ProgramFiles(x86)': 'C:\\PF86', ProgramFiles: 'C:\\PF', LOCALAPPDATA: 'C:\\LA' };
    const list = appBrowserCandidates('win32', env);
    assert.equal(list[0], join('C:\\PF86', 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    assert.ok(list.findIndex((p) => p.includes('chrome.exe')) > list.findIndex((p) => p.includes('msedge.exe')));
  });

  test('見つかった最初のものを使い、無ければ undefined（ブラウザで開く道へ戻る）', () => {
    const env = { ProgramFiles: 'C:\\PF' };
    const chrome = join('C:\\PF', 'Google', 'Chrome', 'Application', 'chrome.exe');
    assert.equal(findAppBrowser('win32', env, (p) => p === chrome), chrome);
    assert.equal(findAppBrowser('win32', env, () => false), undefined);
  });

  test('Linux: PATH の中から探す', () => {
    const env = { PATH: ['/usr/bin', '/opt/x'].join(delimiter) };
    assert.equal(findAppBrowser('linux', env, (p) => p === join('/opt/x', 'chromium')), join('/opt/x', 'chromium'));
  });

  test('macOS: アプリの中の実行ファイルを指す', () => {
    assert.match(appBrowserCandidates('darwin', {})[0]!, /Microsoft Edge\.app\/Contents\/MacOS\//);
  });
});

describe('開き方', () => {
  test('--app で開き、普段のブラウザとは別の利用者フォルダを使う', () => {
    const c = appWindowCommand('/x/chrome', 'http://127.0.0.1:4174/', '/home/a/window');
    assert.equal(c.command, '/x/chrome');
    assert.ok(c.args.includes('--app=http://127.0.0.1:4174/'));
    assert.ok(c.args.includes('--user-data-dir=/home/a/window'));
  });
});
