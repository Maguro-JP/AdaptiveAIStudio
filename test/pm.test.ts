import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractJson, repairPlan, breakCycles, normalizeWrite, toWorkItems, formatPlan,
  type PmContext, type PlanItem,
} from '../src/agent/pm.ts';

const ctx: PmContext = {
  lanes: [
    { id: 'fast', candidates: ['a'], parallel: 2 },
    { id: 'strong', candidates: ['b'], parallel: 1 },
  ],
  roleIds: ['worker', 'tester', 'scout'],
  fallbackRoleId: 'worker',
  maxItems: 4,
};

const plan = (items: unknown, summary = 'まとめ') => repairPlan({ summary, items }, '元の依頼', ctx);

describe('JSON の取り出し', () => {
  test('素の JSON', () => {
    assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  });

  test('前後に喋られていても拾う', () => {
    assert.deepEqual(extractJson('了解しました。\n{"a":1}\n以上です。'), { a: 1 });
  });

  test('コードフェンスに包まれていても拾う', () => {
    assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  });

  test('壊れていれば undefined（例外は投げない）', () => {
    assert.equal(extractJson('{"a":'), undefined);
    assert.equal(extractJson('何も返ってこなかった'), undefined);
  });
});

describe('計画の修理', () => {
  test('まともな計画はそのまま通る', () => {
    const p = plan([
      { id: 'a', instruction: '調べる', roleId: 'scout', deps: [] },
      { id: 'b', instruction: '直す', roleId: 'worker', deps: ['a'], writes: ['src/x.ts'] },
    ]);
    assert.equal(p.items.length, 2);
    assert.deepEqual(p.repairs, []);
    assert.deepEqual(p.items[1]!.deps, ['a']);
  });

  test('指示の無い件は外す', () => {
    const p = plan([{ id: 'a', roleId: 'worker' }, { id: 'b', instruction: 'やる' }]);
    assert.equal(p.items.length, 1);
    assert.ok(p.repairs.some((r) => r.includes('指示が無い')));
  });

  test('存在しない担当は引き受け役に替える', () => {
    const p = plan([{ id: 'a', instruction: 'x', roleId: 'wizard' }]);
    assert.equal(p.items[0]!.roleId, 'worker');
    assert.ok(p.repairs.some((r) => r.includes('wizard')));
  });

  test('存在しないレーンは割り当て直す', () => {
    const p = plan([{ id: 'a', instruction: 'x', laneId: 'gpu99' }]);
    assert.ok(['fast', 'strong'].includes(p.items[0]!.laneId!));
    assert.ok(p.repairs.some((r) => r.includes('gpu99')));
  });

  test('ID の重複は付け替える', () => {
    const p = plan([
      { id: 'a', instruction: 'x' },
      { id: 'a', instruction: 'y' },
    ]);
    assert.equal(new Set(p.items.map((t) => t.id)).size, 2);
    assert.ok(p.repairs.some((r) => r.includes('重複')));
  });

  test('存在しない依存は外す', () => {
    const p = plan([{ id: 'a', instruction: 'x', deps: ['nope'] }]);
    assert.deepEqual(p.items[0]!.deps, []);
    assert.ok(p.repairs.some((r) => r.includes('nope')));
  });

  test('自分自身を待つ依存は外す', () => {
    const p = plan([{ id: 'a', instruction: 'x', deps: ['a'] }]);
    assert.deepEqual(p.items[0]!.deps, []);
  });

  test('分け過ぎは絞る', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ id: `t${i}`, instruction: `x${i}` }));
    const p = plan(many);
    assert.equal(p.items.length, 4);
    assert.ok(p.repairs.some((r) => r.includes('分け過ぎ')));
  });

  test('絞ったあと、切られた件への依存も外れる', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      id: `t${i}`, instruction: `x${i}`, deps: ['t8'],
    }));
    const p = plan(many);
    for (const item of p.items) assert.deepEqual(item.deps, [], item.id);
  });

  test('レーンは配って偏らせない', () => {
    const p = plan([
      { id: 'a', instruction: 'x' }, { id: 'b', instruction: 'y' },
    ]);
    assert.deepEqual(p.items.map((t) => t.laneId), ['fast', 'strong']);
  });

  test('書き込み先の表記を揃える（錠が効かなくなるため）', () => {
    const p = plan([{ id: 'a', instruction: 'x', writes: ['./src/x.ts', 'src\\y.ts', '/src/z.ts'] }]);
    assert.deepEqual(p.items[0]!.writes, ['src/x.ts', 'src/y.ts', 'src/z.ts']);
  });
});

