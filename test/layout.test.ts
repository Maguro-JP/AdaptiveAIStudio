import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { repairLayout, preset, panelsInOrder, PRESETS, PANEL_KINDS, DEFAULT_LAYOUT_ID,
  type Layout,
} from '../src/ui/layout.ts';

describe('用意された配置', () => {
  test('どれも、そのまま読める形になっている', () => {
    for (const p of PRESETS) {
      const { layout, repairs } = repairLayout(p);
      assert.deepEqual(repairs, [], `${p.id} を直す必要があった: ${JSON.stringify(repairs)}`);
      assert.equal(layout.id, p.id);
    }
  });

  test('どの配置でも、宣言した中身が全部置かれている', () => {
    for (const p of PRESETS) {
      const placed = new Set(panelsInOrder(p.root));
      for (const panel of p.panels) {
        assert.ok(placed.has(panel.id), `${p.id} の ${panel.id} が置かれていない`);
      }
    }
  });

  test('知らない名前を頼まれたら既定に落ちる', () => {
    assert.equal(preset('そんな配置は無い').id, DEFAULT_LAYOUT_ID);
  });

  test('取り出した配置は独立している（直しても元が汚れない）', () => {
    const a = preset('command');
    a.name = '書き換えた';
    assert.notEqual(preset('command').name, '書き換えた');
  });
});

describe('壊れた配置でも画面を出す', () => {
  const ok = (raw: unknown) => {
    const { layout } = repairLayout(raw);
    assert.ok(layout.panels.length > 0, '中身が空になった');
    assert.ok(panelsInOrder(layout.root).length > 0, '何も置かれていない');
    return layout;
  };

  test('null でも出る', () => { ok(null); });
  test('文字列でも出る', () => { ok('こんにちは'); });
  test('配列でも出る', () => { ok([1, 2, 3]); });
  test('空の入れ物でも出る', () => { ok({}); });
  test('中身だけあって配置が無くても出る', () => {
    const l = ok({ panels: [{ id: 'a', kind: 'conversation' }] });
    assert.deepEqual(panelsInOrder(l.root), ['a']);
  });
  test('配置だけあって中身が無ければ既定に戻る', () => {
    const l = ok({ root: { type: 'panel', panel: 'a' } });
    assert.equal(l.id, DEFAULT_LAYOUT_ID);
  });
  test('入れ子が深く壊れていても出る', () => {
    ok({
      panels: [{ id: 'a', kind: 'conversation' }],
      root: { type: 'split', children: [{ type: 'split', children: [{ type: 'split', children: [] }] }] },
    });
  });
});

describe('配置の直し方', () => {
  const base = (root: unknown, panels: unknown[] = [
    { id: 'a', kind: 'conversation' }, { id: 'b', kind: 'plan' },
  ]) => repairLayout({ id: 'x', name: 'x', panels, root });

  test('存在しない中身を置いていたら外す', () => {
    const { layout, repairs } = base({
      type: 'split', direction: 'row', sizes: [0.5, 0.5],
      children: [{ type: 'panel', panel: 'a' }, { type: 'panel', panel: 'いない' }],
    });
    assert.deepEqual(panelsInOrder(layout.root).filter((p) => p === 'a').length, 1);
    assert.ok(repairs.some((r) => r.detail.includes('いない')));
  });

  test('同じ中身を二箇所に置いたら後を外す', () => {
    const { layout, repairs } = base({
      type: 'split', direction: 'row', sizes: [0.5, 0.5],
      children: [{ type: 'panel', panel: 'a' }, { type: 'panel', panel: 'a' }],
    });
    assert.equal(panelsInOrder(layout.root).filter((p) => p === 'a').length, 1);
    assert.ok(repairs.some((r) => r.detail.includes('二箇所')));
  });

  test('置き場所の無い中身は捨てずに寄せる', () => {
    const { layout, repairs } = base({ type: 'panel', panel: 'a' });
    assert.ok(panelsInOrder(layout.root).includes('b'), 'b が消えた');
    assert.ok(repairs.some((r) => r.detail.includes('置き場所の無い')));
  });

  test('幅の数が合わなければ均等に割り直す', () => {
    const { layout } = base({
      type: 'split', direction: 'row', sizes: [0.9],
      children: [{ type: 'panel', panel: 'a' }, { type: 'panel', panel: 'b' }],
    });
    assert.equal(layout.root.type, 'split');
    const sizes = (layout.root as { sizes: number[] }).sizes;
    assert.deepEqual(sizes, [0.5, 0.5]);
  });

  test('幅は合計1に揃える', () => {
    const { layout } = base({
      type: 'split', direction: 'row', sizes: [3, 1],
      children: [{ type: 'panel', panel: 'a' }, { type: 'panel', panel: 'b' }],
    });
    const sizes = (layout.root as { sizes: number[] }).sizes;
    assert.ok(Math.abs(sizes.reduce((x, y) => x + y, 0) - 1) < 1e-9);
    assert.ok(sizes[0]! > sizes[1]!, '比率が保たれていない');
  });

  test('負や0の幅は無視して割り直す', () => {
    const { layout } = base({
      type: 'split', direction: 'row', sizes: [-1, 0],
      children: [{ type: 'panel', panel: 'a' }, { type: 'panel', panel: 'b' }],
    });
    assert.deepEqual((layout.root as { sizes: number[] }).sizes, [0.5, 0.5]);
  });

  test('一つしか残らない分割は畳む', () => {
    const { layout } = base({
      type: 'split', direction: 'row', sizes: [0.5, 0.5],
      children: [{ type: 'panel', panel: 'a' }, { type: 'panel', panel: 'いない' }],
    }, [{ id: 'a', kind: 'conversation' }]);
    assert.equal(layout.root.type, 'panel');
  });

  test('向きが変なら横並びとして読む', () => {
    const { layout, repairs } = base({
      type: 'split', direction: '斜め', sizes: [0.5, 0.5],
      children: [{ type: 'panel', panel: 'a' }, { type: 'panel', panel: 'b' }],
    });
    assert.equal((layout.root as { direction: string }).direction, 'row');
    assert.ok(repairs.some((r) => r.detail.includes('向き')));
  });

  test('type を書き忘れても、形から読み取る', () => {
    const { layout } = base({
      children: [{ panel: 'a' }, { panel: 'b' }],
    });
    assert.equal(layout.root.type, 'split');
    assert.deepEqual(panelsInOrder(layout.root), ['a', 'b']);
  });

  test('重ね置きの初期選択が範囲外なら先頭にする', () => {
    const { layout } = base({ type: 'tabs', panels: ['a', 'b'], active: 99 });
    assert.equal((layout.root as { active: number }).active, 0);
  });

  test('名前の重複は一つにする', () => {
    const { layout, repairs } = repairLayout({
      panels: [{ id: 'a', kind: 'conversation' }, { id: 'a', kind: 'plan' }],
      root: { type: 'panel', panel: 'a' },
    });
    assert.equal(layout.panels.length, 1);
    assert.ok(repairs.some((r) => r.detail.includes('重複')));
  });
});

