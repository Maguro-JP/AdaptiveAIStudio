/**
 * 会話が空のときの案内。
 *
 * **開いた直後は、空の箱と「指示を書く」だけだった。**初めて触る人は、
 * ここで何を打てるのかが分からない。押せば入る例を出す。
 * 例は**入れるだけで送らない**（押した瞬間に走り出すと、確かめる間が無い）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, createNode, type StubNode } from './dom-stub.ts';

installDom();
(globalThis as { window?: unknown }).window = {};
const { PANELS } = await import('../src/ui/web/panels.js') as {
  PANELS: Record<string, (body: StubNode, ctx: unknown) => void>;
};

function draw() {
  const posts: string[] = [];
  (globalThis as { fetch?: unknown }).fetch = (async (url: string, init?: RequestInit) => {
    posts.push(`${init?.method ?? 'GET'} ${String(url)}`);
    return Response.json({ accepted: true }, { status: 202 });
  }) as unknown as typeof fetch;
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
  const all = (want: (n: StubNode) => boolean): StubNode[] => {
    const out: StubNode[] = [];
    const walk = (n: StubNode) => { if (want(n)) out.push(n); for (const c of n.children) walk(c); };
    walk(body);
    return out;
  };
  return {
    body, posts, ctx, find, all,
    guide: () => find((n) => n.className === 'chat-guide'),
    input: () => find((n) => n.tagName === 'textarea')!,
    chips: () => all((n) => n.className.includes('chip-btn')),
  };
}

describe('会話が空のときの案内', () => {
  test('**何も無いときは、押せる例が出る**', () => {
    const t = draw();
    const guide = t.guide();
    assert.ok(guide, '案内が出ていない');
    assert.match(guide.text, /そのまま書いてください/, guide.text);
    assert.ok(t.chips().length >= 3, `例が足りない: ${t.chips().length}`);
  });

  test('**押すと書きかけに入る。送らない**', () => {
    const t = draw();
    const chip = t.chips()[0]!;
    chip.onclick!();
    assert.equal(t.input().value, chip.textContent, '押したものが入っていない');
    assert.deepEqual(t.posts.filter((p) => p.includes('/api/send')), [], '押しただけで送っている');
  });

  test('**話が始まったら、案内は引っ込む**', () => {
    const t = draw();
    assert.ok(t.guide(), '案内が出ていない');
    (t.ctx.showHistory as (m: unknown[]) => void)([{ role: 'user', content: 'やあ' }]);
    assert.equal(t.guide(), undefined, '話が始まったのに案内が残っている');
  });

  test('続きの無い会話へ切り替えたら、また出る（対）', async () => {
    const t = draw();
    (t.ctx.showHistory as (m: unknown[]) => void)([{ role: 'user', content: 'やあ' }]);
    assert.equal(t.guide(), undefined);
    (t.ctx.showHistory as (m: unknown[]) => void)([]);
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(t.guide(), '空の会話なのに案内が出ない');
  });
});
