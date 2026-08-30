/**
 * ループエンジンの検証。
 * 新しいループを足したときに安全装置が自動で付くことを確かめる。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runLoop, type LoopCheck, type LoopEvent } from '../src/harness/loop.ts';

async function drain<C extends LoopCheck>(gen: AsyncGenerator<LoopEvent<C>, unknown>) {
  const events: LoopEvent<C>[] = [];
  let next = await gen.next();
  while (!next.done) { events.push(next.value); next = await gen.next(); }
  return { events, result: next.value as { passed: boolean; rounds: number; reason: string } };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('ループエンジン', () => {
  test('既に到達していれば何も試さない', async () => {
    let attempts = 0;
    const { result } = await drain(runLoop(
      { name: 'test' },
      async () => ({ passed: true, digest: 'ok' }),
      async () => { attempts += 1; },
      new AbortController().signal,
    ));
    assert.equal(result.passed, true);
    assert.equal(result.rounds, 1);
    assert.equal(attempts, 0, '到達済みなのに試行している');
  });

  test('改善すれば到達し、そこで止まる', async () => {
    let state = 0;
    const { result } = await drain(runLoop(
      { name: 'test' },
      async () => ({ passed: state >= 2, digest: `s${state}`, feedback: `now ${state}` }),
      async () => { state += 1; },
      new AbortController().signal,
    ));
    assert.equal(result.passed, true);
    assert.equal(result.rounds, 3);
  });

  test('同じ状態が続けば諦める（回数上限を待たない）', async () => {
    let attempts = 0;
    const { result } = await drain(runLoop(
      { name: 'test', maxRounds: 20 },
      async () => ({ passed: false, digest: 'stuck' }),
      async () => { attempts += 1; },
      new AbortController().signal,
    ));
    assert.equal(result.reason, 'noProgress');
    assert.equal(result.rounds, 3);
    assert.equal(attempts, 2);
  });

  test('進んでいれば同じ回数でも続ける', async () => {
    let n = 0;
    const { result } = await drain(runLoop(
      { name: 'test', maxRounds: 5 },
      async () => { n += 1; return { passed: false, digest: `different-${n}` }; },
      async () => {},
      new AbortController().signal,
    ));
    assert.equal(result.reason, 'maxRounds');
    assert.equal(result.rounds, 5);
  });

  test('時間上限で止まる', async () => {
    const { result } = await drain(runLoop(
      { name: 'test', maxRounds: 50, timeBudgetMs: 30 },
      async () => ({ passed: false, digest: String(Math.random()) }),
      async () => { await sleep(20); },
      new AbortController().signal,
    ));
    assert.equal(result.reason, 'timeBudget');
  });

  test('中断できる', async () => {
    const ac = new AbortController();
    ac.abort();
    const { result } = await drain(runLoop(
      { name: 'test' },
      async () => ({ passed: false, digest: 'x' }),
      async () => {},
      ac.signal,
    ));
    assert.equal(result.reason, 'aborted');
  });

  test('失敗の情報が次の試行へ渡る', async () => {
    const seen: string[] = [];
    let state = 0;
    await drain(runLoop(
      { name: 'test', maxRounds: 3 },
      async () => { state += 1; return { passed: false, digest: `d${state}`, feedback: `失敗${state}` }; },
      async (feedback) => { seen.push(feedback); },
      new AbortController().signal,
    ));
    assert.deepEqual(seen, ['失敗1', '失敗2']);
  });

  test('停滞の判定回数を変えられる', async () => {
    const { result } = await drain(runLoop(
      { name: 'test', maxRounds: 20, stallLimit: 2 },
      async () => ({ passed: false, digest: 'same' }),
      async () => {},
      new AbortController().signal,
    ));
    assert.equal(result.rounds, 2);
  });
});
