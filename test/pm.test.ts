import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extractJson, repairPlan, breakCycles, normalizeWrite, toWorkItems, formatPlan,
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

describe('一人に任せない', () => {
  const withAccess: PmContext = {
    ...ctx,
    roleIds: ['worker', 'tester', 'breaker', 'reviewer', 'security', 'scout', 'librarian'],
    access: {
      worker: ['read', 'write', 'execute'],
      tester: ['read', 'execute'],
      breaker: ['read', 'execute'],
      reviewer: ['read'],
      security: ['read'],
      scout: ['read'],
      librarian: ['read'],
    },
    maxItems: 8,
  };
  const p2 = (items: unknown) => repairPlan({ items }, '元の依頼', withAccess);

  test('書いた件には、別の担当が確かめる工程が付く', () => {
    const p = p2([{ id: 'a', instruction: '直す', roleId: 'worker', writes: ['src/x.ts'] }]);
    const check = p.items.find((t) => t.id !== 'a');
    assert.ok(check, '確かめる工程が付いていない');
    assert.notEqual(check!.roleId, 'worker', '書いた本人が確かめている');
    assert.deepEqual(check!.deps, ['a']);
    assert.ok(p.repairs.some((r) => r.includes('一人に任せない')));
  });

  test('確かめる担当は書き込まない', () => {
    const p = p2([{ id: 'a', instruction: '直す', roleId: 'worker', writes: ['src/x.ts'] }]);
    assert.deepEqual(p.items.find((t) => t.id !== 'a')!.writes, []);
  });

  test('調べただけの件には、裏を取る工程が付く', () => {
    const p = p2([{ id: 'a', instruction: '調べる', roleId: 'scout' }]);
    const second = p.items.find((t) => t.id !== 'a');
    assert.ok(second);
    assert.notEqual(second!.roleId, 'scout');
    assert.ok(second!.instruction.includes('別の角度'));
  });

  test('既に別の担当が確かめているなら足さない', () => {
    const p = p2([
      { id: 'a', instruction: '直す', roleId: 'worker', writes: ['src/x.ts'] },
      { id: 'b', instruction: '確かめる', roleId: 'tester', deps: ['a'] },
    ]);
    // b 自身は調べる側なので裏取りが付く。a には付かない。
    assert.equal(p.items.filter((t) => t.deps?.includes('a')).length, 1);
  });

  test('同じ人が繰り返し当たらないよう、確かめる担当は順に回る', () => {
    const p = p2([
      { id: 'a', instruction: 'x', roleId: 'worker', writes: ['src/a.ts'] },
      { id: 'b', instruction: 'y', roleId: 'worker', writes: ['src/b.ts'] },
      { id: 'c', instruction: 'z', roleId: 'worker', writes: ['src/c.ts'] },
    ]);
    const checkers = p.items.filter((t) => t.id.endsWith('_2')).map((t) => t.roleId);
    assert.equal(checkers.length, 3);
    assert.ok(new Set(checkers).size > 1, `いつも同じ人が見ている: ${checkers}`);
  });

  test('確かめる工程にもレーンが割り当たる', () => {
    const p = p2([{ id: 'a', instruction: '直す', roleId: 'worker', writes: ['src/x.ts'] }]);
    for (const t of p.items) assert.ok(t.laneId, `${t.id} にレーンが無い`);
  });

  test('増えすぎない（上限の2倍で止める）', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      id: `t${i}`, instruction: `x${i}`, roleId: 'worker', writes: [`src/${i}.ts`],
    }));
    const p = p2(many);
    assert.ok(p.items.length <= 16, `増えすぎ: ${p.items.length}`);
  });

  test('権限が分からなければ足さない（誰が書くのか判断できないため）', () => {
    const p = repairPlan(
      { items: [{ id: 'a', instruction: '直す', roleId: 'worker', writes: ['src/x.ts'] }] },
      '元の依頼', { ...withAccess, access: undefined });
    assert.equal(p.items.length, 1);
  });

  test('明示的に切れる', () => {
    const p = repairPlan(
      { items: [{ id: 'a', instruction: '直す', roleId: 'worker', writes: ['src/x.ts'] }] },
      '元の依頼', { ...withAccess, secondPass: false });
    assert.equal(p.items.length, 1);
  });

  test('足した工程を入れても、全件が実行できる形になっている', async () => {
    const { Scheduler } = await import('../src/core/scheduler.ts');
    const p = p2([
      { id: 'a', instruction: '調べる', roleId: 'scout' },
      { id: 'b', instruction: '直す', roleId: 'worker', deps: ['a'], writes: ['src/x.ts'] },
    ]);
    const tasks = toWorkItems(p).map((w) => ({
      id: w.id, laneId: w.laneId, deps: w.deps, writes: w.writes,
      run: async () => w.id,
    }));
    const gen = new Scheduler(ctx.lanes).run(tasks, new AbortController().signal);
    let next = await gen.next();
    while (!next.done) next = await gen.next();
    const done = [...next.value.values()].filter((o) => o.state === 'done').length;
    assert.equal(done, p.items.length, '未実施が出た');
  });
});

describe('ID を付け直すとき、後ろの項目の ID と重ねない', () => {
  test('[t1, t1, t1_2] の t1_2 を deps で指す先が入れ替わらない', () => {
    const p = plan([
      { id: 't1', instruction: 'a', laneId: 'fast' },
      { id: 't1', instruction: 'b', laneId: 'fast' },
      { id: 't1_2', instruction: 'c', laneId: 'fast' },
      { id: 't4', instruction: 'd', laneId: 'fast', deps: ['t1_2'] },
    ]);
    const ids = p.items.map((i) => i.id);
    assert.equal(new Set(ids).size, ids.length, ids.join(', '));
    const c = p.items.find((i) => i.instruction === 'c')!;
    assert.equal(c.id, 't1_2', `後ろの項目の ID を変えた: ${ids.join(', ')}`);
    assert.deepEqual(p.items.find((i) => i.instruction === 'd')!.deps, ['t1_2']);
  });
});

describe('ID が重なった計画に、確かめる工程を足すとき', () => {
  test('足した工程の ID も重ならない（重なると確かめる工程が黙って消える）', () => {
    const p = repairPlan({ items: [
      { id: 't1', instruction: 'a を書く', roleId: 'coder', writes: ['a.ts'] },
      { id: 't1', instruction: 'b を書く', roleId: 'coder' },
    ] }, 'r', {
      lanes: [{ id: 'main', candidates: ['a'], parallel: 1 }], roleIds: ['coder', 'tester'], fallbackRoleId: 'coder',
      access: { coder: ['read', 'write'], tester: ['read', 'exec'] },
    } as PmContext);
    const ids = p.items.map((i) => i.id);
    assert.equal(new Set(ids).size, ids.length, `ID が重なっている: ${ids.join(', ')}`);
  });
});
