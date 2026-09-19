/**
 * 覚え書きのパネル。
 *
 * **「メモ」と並んでいるのに、一文字も書けなかった。**渡された字を出すだけで、
 * 打つ所が無い。開いた人は、書ける所を探して諦めることになる。
 * 打った分は配置と一緒に残す（読み直しても消えない）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, createNode, type StubNode } from './dom-stub.ts';
import { until } from './until.ts';

installDom();
const { PANELS } = await import('../src/ui/web/panels.js') as {
  PANELS: Record<string, (body: StubNode, ctx: unknown, spec?: unknown) => void>;
};

function open(text?: string, ok = true) {
  const saved: Array<{ id: string; text: string }> = [];
  const body = createNode('div');
  PANELS.note!(body, {
    saveNote: async (id: string, t: string) => { saved.push({ id, text: t }); return ok; },
  }, { id: 'p1', kind: 'note', ...(text === undefined ? {} : { options: { text } }) });
  const find = (want: (n: StubNode) => boolean): StubNode => {
    const walk = (n: StubNode): StubNode | undefined => {
      if (want(n)) return n;
      for (const c of n.children) { const got = walk(c); if (got) return got; }
      return undefined;
    };
    const got = walk(body);
    assert.ok(got, '見つからない');
    return got;
  };
  return {
    saved, body,
    area: () => find((n) => n.tagName === 'textarea'),
    state: () => find((n) => n.className.includes('note-state')),
  };
}

describe('覚え書きのパネル', () => {
  test('**打てる。打った分が残る所へ渡る**', async () => {
    const t = open();
    t.area().value = 'あとで greet にテストを足す';
    t.area().fire('input');
    await until(() => t.saved.length > 0, '残しに行く', { timeoutMs: 5000 });
    assert.deepEqual(t.saved, [{ id: 'p1', text: 'あとで greet にテストを足す' }]);
    await until(() => t.state().textContent === '書き留めました', 'そう言う');
  });

  test('前に書いたものが、最初から入っている', () => {
    const t = open('きのうの続き');
    assert.equal(t.area().value, 'きのうの続き');
  });

  test('残せなかったら、そう言う（黙って消さない）', async () => {
    const t = open(undefined, false);
    t.area().value = 'x';
    t.area().fire('input');
    await until(() => t.state().textContent === '書き留められませんでした', 'そう言う', { timeoutMs: 5000 });
    // 打ったものは欄に残る（消して「保存できません」だけ出さない）。
    assert.equal(t.area().value, 'x');
  });

  test('打つたびには送らない（手が止まってから）', async () => {
    const t = open();
    for (const text of ['あ', 'あい', 'あいう']) {
      t.area().value = text;
      t.area().fire('input');
    }
    await until(() => t.saved.length > 0, '残しに行く', { timeoutMs: 5000 });
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(t.saved.map((s) => s.text), ['あいう'], `毎回送っている: ${JSON.stringify(t.saved)}`);
  });
});