describe('分解できなかったとき', () => {
  test('空の計画でも一人で引き受ける形になる', () => {
    const p = repairPlan({ items: [] }, '元の依頼', ctx);
    assert.equal(p.items.length, 1);
    assert.equal(p.items[0]!.instruction, '元の依頼');
    assert.equal(p.items[0]!.roleId, 'worker');
    assert.ok(p.items[0]!.laneId);
  });

  test('JSON が返ってこなくても計画になる', () => {
    const p = repairPlan(undefined, '元の依頼', ctx);
    assert.equal(p.items.length, 1);
    assert.equal(p.summary, '元の依頼');
  });

  test('items が配列ですらなくても落ちない', () => {
    const p = repairPlan({ items: 'よろしく' }, '元の依頼', ctx);
    assert.equal(p.items.length, 1);
  });
});

describe('循環の切断', () => {
  test('二者の循環を断つ', () => {
    const items: PlanItem[] = [
      { id: 'a', instruction: 'x', roleId: 'worker', deps: ['b'] },
      { id: 'b', instruction: 'y', roleId: 'worker', deps: ['a'] },
    ];
    const repairs: string[] = [];
    breakCycles(items, repairs);
    const total = items.reduce((n, t) => n + t.deps!.length, 0);
    assert.equal(total, 1);
    assert.equal(repairs.length, 1);
  });

  test('三者の循環でも、全件が着手できる形になる', () => {
    const p = plan([
      { id: 'a', instruction: 'x', deps: ['c'] },
      { id: 'b', instruction: 'y', deps: ['a'] },
      { id: 'c', instruction: 'z', deps: ['b'] },
    ]);
    // 循環を残したままだと、スケジューラで全件が未実施になる
    const startable = p.items.filter((t) => t.deps!.length === 0);
    assert.ok(startable.length >= 1, '着手できる件が無い');
  });

  test('循環していない依存は残す', () => {
    const p = plan([
      { id: 'a', instruction: 'x' },
      { id: 'b', instruction: 'y', deps: ['a'] },
      { id: 'c', instruction: 'z', deps: ['a', 'b'] },
    ]);
    assert.deepEqual(p.items[2]!.deps, ['a', 'b']);
    assert.deepEqual(p.repairs, []);
  });
});

describe('作業指示への変換', () => {
  test('レーンが必ず入る', () => {
    const p = plan([{ id: 'a', instruction: 'x' }]);
    for (const w of toWorkItems(p)) assert.ok(w.laneId);
  });

  test('担当が引き継がれる（権限がここで決まる）', () => {
    const p = plan([{ id: 'a', instruction: 'x', roleId: 'tester' }]);
    assert.equal(toWorkItems(p)[0]!.roleId, 'tester');
  });

  test('表示に、すぐ着手できる件と修正内容が出る', () => {
    const p = plan([
      { id: 'a', instruction: '調べる' },
      { id: 'b', instruction: '直す', deps: ['zzz'] },
    ]);
    const out = formatPlan(p);
    assert.ok(out.includes('すぐ着手'));
    assert.ok(out.includes('計画の修正'));
  });
});

describe('書き込み先の正規化', () => {
  test('表記を揃える', () => {
    assert.equal(normalizeWrite(' ./src/a.ts '), 'src/a.ts');
    assert.equal(normalizeWrite('src\\b.ts'), 'src/b.ts');
    assert.equal(normalizeWrite('//src/c.ts'), 'src/c.ts');
  });
});

describe('計画がそのまま流せること', () => {
  test('修理された計画は、スケジューラで全件が実行される', async () => {
    const { Scheduler } = await import('../src/core/scheduler.ts');
    // 壊れた計画 — 循環・存在しない依存・重複ID・不明なレーンが全部入っている
    const p = repairPlan({
      items: [
        { id: 'a', instruction: '調べる', roleId: 'scout', deps: ['b'], laneId: 'gpu99' },
        { id: 'b', instruction: '直す', roleId: 'worker', deps: ['a'], writes: ['src/x.ts'] },
        { id: 'b', instruction: '確かめる', roleId: 'tester', deps: ['nope'] },
      ],
    }, '元の依頼', ctx);

    const order: string[] = [];
    const tasks = toWorkItems(p).map((w) => ({
      id: w.id, laneId: w.laneId, deps: w.deps, writes: w.writes,
      run: async () => { order.push(w.id); return w.id; },
    }));

    const gen = new Scheduler(ctx.lanes).run(tasks, new AbortController().signal);
    let next = await gen.next();
    while (!next.done) next = await gen.next();

    const states = [...next.value.values()].map((o) => o.state);
    assert.deepEqual(states.filter((s) => s === 'done').length, 3, `未実施が出た: ${states}`);
    assert.equal(order.length, 3);
  });
});
