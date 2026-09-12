/**
 * 並列の口に優先度を付ける。**上から順に回り、高・中・低は取り分 0。**
 *
 * 級は 最優先 / 優先 / 高 / 中 / 低（利用者の言葉。中は 0〜4 の数）。
 * - 空いた口は、待っている人のうち級の小さい人へ。同じ級なら来た順
 * - 高・中・低は、上（最優先・優先）に待ち手が居ないときだけ借りる。
 *   さらに、口が 2 本以上なら半分（切り上げ）を上のために空けておく。
 *   1 本しか無ければ空けない（空けると永久に借りられない）
 * - 取り分は本数で決まる。設定ではない
 *
 * 触る前に、LanePool がこれまで黙って守っていたことを書き出す（ここで全部見る）:
 *   1. 同じ口を二人に貸さない
 *   2. 空いていれば、その場で借りられる
 *   3. 待っている間に切られたら、借りずに `undefined`。列からも消える
 *   4. 返したとき誰も待っていなければ、口は空きに戻る
 *   5. whenAllIdle は、呼んだ時点で出ている本数ぶん返れば返る（依頼が続いても）
 *
 * 待ちは時間で見ない。起きるまで見る（`until`）。
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { tempDir } from './tmp.ts';
import { InProcRuntime, LanePool, type ChatLane } from '../src/runtime/inproc.ts';
import { Priority, toPriority, DEFAULT_PRIORITY, PRIORITY_LABEL } from '../src/providers/contract.ts';
import { until } from './until.ts';

const lane = (): ChatLane => ({ prompt: async () => '', setChatHistory: () => {} });
const settle = () => new Promise<void>((r) => setImmediate(r));

/** 借りられたか（まだ待っているか）を外から見るための包み。 */
function tryAcquire(pool: LanePool, priority: Priority, signal?: AbortSignal) {
  const got: { lane?: ChatLane; done: boolean } = { done: false };
  const p = pool.acquire({ priority, signal }).then((l) => { got.lane = l; got.done = true; return l; });
  return { got, p };
}

describe('優先度: 上から順に回る', () => {
  test('**上が先に借りる**（低が先に並んでいても、最優先が次の口を取る）', async () => {
    const pool = new LanePool([lane()]);
    const a = await pool.acquire({ priority: Priority.low });
    assert.ok(a, '一本目が借りられていない');
    const low = tryAcquire(pool, Priority.low);      // 先に並ぶ
    const top = tryAcquire(pool, Priority.top);      // 後から来る
    await settle();
    assert.equal(low.got.done, false); assert.equal(top.got.done, false);
    pool.release(a!);
    await until(() => top.got.done, '最優先が次の口を取る', { timeoutMs: 5_000 });
    assert.equal(low.got.done, false, '低が先に取ってしまった');
    pool.release(top.got.lane!);
    await until(() => low.got.done, 'そのあと低が取る', { timeoutMs: 5_000 });
    pool.release(low.got.lane!);
    assert.equal(pool.busy, 0);
  });

  test('同じ級は来た順（対）', async () => {
    const pool = new LanePool([lane()]);
    const a = await pool.acquire({ priority: Priority.normal });
    const first = tryAcquire(pool, Priority.normal);
    const second = tryAcquire(pool, Priority.normal);
    await settle();
    pool.release(a!);
    await until(() => first.got.done, '先に来た人が先', { timeoutMs: 5_000 });
    assert.equal(second.got.done, false, '後から来た人が先に取った');
    pool.release(first.got.lane!);
    await until(() => second.got.done, '次に後の人', { timeoutMs: 5_000 });
    pool.release(second.got.lane!);
  });

  test('優先は最優先の後、高の前', async () => {
    const pool = new LanePool([lane()]);
    const a = await pool.acquire({ priority: Priority.top });
    const high = tryAcquire(pool, Priority.high);
    const preferred = tryAcquire(pool, Priority.preferred);
    const top = tryAcquire(pool, Priority.top);
    await settle();
    pool.release(a!);
    await until(() => top.got.done, '最優先', { timeoutMs: 5_000 });
    pool.release(top.got.lane!);
    await until(() => preferred.got.done, '次に優先', { timeoutMs: 5_000 });
    assert.equal(high.got.done, false);
    pool.release(preferred.got.lane!);
    await until(() => high.got.done, '最後に高', { timeoutMs: 5_000 });
    pool.release(high.got.lane!);
  });
});

