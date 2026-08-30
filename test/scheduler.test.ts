import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler, type Task, type TaskOutcome, type SchedulerEvent } from '../src/core/scheduler.ts';
import { Semaphore } from '../src/core/lane.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function drain(
  sched: Scheduler, tasks: Task[],
): Promise<{ outcomes: Map<string, TaskOutcome>; order: string[]; events: SchedulerEvent[] }> {
  const order: string[] = [];
  const events: SchedulerEvent[] = [];
  const gen = sched.run(tasks, new AbortController().signal);
  let next = await gen.next();
  while (!next.done) {
    const ev = next.value;
    events.push(ev);
    if (ev.type === 'start') order.push(ev.taskId);
    next = await gen.next();
  }
  return { outcomes: next.value, order, events };
}

describe('Semaphore', () => {
  test('上限を超えて同時に走らない', async () => {
    const sem = new Semaphore(2);
    let concurrent = 0, peak = 0;
    await Promise.all([1, 2, 3, 4, 5].map(async () => {
      await sem.acquire();
      concurrent += 1; peak = Math.max(peak, concurrent);
      await sleep(20);
      concurrent -= 1;
      sem.release();
    }));
    assert.equal(peak, 2);
  });
});

describe('Scheduler', () => {
  test('レーンの並列上限を超えない', async () => {
    const sched = new Scheduler([{ id: 'coder', candidates: ['local:m'], parallel: 3 }]);
    let concurrent = 0, peak = 0;
    const tasks: Task[] = Array.from({ length: 8 }, (_, i) => ({
      id: `t${i}`, laneId: 'coder',
      async run() {
        concurrent += 1; peak = Math.max(peak, concurrent);
        await sleep(30);
        concurrent -= 1;
        return i;
      },
    }));
    const { outcomes } = await drain(sched, tasks);
    assert.equal(peak, 3, `並列度が上限を超えた: ${peak}`);
    assert.equal([...outcomes.values()].filter((o) => o.state === 'done').length, 8);
  });

  test('依存が解けるまで開始しない', async () => {
    const sched = new Scheduler([{ id: 'l', candidates: ['local:m'], parallel: 4 }]);
    const done: string[] = [];
    const mk = (id: string, deps?: string[]): Task => ({
      id, laneId: 'l', deps,
      async run() { await sleep(10); done.push(id); return id; },
    });
    const { order } = await drain(sched, [mk('c', ['a', 'b']), mk('a'), mk('b')]);
    assert.equal(order.indexOf('c') > order.indexOf('a'), true);
    assert.equal(order.indexOf('c') > order.indexOf('b'), true);
    assert.equal(done.at(-1), 'c');
  });

  test('書き込み先が重なるタスクは同時に走らない', async () => {
    const sched = new Scheduler([{ id: 'l', candidates: ['local:m'], parallel: 4 }]);
    let sameFileConcurrent = 0, peak = 0;
    const mk = (id: string, file: string): Task => ({
      id, laneId: 'l', writes: [file],
      async run() {
        if (file === 'a.ts') { sameFileConcurrent += 1; peak = Math.max(peak, sameFileConcurrent); }
        await sleep(30);
        if (file === 'a.ts') sameFileConcurrent -= 1;
        return id;
      },
    });
    await drain(sched, [mk('x', 'a.ts'), mk('y', 'a.ts'), mk('z', 'b.ts')]);
    assert.equal(peak, 1, '同一ファイルへの書き込みが並行してしまった');
  });

  test('別ファイルなら並行して走る', async () => {
    const sched = new Scheduler([{ id: 'l', candidates: ['local:m'], parallel: 4 }]);
    let concurrent = 0, peak = 0;
    const mk = (id: string, file: string): Task => ({
      id, laneId: 'l', writes: [file],
      async run() {
        concurrent += 1; peak = Math.max(peak, concurrent);
        await sleep(30);
        concurrent -= 1;
        return id;
      },
    });
    await drain(sched, [mk('x', 'a.ts'), mk('y', 'b.ts'), mk('z', 'c.ts')]);
    assert.equal(peak, 3);
  });

  test('失敗しても全体は止まらず、依存先だけ skipped になる', async () => {
    const sched = new Scheduler([{ id: 'l', candidates: ['local:m'], parallel: 2 }]);
    const tasks: Task[] = [
      { id: 'bad', laneId: 'l', async run() { throw new Error('壊れました'); } },
      { id: 'child', laneId: 'l', deps: ['bad'], async run() { return 'ここには来ない'; } },
      { id: 'other', laneId: 'l', async run() { await sleep(10); return 'ok'; } },
    ];
    const { outcomes } = await drain(sched, tasks);
    assert.equal(outcomes.get('bad')?.state, 'failed');
    assert.match(outcomes.get('bad')?.error ?? '', /壊れました/);
    assert.equal(outcomes.get('child')?.state, 'skipped');
    assert.equal(outcomes.get('other')?.state, 'done', '無関係なタスクまで巻き込まれている');
  });

  test('複数レーンはそれぞれの上限で同時に走る', async () => {
    const sched = new Scheduler([
      { id: 'gpu', candidates: ['local:big'], parallel: 1 },
      { id: 'cpu', candidates: ['local:small'], parallel: 2 },
    ]);
    const active = new Map<string, number>([['gpu', 0], ['cpu', 0]]);
    const peak = new Map<string, number>([['gpu', 0], ['cpu', 0]]);
    const mk = (id: string, laneId: string): Task => ({
      id, laneId,
      async run() {
        active.set(laneId, active.get(laneId)! + 1);
        peak.set(laneId, Math.max(peak.get(laneId)!, active.get(laneId)!));
        await sleep(30);
        active.set(laneId, active.get(laneId)! - 1);
        return id;
      },
    });
    await drain(sched, [
      mk('g1', 'gpu'), mk('g2', 'gpu'),
      mk('c1', 'cpu'), mk('c2', 'cpu'), mk('c3', 'cpu'),
    ]);
    assert.equal(peak.get('gpu'), 1);
    assert.equal(peak.get('cpu'), 2);
  });

  test('レーンごとに別のモデル候補が渡る', async () => {
    const sched = new Scheduler([
      { id: 'gpu', candidates: ['local:coder14b'], parallel: 1 },
      { id: 'cpu', candidates: ['local:small3b'], parallel: 1 },
    ]);
    const seen = new Map<string, string[]>();
    const mk = (id: string, laneId: string): Task => ({
      id, laneId,
      async run(ctx) { seen.set(id, ctx.candidates); return id; },
    });
    await drain(sched, [mk('a', 'gpu'), mk('b', 'cpu')]);
    assert.deepEqual(seen.get('a'), ['local:coder14b']);
    assert.deepEqual(seen.get('b'), ['local:small3b']);
  });

  test('循環依存はデッドロックせず skipped で終わる', async () => {
    const sched = new Scheduler([{ id: 'l', candidates: ['local:m'], parallel: 2 }]);
    const { outcomes } = await drain(sched, [
      { id: 'a', laneId: 'l', deps: ['b'], async run() { return 'a'; } },
      { id: 'b', laneId: 'l', deps: ['a'], async run() { return 'b'; } },
    ]);
    assert.equal(outcomes.get('a')?.state, 'skipped');
    assert.equal(outcomes.get('b')?.state, 'skipped');
  });
});

