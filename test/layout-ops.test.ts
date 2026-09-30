/**
 * 配置をいじる操作。
 *
 * 掴んで動かす側は画面が要るが、**木の組み替えは計算**なので、ここで見る。
 * いちばん見たいのは「壊れた形にならないこと」。板が消える・二重に出る・
 * 真っ白になる、はどれも利用者側から直せない。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { panelsInUse, closePanel, openPanel, movePanel } from '../src/ui/web/layout-ops.js';
import type { Layout } from '../src/ui/layout.ts';

const base = (): Layout => ({
  id: 'x', name: 'x',
  root: {
    type: 'split', direction: 'row', sizes: [0.6, 0.4],
    children: [
      { type: 'panel', panel: 'chat' },
      { type: 'tabs', panels: ['log', 'changes'], active: 0 },
    ],
  },
  panels: [
    { id: 'chat', kind: 'conversation' },
    { id: 'log', kind: 'log' },
    { id: 'changes', kind: 'changes' },
  ],
});

/** 木と控えが食い違っていないこと。どちらかだけ直すと、必ずずれる。 */
function sane(l: Layout): void {
  const used = panelsInUse(l.root);
  assert.deepEqual([...used].sort(), [...new Set(used)].sort(), `同じ板が二度出ている: ${used.join(',')}`);
  for (const id of used) {
    assert.ok(l.panels.some((p) => p.id === id), `木に在るのに控えが無い: ${id}`);
  }
  for (const p of l.panels) {
    assert.ok(used.includes(p.id), `控えに在るのに、どこにも出ていない: ${p.id}`);
  }
  assert.ok(used.length > 0, '何も出ていない');
}

describe('閉じる', () => {
  test('束ねてある一枚を閉じると、残りはそのまま', () => {
    const got = closePanel(base(), 'log');
    sane(got);
    assert.deepEqual(panelsInUse(got.root).sort(), ['changes', 'chat']);
  });

  test('束が一枚になったら、束をほどく', () => {
    const got = closePanel(closePanel(base(), 'log'), 'changes');
    sane(got);
    assert.deepEqual(got.root, { type: 'panel', panel: 'chat' });
  });

  test('**全部閉じても、真っ白にしない**', () => {
    let l = base();
    for (const id of ['log', 'changes', 'chat']) l = closePanel(l, id);
    sane(l);
    assert.equal(l.panels.some((p) => p.kind === 'conversation'), true);
  });

  test('無い板を閉じても、壊れない', () => {
    const got = closePanel(base(), 'いない');
    sane(got);
    assert.deepEqual(panelsInUse(got.root).sort(), ['changes', 'chat', 'log']);
  });
});

describe('出す', () => {
  test('束ねてあるところへ足す（これ以上細かく割らない）', () => {
    const got = openPanel(base(), 'memory');
    sane(got);
    assert.ok(panelsInUse(got.root).includes('memory'));
    assert.equal(got.root.type, 'split', '割り方が変わっている');
  });

  test('束が無ければ、右に割って出す（出したものが見えないのは困る）', () => {
    const one: Layout = {
      id: 'x', name: 'x',
      root: { type: 'panel', panel: 'chat' },
      panels: [{ id: 'chat', kind: 'conversation' }],
    };
    const got = openPanel(one, 'log');
    sane(got);
    assert.equal(got.root.type, 'split');
    assert.deepEqual(panelsInUse(got.root), ['chat', 'log']);
  });

  test('同じ種類を二つ出しても、名前がぶつからない', () => {
    const got = openPanel(openPanel(base(), 'note'), 'note');
    sane(got);
    assert.equal(got.panels.filter((p) => p.kind === 'note').length, 2);
  });
});

describe('動かす', () => {
  test('左に置くと、その左へ入る', () => {
    const got = movePanel(base(), 'log', 'chat', 'left');
    sane(got);
    const top = got.root as { type: string; children: { panel?: string }[] };
    assert.equal(top.type, 'split');
    const inner = top.children[0] as { type: string; children: { panel?: string }[] };
    assert.equal(inner.children[0]?.panel, 'log');
    assert.equal(inner.children[1]?.panel, 'chat');
  });

  test('下に置くと、縦に割れる', () => {
    const got = movePanel(base(), 'log', 'chat', 'bottom');
    sane(got);
    const inner = (got.root as { children: { direction?: string }[] }).children[0];
    assert.equal(inner?.direction, 'column');
  });

  test('重ねると、束になる', () => {
    const got = movePanel(base(), 'chat', 'log', 'tab');
    sane(got);
    assert.deepEqual(got.root, { type: 'tabs', panels: ['log', 'changes', 'chat'], active: 2 });
  });

  test('自分の上に落としても、何も起きない（消えたように見せない）', () => {
    const before = base();
    assert.deepEqual(movePanel(before, 'chat', 'chat', 'left'), before);
  });

  test('同じ束の中で重ねても、何も起きない', () => {
    const before = base();
    assert.deepEqual(movePanel(before, 'log', 'changes', 'tab'), before);
  });

  test('相手がいなければ、何も起きない', () => {
    const before = base();
    assert.deepEqual(movePanel(before, 'chat', 'いない', 'left'), before);
  });

  test('動かしても、板は増えも減りもしない', () => {
    for (const where of ['left', 'right', 'top', 'bottom', 'tab'] as const) {
      const got = movePanel(base(), 'changes', 'chat', where);
      sane(got);
      assert.deepEqual(panelsInUse(got.root).sort(), ['changes', 'chat', 'log'], `${where} で数が変わった`);
    }
  });
});

describe('見ているタブより左を閉じても、見ているタブのまま', () => {
  test('4 つ並んだ 3 つ目を見ていて 1 つ目を閉じたら、見ているのは同じもの', () => {
    const l = {
      root: { type: 'tabs', panels: ['a', 'b', 'c', 'd'], active: 2 },
      panels: [],
    } as unknown as Layout;
    const got = closePanel(l, 'a').root as { panels: string[]; active: number };
    assert.equal(got.panels[got.active], 'c', JSON.stringify(got));
  });

  test('右を閉じたら動かない・見ているものを閉じたら同じ位置（なければ一つ左）', () => {
    const l = { root: { type: 'tabs', panels: ['a', 'b', 'c', 'd'], active: 1 }, panels: [] } as unknown as Layout;
    const right = closePanel(l, 'd').root as { panels: string[]; active: number };
    assert.equal(right.panels[right.active], 'b');
    const self = closePanel(l, 'b').root as { panels: string[]; active: number };
    assert.equal(self.panels[self.active], 'c');
  });
});