describe('優先度: 高・中・低は取り分 0', () => {
  test('**上のために半分を空ける**（2 本: 中は 1 本まで。空いていても待つ。最優先はその場で借りる）', async () => {
    const pool = new LanePool([lane(), lane()]);
    assert.equal(pool.reserve, 1);
    const a = await pool.acquire({ priority: Priority.normal });
    assert.ok(a, '一本目の中が借りられていない');
    // 一本空いているのに、中の二人目は待つ。
    const b = tryAcquire(pool, Priority.normal);
    await settle();
    assert.equal(b.got.done, false, '中が上のぶんまで借りた');
    assert.equal(pool.busy, 1, '空けてあるはずの口が使われている');
    // 最優先は、その場で借りられる（待たない）。
    const top = tryAcquire(pool, Priority.top);
    await settle();
    assert.equal(top.got.done, true, '最優先が空いている口をその場で借りられない');
    assert.equal(pool.busy, 2);
    // 最優先が返しても、中の二人目にはまだ回らない（一人目が取り分を使っている）。
    pool.release(top.got.lane!);
    await settle();
    assert.equal(b.got.done, false, '取り分が塞がっているのに中へ回した');
    assert.equal(pool.busy, 1, '空けておくべき口が空いていない');
    // 一人目の中が返して、はじめて二人目へ。
    pool.release(a!);
    await until(() => b.got.done, '取り分が空いたら中の二人目へ', { timeoutMs: 5_000 });
    pool.release(b.got.lane!);
    assert.equal(pool.busy, 0);
    assert.equal(pool.lowHeld, 0, '高・中・低の数が戻っていない');
  });

  test('一本しか無ければ空けない。中でも、その場で借りられる（対）', async () => {
    const pool = new LanePool([lane()]);
    assert.equal(pool.reserve, 0);
    const a = await pool.acquire({ priority: Priority.low });
    assert.ok(a, '一本だけなのに低が借りられない');
    pool.release(a!);
  });

  test('空ける本数は本数の半分（切り上げ）', () => {
    assert.equal(new LanePool([lane(), lane(), lane()]).reserve, 2);
    assert.equal(new LanePool([lane(), lane(), lane(), lane()]).reserve, 2);
    assert.equal(new LanePool([lane(), lane(), lane(), lane(), lane()]).reserve, 3);
  });

  test('優先は取り分に数えない（中が一本使っていても、優先はもう一本を借りる）', async () => {
    const pool = new LanePool([lane(), lane()]);
    const a = await pool.acquire({ priority: Priority.normal });
    const p = await pool.acquire({ priority: Priority.preferred });
    assert.ok(a && p, '優先が借りられていない');
    assert.equal(pool.lowHeld, 1);
    // もう一人の優先は、口が無いので待つ（取り分ではなく、本数で待つ）。
    const q = tryAcquire(pool, Priority.preferred);
    await settle();
    assert.equal(q.got.done, false);
    // 中が返せば、待っている優先が受け取る（中の待ち手は居ない）。
    pool.release(a!);
    await until(() => q.got.done, '優先が受け取る', { timeoutMs: 5_000 });
    pool.release(p!); pool.release(q.got.lane!);
    assert.equal(pool.busy, 0);
  });
});

