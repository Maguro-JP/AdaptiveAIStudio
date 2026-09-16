/**
 * 画面に出せる種類と、配置が受け取る種類を、食い違わせない。
 *
 * **片方だけに足して、画面で空の札を出した。**「探す」のパネルを
 * `panels.js` の `TITLES` と `PANELS` にだけ足したところ、表示の一覧には
 * 出るのに、押して出すと**中身の無い覚え書き**が出た。配置を受け取る側
 * （`src/ui/layout.ts` の `PANEL_KINDS`）が知らない種類を覚え書きへ
 * 落とすためで、画面には種類の名前（`search`）がそのまま出ていた。
 *
 * 画面を開いて押すまで分からなかった（`PANELS.search` を直に呼ぶ試験は通っていた）。
 * **二箇所に分かれているものは、一致することを試験で留める。**
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from './dom-stub.ts';
import { PANEL_KINDS } from '../src/ui/layout.ts';

installDom();
const { PANELS, TITLES } = await import('../src/ui/web/panels.js') as {
  PANELS: Record<string, unknown>;
  TITLES: Record<string, string>;
};

describe('出せる種類と、置ける種類', () => {
  test('**画面の名前と、配置が受け取る種類が一致する**', () => {
    assert.deepEqual([...Object.keys(TITLES)].sort(), [...PANEL_KINDS].sort());
  });

  test('**名前が在る種類には、中身を作るものが在る**', () => {
    const missing = Object.keys(TITLES).filter((k) => typeof PANELS[k] !== 'function');
    assert.deepEqual(missing, [], `名前だけ在って、中身が無い: ${missing.join(', ')}`);
  });

  test('中身を作るものには、名前が在る', () => {
    const nameless = Object.keys(PANELS).filter((k) => !TITLES[k]);
    assert.deepEqual(nameless, [], `中身は在るのに、名前が無い: ${nameless.join(', ')}`);
  });
});
