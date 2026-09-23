/**
 * 長い会話を開いたときに、画面が固まらないこと。
 *
 * **1500 往復（3000 件）の会話を開いたら、5.8 秒返らなかった**（本物のブラウザで
 * 実測。その間フレームが一度も進まない＝固まって見える）。何時間も動かし続ける作りなので、
 * 会話は普通に伸びる。出すのは後ろから決まった数だけにして、古い分は押したときに足す。
 *
 * **速さそのものは試験にしない**（走らせる機械で変わる）。代わりに
 * 「並べた数」と「いちばん新しいものが出ていること」を見る。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, createNode, type StubNode } from './dom-stub.ts';

installDom();
(globalThis as { window?: unknown }).window = {};
const { PANELS } = await import('../src/ui/web/panels.js') as {
  PANELS: Record<string, (body: StubNode, ctx: unknown) => void>;
};

/** 往復 n 回ぶんのやりとり（利用者と答えで 2 件ずつ）。 */
function talk(n: number) {
  const out: Array<{ role: string; content: string }> = [];
  for (let i = 0; i < n; i += 1) {
    out.push({ role: 'user', content: `依頼#${i}` });
    out.push({ role: 'assistant', content: `答え#${i}` });
  }
  return out;
}

function draw() {
  (globalThis as { fetch?: unknown }).fetch = (async () => Response.json({})) as unknown as typeof fetch;
  const ctx: Record<string, unknown> = { on: () => {}, onState: () => {}, focusInput: () => {} };
  const body = createNode('div');
  PANELS.conversation!(body, ctx);
  const find = (want: (n: StubNode) => boolean): StubNode | undefined => {
    const walk = (n: StubNode): StubNode | undefined => {
      if (want(n)) return n;
      for (const c of n.children) { const got = walk(c); if (got) return got; }
      return undefined;
    };
    return walk(body);
  };
  const log = () => find((n) => n.className.includes('log'))!;
  const more = () => find((n) => n.className.includes('log-more'));
  return { ctx, log, more, show: ctx.showHistory as (m: unknown[]) => void };
}

describe('長い会話を開く', () => {
  test('**出すのは後ろの分だけ。いちばん新しいものが出ている**', () => {
    const t = draw();
    t.show(talk(1500));
    const n = t.log().children.length;
    assert.ok(n > 1 && n <= 260, `全部並べている（${n} 件）`);
    assert.match(t.log().text, /答え#1499/, 'いちばん新しいものが出ていない');
    assert.ok(!t.log().text.includes('依頼#0'), 'いちばん古いものまで並べている');
  });

  test('**「前を出す」で、古い分が頭に足される**', () => {
    const t = draw();
    t.show(talk(1500));
    const before = t.log().children.length;
    const more = t.more();
    assert.ok(more, '押し場所が出ていない');
    assert.match(more.textContent, /前の 2800 件/, more.textContent);
    more.onclick!();
    const after = t.log().children.length;
    assert.ok(after > before, `足されていない（${before} → ${after}）`);
    assert.ok(after - before <= 210, `一度に足しすぎ（${after - before} 件）`);
    assert.match(t.log().text, /依頼#1300/, '足した分が出ていない');
    // 押し場所は残り、数が減る。
    assert.match(t.more()!.textContent, /前の 2600 件/, t.more()!.textContent);
  });

  test('短い会話では、押し場所を出さない（対）', () => {
    const t = draw();
    t.show(talk(3));
    assert.equal(t.more(), undefined, '短いのに「前を出す」が出ている');
    assert.match(t.log().text, /依頼#0/, '古い方が出ていない');
  });
});
