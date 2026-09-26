/**
 * 作業場の錠（`src/core/workspace-lock.ts`）。
 *
 * 二つの会話が同じ作業場へ同時に書かないための錠。来た順に渡すこと、止められた待ち手が列から抜けること、
 * 同じ持ち主は待たないこと、持ち主でない返却で壊れないことを見る。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceLock } from '../src/core/workspace-lock.ts';

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('作業場の錠', () => {
  test('持ち主が返すまで、ほかは待つ。来た順に渡す', async () => {
    const lock = new WorkspaceLock();
    await lock.acquire('A');
    const got: string[] = [];
    const b = lock.acquire('B').then(() => got.push('B'));
    const c = lock.acquire('C').then(() => got.push('C'));
    await tick();
    assert.deepEqual(got, [], '持ち主が居るのに渡した');
    assert.equal(lock.waiting, 2);
    lock.release('A');
    await b;
    assert.equal(lock.owner, 'B');
    assert.deepEqual(got, ['B']);
    lock.release('B');
    await c;
    assert.equal(lock.owner, 'C');
    lock.release('C');
    assert.equal(lock.held, false);
  });

  test('同じ持ち主は待たない（一つの依頼で何度書いても）', async () => {
    const lock = new WorkspaceLock();
    await lock.acquire('A');
    await lock.acquire('A');
    assert.equal(lock.owner, 'A');
  });

  test('止められた待ち手は列から抜け、錠は次へ渡る', async () => {
    const lock = new WorkspaceLock();
    await lock.acquire('A');
    const ac = new AbortController();
    const b = lock.acquire('B', ac.signal);
    const c = lock.acquire('C');
    ac.abort();
    await assert.rejects(b);
    assert.equal(lock.waiting, 1);
    lock.release('A');
    await c;
    assert.equal(lock.owner, 'C', '止めた B に渡した');
  });

  test('持ち主でない者が返しても、錠は外れない', async () => {
    const lock = new WorkspaceLock();
    await lock.acquire('A');
    lock.release('B');
    assert.equal(lock.owner, 'A');
  });

  test('待たずに取る: 空いていれば取り、ほかが持っていれば断る（列には並ばない）', async () => {
    const lock = new WorkspaceLock();
    assert.equal(lock.tryAcquire('hand'), true);
    assert.equal(lock.tryAcquire('B'), false);
    assert.equal(lock.waiting, 0);
    lock.release('hand');
    assert.equal(lock.held, false);
  });
});