describe('知らない中身', () => {
  test('消さずに、何が置かれようとしたかを画面に出す', () => {
    const { layout, repairs } = repairLayout({
      panels: [{ id: 'a', kind: '未来の機能' }],
      root: { type: 'panel', panel: 'a' },
    });
    const p = layout.panels[0]!;
    assert.equal(p.kind, 'note');
    assert.ok(String(p.options?.text).includes('未来の機能'));
    assert.ok(repairs.some((r) => r.detail.includes('未来の機能')));
  });

  test('知っている中身は全部そのまま通る', () => {
    const panels = PANEL_KINDS.map((k, i) => ({ id: `p${i}`, kind: k }));
    const { layout, repairs } = repairLayout({
      panels, root: { type: 'tabs', panels: panels.map((p) => p.id) },
    });
    assert.deepEqual(repairs, []);
    assert.deepEqual(layout.panels.map((p) => p.kind), [...PANEL_KINDS]);
  });
});

describe('見た目の指定', () => {
  test('変な値なら既定に戻す', () => {
    const { layout } = repairLayout({
      panels: [{ id: 'a', kind: 'conversation' }],
      root: { type: 'panel', panel: 'a' }, theme: '虹色', density: 'すごい',
    });
    assert.equal(layout.theme, 'auto');
    assert.equal(layout.density, 'comfortable');
  });

  test('正しい値は保つ', () => {
    const { layout } = repairLayout({
      panels: [{ id: 'a', kind: 'conversation' }],
      root: { type: 'panel', panel: 'a' }, theme: 'dark', density: 'compact',
    });
    assert.equal(layout.theme, 'dark');
    assert.equal(layout.density, 'compact');
  });
});

describe('直した結果は、もう直す必要が無い', () => {
  const broken: unknown[] = [
    null, {}, 'x', [1],
    { panels: [{ id: 'a', kind: '知らない' }], root: { type: 'panel', panel: 'いない' } },
    { panels: [{ id: 'a', kind: 'plan' }, { id: 'b', kind: 'log' }], root: { type: 'panel', panel: 'a' } },
    { panels: [{ id: 'a', kind: 'plan' }], root: { children: [{ panel: 'a' }, { panel: 'a' }] } },
  ];

  for (const [i, raw] of broken.entries()) {
    test(`${i + 1}件目を直した結果は安定している`, () => {
      const once = repairLayout(raw).layout;
      const twice = repairLayout(once);
      assert.deepEqual(twice.repairs, [], `二度目でまだ直している: ${JSON.stringify(twice.repairs)}`);
      assert.deepEqual(twice.layout, once as Layout);
    });
  }
});