describe('優先度: 元から守っていたこと', () => {
  test('同じ口を二人に貸さない（本数を超えた分は待つ）', async () => {
    const pool = new LanePool([lane(), lane()]);
    const got = await Promise.all([
      pool.acquire({ priority: Priority.top }), pool.acquire({ priority: Priority.top }),
    ]);
    assert.ok(got[0] && got[1] && got[0] !== got[1], '同じ口を二人に貸した');
    const third = tryAcquire(pool, Priority.top);
    await settle();
    assert.equal(third.got.done, false, '三人目が借りられてしまった（口は 2 本）');
    pool.release(got[0]!);
    await until(() => third.got.done, '三人目', { timeoutMs: 5_000 });
    assert.ok(third.got.lane === got[0], '返した口が回っていない');
    pool.release(got[1]!); pool.release(third.got.lane!);
  });

  test('待っている間に切られたら、借りずに undefined。列からも消える（低）', async () => {
    const pool = new LanePool([lane()]);
    const a = await pool.acquire({ priority: Priority.top });
    const ac = new AbortController();
    const low = tryAcquire(pool, Priority.low, ac.signal);
    await settle();
    ac.abort();
    await until(() => low.got.done, '切られたら返る', { timeoutMs: 5_000 });
    assert.equal(low.got.lane, undefined, '切られたのに借りた');
    // 返した口は、消えた待ち手へは行かず、空きに戻る。
    pool.release(a!);
    await settle();
    assert.equal(pool.busy, 0, '消えた待ち手へ貸した');
    assert.equal(pool.lowHeld, 0);
  });

  test('切られた合図で借りようとしても、借りない', async () => {
    const pool = new LanePool([lane()]);
    const ac = new AbortController(); ac.abort();
    assert.equal(await pool.acquire({ priority: Priority.top, signal: ac.signal }), undefined);
    assert.equal(pool.busy, 0);
  });

  test('whenAllIdle は、優先度があっても、出ているぶんが返れば返る', async () => {
    const pool = new LanePool([lane(), lane()]);
    const a = await pool.acquire({ priority: Priority.top });
    const b = await pool.acquire({ priority: Priority.normal });
    const w = tryAcquire(pool, Priority.normal);
    let idled = false;
    void pool.whenAllIdle().then(() => { idled = true; });
    pool.release(a!); pool.release(b!);
    await until(() => idled, 'whenAllIdle が返る', { timeoutMs: 5_000 });
    await until(() => w.got.done, '待ち手が受け取る', { timeoutMs: 5_000 });
    pool.release(w.got.lane!);
  });
});

describe('優先度: ヘッダから読む', () => {
  test('無い・読めない・範囲外は既定（中）。0〜4 はそのまま', () => {
    assert.equal(toPriority(undefined), DEFAULT_PRIORITY);
    assert.equal(toPriority(''), DEFAULT_PRIORITY);
    assert.equal(toPriority('abc'), DEFAULT_PRIORITY);
    assert.equal(toPriority('5'), DEFAULT_PRIORITY);
    assert.equal(toPriority('-1'), DEFAULT_PRIORITY);
    assert.equal(toPriority('1.5'), DEFAULT_PRIORITY);
    assert.equal(toPriority('0'), Priority.top);
    assert.equal(toPriority(' 1 '), Priority.preferred);
    assert.equal(toPriority(['2']), Priority.high);
    assert.equal(toPriority('4'), Priority.low);
    assert.equal(DEFAULT_PRIORITY, Priority.normal);
    assert.equal(PRIORITY_LABEL[Priority.top], '最優先');
    assert.equal(PRIORITY_LABEL[Priority.low], '低');
  });
});

/**
 * 通しで。一本の口を、低が使っている間に低と最優先が並び、**最優先が先に始まる**。
 *
 * 時間で待たない。答えを返す側を門で止めておき、テストが開ける。
 */
const running: InProcRuntime[] = [];
afterEach(async () => { for (const r of running.splice(0)) await r.shutdown(); });