describe('実行スタイル', () => {
  test('直列リレー（全レーン parallel:1）でも全タスクが完了する', async () => {
    const sched = new Scheduler([
      { id: 'big', candidates: ['local:32b'], parallel: 1 },
      { id: 'small', candidates: ['local:7b'], parallel: 1 },
    ], 1); // 全体でも1件ずつ = 完全な直列
    let concurrent = 0, peak = 0;
    const mk = (id: string, laneId: string): Task => ({
      id, laneId,
      async run() {
        concurrent += 1; peak = Math.max(peak, concurrent);
        await sleep(15);
        concurrent -= 1;
        return id;
      },
    });
    const { outcomes } = await drain(sched, [
      mk('a', 'big'), mk('b', 'small'), mk('c', 'big'), mk('d', 'small'),
    ]);
    assert.equal(peak, 1, '直列指定なのに並行した');
    assert.equal([...outcomes.values()].filter((o) => o.state === 'done').length, 4);
  });

  test('同じレーンのタスクをまとめて流し、モデル切替を減らす', async () => {
    const sched = new Scheduler([
      { id: 'big', candidates: ['local:32b'], parallel: 1 },
      { id: 'small', candidates: ['local:7b'], parallel: 1 },
    ], 1);
    const order: string[] = [];
    const mk = (id: string, laneId: string): Task => ({
      id, laneId,
      async run() { order.push(laneId); await sleep(10); return id; },
    });
    // 交互に並べても、レーンごとにまとまって実行されることを期待する
    await drain(sched, [
      mk('a', 'big'), mk('b', 'small'), mk('c', 'big'), mk('d', 'small'),
    ]);
    let switches = 0;
    for (let i = 1; i < order.length; i += 1) if (order[i] !== order[i - 1]) switches += 1;
    assert.ok(switches <= 2, `レーン切替が多すぎる: ${switches}回 (${order.join('→')})`);
  });

  test('即座に終わるタスクでも、依存の先へ進む（待ち合わせが空回りしない）', async () => {
    // 待ち時間ゼロで終わると、待ち合わせを組む前に全部終わってしまう。
    // そこで「誰も走っていないものを待つ」形になると、そこで永久に止まる。
    const sched = new Scheduler([{ id: 'l', candidates: ['local:m'], parallel: 2 }]);
    const tasks: Task[] = [
      { id: 'a', laneId: 'l', deps: ['b'], async run() { return 'a'; } },
      { id: 'b', laneId: 'l', async run() { return 'b'; } },
    ];
    const { outcomes } = await drain(sched, tasks);
    assert.equal([...outcomes.values()].filter((o) => o.state === 'done').length, 2);
  });

  test('同時に終わった完了を取りこぼさない', async () => {
    const sched = new Scheduler([{ id: 'l', candidates: ['local:m'], parallel: 5 }]);
    const tasks: Task[] = Array.from({ length: 5 }, (_, i) => ({
      id: `t${i}`, laneId: 'l',
      async run() { await sleep(10); return i; },
    }));
    const { events, outcomes } = await drain(sched, tasks);
    const ends = events.filter((e) => e.type === 'end');
    assert.equal(ends.length, 5, `完了イベントが欠けた: ${ends.length}`);
    assert.equal([...outcomes.values()].every((o) => o.state === 'done'), true);
  });
});
