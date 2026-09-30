/**
 * 冗長実行の検証。
 * 計算が無料なローカルで、同じ作業を複数モデルにやらせて
 * 速度と品質を買い戻せることを確認する。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { race, bestOf, type Attempt, type RaceEvent } from '../src/agent/race.ts';

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
  });

const attempt = (
  label: string, ms: number, value: string, opts: { fail?: boolean } = {},
): Attempt<string> => ({
  label,
  async run(signal) {
    await sleep(ms, signal);
    if (opts.fail) throw new Error(`${label} が失敗`);
    return value;
  },
});

const ok = (r: string) => r === 'good';

describe('race（最初に通ったものを採る）', () => {
  test('始める前に止められていたら、何も走らせない', async () => {
    const ac = new AbortController();
    ac.abort();
    let ran = 0;
    const out = await race([{ label: 'a', run: async () => { ran += 1; return 'good'; } }], ok, ac.signal);
    assert.equal(ran, 0, '止めたのに走らせた');
    assert.equal(out.winner, undefined);
  });

  test('最速の成功が採用される', async () => {
    const out = await race(
      [attempt('slow', 80, 'good'), attempt('fast', 10, 'good')],
      ok, new AbortController().signal,
    );
    assert.equal(out.winner?.label, 'fast');
  });

  test('速いモデルが外しても、遅い確実なモデルが拾う', async () => {
    const out = await race(
      [attempt('fast-but-wrong', 10, 'bad'), attempt('slow-but-right', 60, 'good')],
      ok, new AbortController().signal,
    );
    assert.equal(out.winner?.label, 'slow-but-right');
    assert.equal(out.winner?.result, 'good');
  });

  test('採用が決まれば残りを打ち切る', async () => {
    const events: RaceEvent[] = [];
    await race(
      [attempt('fast', 10, 'good'), attempt('slow', 500, 'good')],
      ok, new AbortController().signal, (e) => events.push(e),
    );
    assert.ok(events.some((e) => e.type === 'cancel' && e.label === 'slow'),
      '負けた側を打ち切っていない');
  });

  test('打ち切りを待ってから返る（後始末を残さない）', async () => {
    let stillRunning = false;
    const lingering: Attempt<string> = {
      label: 'lingering',
      async run(signal) {
        try { await sleep(300, signal); } catch { /* 中断 */ }
        stillRunning = false;
        return 'bad';
      },
    };
    stillRunning = true;
    await race([attempt('fast', 10, 'good'), lingering], ok, new AbortController().signal);
    assert.equal(stillRunning, false, '打ち切った側の完了を待っていない');
  });

  test('全部失敗したら winner なし。結果は残る', async () => {
    const out = await race(
      [attempt('a', 10, 'bad'), attempt('b', 20, 'x', { fail: true })],
      ok, new AbortController().signal,
    );
    assert.equal(out.winner, undefined);
    assert.equal(out.others.length, 2);
    assert.ok(out.others.some((o) => o.error));
  });

  test('例外を投げるモデルがいても、他が成功すれば採用される', async () => {
    const out = await race(
      [attempt('broken', 5, 'x', { fail: true }), attempt('working', 30, 'good')],
      ok, new AbortController().signal,
    );
    assert.equal(out.winner?.label, 'working');
  });

  test('外側から中断すれば全部止まる', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20);
    const out = await race(
      [attempt('a', 500, 'good'), attempt('b', 500, 'good')], ok, ac.signal,
    );
    assert.equal(out.winner, undefined);
  });

  test('単独実行より遅くならない', async () => {
    const started = Date.now();
    await race(
      [attempt('fast', 20, 'good'), attempt('slow', 400, 'good')],
      ok, new AbortController().signal,
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 200, `最速に律速されていない: ${elapsed}ms`);
  });

  test('候補が空でも落ちない', async () => {
    const out = await race([], ok, new AbortController().signal);
    assert.equal(out.winner, undefined);
  });
});

describe('bestOf（採点して最良を採る）', () => {
  test('点数が最も高い答えを採用する', async () => {
    const out = await bestOf(
      [attempt('a', 10, 'poor'), attempt('b', 10, 'great'), attempt('c', 10, 'ok')],
      (r) => ({ poor: 1, ok: 2, great: 3 }[r] ?? 0),
      new AbortController().signal,
    );
    assert.equal(out.best?.label, 'b');
    assert.equal(out.ranked[0]!.label, 'b');
  });

  test('失敗した試行は最下位になり、全体は落ちない', async () => {
    const out = await bestOf(
      [attempt('broken', 5, 'x', { fail: true }), attempt('fine', 10, 'ok')],
      (r) => (r === 'ok' ? 5 : 0),
      new AbortController().signal,
    );
    assert.equal(out.best?.label, 'fine');
    assert.equal(out.ranked.at(-1)!.label, 'broken');
    assert.ok(out.ranked.at(-1)!.error);
  });

  test('全部失敗すれば best なし', async () => {
    const out = await bestOf(
      [attempt('a', 5, 'x', { fail: true }), attempt('b', 5, 'y', { fail: true })],
      () => 1, new AbortController().signal,
    );
    assert.equal(out.best, undefined);
  });

  test('非同期の採点（テスト実行など）を扱える', async () => {
    const out = await bestOf(
      [attempt('a', 5, 'one'), attempt('b', 5, 'three')],
      async (r) => { await sleep(5); return r.length; },
      new AbortController().signal,
    );
    assert.equal(out.best?.label, 'b'); // 'three' の方が長い
  });
});
