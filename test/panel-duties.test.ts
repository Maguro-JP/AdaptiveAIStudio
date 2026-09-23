/**
 * 定期実行のパネル。
 *
 * **記録だけを出していたので、まだ一度も回っていないと空だった。**
 * 何が仕込まれているのかも、いつ起きるのかも分からない。しかも読んでいた欄は
 * 記録に無い名前で、記録が在っても必ず「未実施」になっていた。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, createNode, type StubNode } from './dom-stub.ts';

installDom();
const { PANELS } = await import('../src/ui/web/panels.js') as {
  PANELS: Record<string, (body: StubNode, ctx: unknown) => void>;
};

function draw(duties: unknown[]) {
  const body = createNode('div');
  PANELS.duties!(body, { onState: (fn: (s: unknown) => void) => fn({ duties }) });
  return body;
}

describe('定期実行のパネル', () => {
  test('**何が仕込まれていて、いつ起きるかが出る**', () => {
    const body = draw([
      { id: 'morning-brief', codename: 'MORNING BRIEF', name: '朝の外部情報', purpose: '外の動きを見る', when: '毎日 7 時', due: true, catchUp: false, completions: 0, missed: 0 },
    ]);
    assert.match(body.text, /MORNING BRIEF/);
    assert.match(body.text, /朝の外部情報/);
    assert.match(body.text, /毎日 7 時/, `いつ起きるかが出ていない: ${body.text}`);
    assert.match(body.text, /未了/, `発生していることが出ていない: ${body.text}`);
  });

  test('**済んだものは、済んだ時刻が出る**', () => {
    const at = Date.parse('2026-09-19T03:00:00+09:00');
    const body = draw([
      { id: 'carry-over', codename: 'CARRY-OVER', name: '前回分の確認', purpose: '', when: '毎日 0 時', lastAt: at, due: false, catchUp: false, completions: 2, missed: 0 },
    ]);
    assert.doesNotMatch(body.text, /未実施/, `済んでいるのに未実施と出ている: ${body.text}`);
    assert.match(body.text, /2026/, `済んだ時刻が出ていない: ${body.text}`);
  });

  test('一度も回っていないものは、未実施と出る（対）', () => {
    const body = draw([
      { id: 'x', codename: 'X', name: 'まだの日課', purpose: '', when: '4 時間ごと', due: true, catchUp: false, completions: 0, missed: 0 },
    ]);
    assert.match(body.text, /未実施/);
  });

  test('逃した分の埋め合わせは、そう分かる', () => {
    const body = draw([
      { id: 'c', codename: 'C', name: '前回分', purpose: '', when: '毎日 0 時', due: true, catchUp: true, completions: 1, missed: 1 },
    ]);
    assert.match(body.text, /前の分/, body.text);
  });
});
