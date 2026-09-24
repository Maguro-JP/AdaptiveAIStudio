/**
 * 外のツール（MCP）で作業場が変わったことを、会話のパネルが言う。
 *
 * 出来事（`outsideChanged`）を足しても、画面の側が受けなければ黙って捨てられる。
 * 三つの形（変わった・比べられない・書く手前で見つけた）を、それぞれ言い分けているかを見る。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, createNode, type StubNode } from './dom-stub.ts';

installDom();
(globalThis as { window?: unknown }).window = {};
const { PANELS } = await import('../src/ui/web/panels.js') as {
  PANELS: Record<string, (body: StubNode, ctx: unknown) => void>;
};

function open() {
  (globalThis as { fetch?: unknown }).fetch = (async () => Response.json({})) as unknown as typeof fetch;
  const handlers = new Map<string, Array<(e: unknown) => void>>();
  const body = createNode('div');
  PANELS.conversation!(body, {
    on: (type: string, fn: (e: unknown) => void) => {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type)!.push(fn);
    },
    onState: () => {},
    focusInput: () => {},
  });
  const emit = (event: unknown) => {
    for (const fn of handlers.get('session') ?? []) fn({ event });
  };
  return { emit, text: () => body.text };
}

describe('外のツールで作業場が変わったことを言う', () => {
  test('変わったファイルを挙げ、一度だけ確かめると言う', () => {
    const t = open();
    t.emit({ type: 'outsideChanged', paths: ['a.txt', 'b.txt'] });
    assert.match(t.text(), /外のツールが作業場を変えました（a\.txt, b\.txt）/);
    assert.match(t.text(), /一度だけ確かめます/);
  });

  test('多いときは、頭の 5 件と残りの件数', () => {
    const t = open();
    t.emit({ type: 'outsideChanged', paths: ['1', '2', '3', '4', '5', '6', '7'] });
    assert.match(t.text(), /1, 2, 3, 4, 5 ほか 2 件/);
  });

  test('比べられなかったら、比べられないと言い、確かめたとは言わない', () => {
    const t = open();
    t.emit({ type: 'outsideChanged', paths: undefined });
    assert.match(t.text(), /比べられませんでした/);
    assert.match(t.text(), /確かめは回していません/);
  });

  test('書く手前で見つけたなら、直させると言う', () => {
    const t = open();
    t.emit({ type: 'outsideChanged', paths: ['FAIL'], beforeBaseline: true });
    assert.match(t.text(), /外のツールが先に作業場を変えました（FAIL）/);
    assert.match(t.text(), /今回の作業のものとして直させます/);
    assert.ok(!/一度だけ確かめます/.test(t.text()), '書く手前の形なのに、一度だけと言っている');
  });
});