function gatedLib() {
  const state = { started: [] as string[], gates: new Map<string, () => void>() };
  const opened = new Map<string, Promise<void>>();
  const gate = (text: string): Promise<void> => {
    let p = opened.get(text);
    if (!p) {
      p = new Promise<void>((r) => state.gates.set(text, r));
      opened.set(text, p);
    }
    return p;
  };
  const load = async () => ({
    getLlama: async () => ({
      loadModel: async () => ({
        createContext: async () => ({ getSequence: () => ({}), dispose: async () => {} }),
      }),
    }),
    LlamaChatSession: class {
      setChatHistory() {}
      async prompt(text: string, o: { onTextChunk?: (t: string) => void } = {}) {
        state.started.push(text);
        await gate(text);
        o.onTextChunk?.(text);
        return text;
      }
    },
  });
  const open = (text: string) => { void gate(text); state.gates.get(text)!(); };
  return { load, state, open };
}

describe('優先度: 通しで（inproc の入口から）', () => {
  test('**低が使っている間に並んだ最優先が、低より先に始まる**', async () => {
    const dir = await tempDir('aas-prio-');
    const ref = 'a.gguf';
    await writeFile(join(dir, ref), 'x');
    const { load, state, open } = gatedLib();
    const rt = new InProcRuntime({ modelsDir: dir, port: 0, load, sequences: 1, contextSize: 4096 });
    running.push(rt);
    const { baseUrl } = await rt.ensureLoaded(ref);
    // 落ちたときも、門を全部開けて依頼を切ってから抜ける。閉じたまま抜けると、
    // 口が塞がったままになり、後片付けの shutdown が永久に待つ（テストの走りが終わらない）。
    const ac = new AbortController();
    const ask = (text: string, priority?: string) => fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(priority ? { 'x-aas-priority': priority } : {}) },
      body: JSON.stringify({ model: ref, messages: [{ role: 'user', content: text }] }),
      signal: ac.signal,
    });
    try {
      // 一人目（低）が口を取って、門の前で止まる。
      const first = ask('first', '4');
      await until(() => state.started.includes('first'), '一人目が始まる', { timeoutMs: 5_000 });
      // 二人目（低）が並ぶ。ヘッダが返った時点で列に入っている（入口は先にヘッダを返す）。
      const second = ask('second', '4');
      await second.then(() => {}, () => {});
      // 三人目（最優先）が、後から並ぶ。
      const third = ask('third', '0');
      await third.then(() => {}, () => {});
      // 一人目を通す。次に始まるのは三人目（最優先）。
      open('first');
      await until(() => state.started.includes('third'), '最優先が始まる', { timeoutMs: 5_000 });
      assert.equal(state.started.includes('second'), false, '低が最優先より先に始まった');
      open('third');
      await until(() => state.started.includes('second'), 'そのあと低', { timeoutMs: 5_000 });
      open('second');
      const texts = await Promise.all([first, second, third].map((p) => p.then((r) => r.text())));
      for (const t of texts) assert.match(t, /data: \[DONE\]/);
      assert.deepEqual(state.started, ['first', 'third', 'second']);
    } finally {
      for (const open of state.gates.values()) open();
      ac.abort();
    }
  });

  test('ヘッダが無ければ中として通る（断らない）', async () => {
    const dir = await tempDir('aas-prio-');
    const ref = 'a.gguf';
    await writeFile(join(dir, ref), 'x');
    const { load, open } = gatedLib();
    const rt = new InProcRuntime({ modelsDir: dir, port: 0, load, sequences: 2, contextSize: 4096 });
    running.push(rt);
    const { baseUrl } = await rt.ensureLoaded(ref);
    open('plain');
    const raw = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: ref, messages: [{ role: 'user', content: 'plain' }] }),
    }).then((r) => r.text());
    assert.match(raw, /data: \[DONE\]/);
  });
});
