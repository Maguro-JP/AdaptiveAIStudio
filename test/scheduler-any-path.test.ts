/**
 * 書き込み先を挙げない書き手（ANY_PATH）は、誰とも同時に走らない。（04）時刻ではなく、手で開ける門で見る。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler, ANY_PATH, type Task } from '../src/core/scheduler.ts';

function gate() { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; }

test('ANY_PATH の書き手が走っている間、ほかの書き手は始まらない', async () => {
  const started: string[] = [];
  const g = gate();
  const t = (id: string, writes: string[], wait?: Promise<void>): Task => ({
    id, laneId: 'l', writes, run: async () => { started.push(id); await wait; return id; },
  });
  const sched = new Scheduler([{ id: 'l', candidates: ['m'], parallel: 3 }]);
  const gen = sched.run([t('any', [ANY_PATH], g.p), t('a', ['a.ts']), t('b', [ANY_PATH])], new AbortController().signal);
  // 最初の idle（誰かを待ち始めた）まで進める
  for (let n = await gen.next(); !n.done; n = await gen.next()) {
    if (n.value.type === 'idle') break;
  }
  assert.deepEqual(started, ['any'], `宣言の無い書き手と同時に始まった: ${started.join(',')}`);
  g.open();
  let n = await gen.next();
  while (!n.done) n = await gen.next();
  assert.deepEqual(started.slice().sort(), ['a', 'any', 'b']);
});

test('宣言どうしが重ならなければ、今までどおり並ぶ（対）', async () => {
  const started: string[] = [];
  const g = gate();
  const t = (id: string, writes: string[]): Task => ({ id, laneId: 'l', writes, run: async () => { started.push(id); await g.p; return id; } });
  const sched = new Scheduler([{ id: 'l', candidates: ['m'], parallel: 3 }]);
  const gen = sched.run([t('a', ['a.ts']), t('b', ['b.ts'])], new AbortController().signal);
  for (let n = await gen.next(); !n.done; n = await gen.next()) if (n.value.type === 'idle') break;
  assert.deepEqual(started, ['a', 'b']);
  g.open();
  for (let n = await gen.next(); !n.done; n = await gen.next()) { /* 流す */ }
});
