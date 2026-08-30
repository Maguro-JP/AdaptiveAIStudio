/**
 * 常時ロードの検証。
 * 2回目以降のロード待ちが消えること、VRAMが溢れないこと、
 * 使用中のモデルを降ろさないことを確認する。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { WarmPool, type WarmEvent } from '../src/runtime/warm-pool.ts';
import type { AvailableModel, LoadedModel, LocalRuntime } from '../src/runtime/local-runtime.ts';
import type { Plan } from '../src/runtime/planner.ts';
import { GB } from '../src/runtime/spec.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** ロードに時間がかかるランタイムの模擬。 */
class FakeRuntime implements LocalRuntime {
  readonly id = 'fake';
  loadCalls: string[] = [];
  unloadCalls: string[] = [];
  #loaded = new Set<string>();

  readonly #loadMs: number;
  constructor(loadMs = 40) { this.#loadMs = loadMs; }

  async list(): Promise<AvailableModel[]> { return []; }
  loaded(): string[] { return [...this.#loaded]; }

  async ensureLoaded(ref: string): Promise<LoadedModel> {
    this.loadCalls.push(ref);
    await sleep(this.#loadMs);
    this.#loaded.add(ref);
    return { baseUrl: `http://127.0.0.1/${ref}/v1`, model: ref, loadSeconds: this.#loadMs / 1000 };
  }

  async unload(ref: string): Promise<void> {
    this.unloadCalls.push(ref);
    this.#loaded.delete(ref);
  }

  async shutdown(): Promise<void> { this.#loaded.clear(); }
}

const plan = (vramGb: number): Plan => ({
  modelId: 'x', placement: 'partialOffload', quant: 'Q4_K_M',
  gpuLayers: 10, totalLayers: 40, contextLength: 8192, kvCacheType: 'f16',
  useMmap: true, estimatedTps: 10, vramUsedBytes: vramGb * GB, ramUsedBytes: 0,
  degradations: [], summary: 'test',
});

function pool(runtime: FakeRuntime, opts: {
  vram?: number; maxResident?: number; sizes?: Record<string, number>;
} = {}) {
  const events: WarmEvent[] = [];
  const p = new WarmPool({
    runtime,
    vramBudgetBytes: (opts.vram ?? 8) * GB,
    maxResident: opts.maxResident,
    planOf: (ref) => plan(opts.sizes?.[ref] ?? 3),
    onEvent: (e) => events.push(e),
  });
  return { p, events };
}

describe('常時ロード', () => {
  test('2回目の取得はロードせず即座に返る', async () => {
    const rt = new FakeRuntime(60);
    const { p, events } = pool(rt);

    const t1 = Date.now();
    await p.acquire('a');
    const first = Date.now() - t1;
    p.release('a');

    const t2 = Date.now();
    await p.acquire('a');
    const second = Date.now() - t2;

    assert.equal(rt.loadCalls.length, 1, 'ロードが2回走っている');
    assert.ok(first >= 50, `1回目が待っていない: ${first}ms`);
    assert.ok(second < 20, `2回目に待ちが発生している: ${second}ms`);
    assert.ok(events.some((e) => e.type === 'hit'));
  });

  test('preload で起動時に温めておける', async () => {
    const rt = new FakeRuntime(30);
    const { p } = pool(rt, { vram: 16 });
    await p.preload(['a', 'b']);

    assert.deepEqual(p.resident.sort(), ['a', 'b']);
    const t = Date.now();
    await p.acquire('b');
    assert.ok(Date.now() - t < 20, '温めたのに待ちが発生している');
  });

  test('preload は一部が失敗しても続行する', async () => {
    const rt = new FakeRuntime(10);
    rt.ensureLoaded = async (ref: string) => {
      if (ref === 'broken') throw new Error('load failed');
      return { baseUrl: 'http://x', model: ref };
    };
    const { p, events } = pool(rt);
    await p.preload(['broken', 'ok']);

    assert.ok(events.some((e) => e.type === 'failed' && e.ref === 'broken'));
    assert.deepEqual(p.resident, ['ok']);
  });

  test('VRAMが足りなければ、使っていないものを降ろす', async () => {
    const rt = new FakeRuntime(10);
    const { p, events } = pool(rt, { vram: 8, sizes: { a: 5, b: 5 } });

    await p.acquire('a'); p.release('a');
    await p.acquire('b'); // 5+5=10GB > 8GB なので a が降りる

    assert.deepEqual(rt.unloadCalls, ['a']);
    assert.deepEqual(p.resident, ['b']);
    assert.ok(events.some((e) => e.type === 'evict' && e.ref === 'a'));
  });

  test('使用中のモデルは降ろさない', async () => {
    const rt = new FakeRuntime(10);
    const { p } = pool(rt, { vram: 8, sizes: { a: 5, b: 5 } });

    await p.acquire('a'); // release しない = 使用中
    await p.acquire('b');

    assert.deepEqual(rt.unloadCalls, [], '使用中のモデルを降ろしてしまった');
    assert.equal(p.resident.length, 2);
  });

  test('降ろすのは最も長く使われていないもの', async () => {
    const rt = new FakeRuntime(5);
    const { p } = pool(rt, { vram: 10, sizes: { a: 4, b: 4, c: 4 } });

    await p.acquire('a'); p.release('a');
    await sleep(15);
    await p.acquire('b'); p.release('b');
    await sleep(15);
    await p.acquire('a'); p.release('a'); // a を使い直す → b が最古になる

    await p.acquire('c');
    assert.deepEqual(rt.unloadCalls, ['b']);
  });

  test('常駐数の上限でも降ろす', async () => {
    const rt = new FakeRuntime(5);
    const { p } = pool(rt, { vram: 100, maxResident: 2, sizes: { a: 1, b: 1, c: 1 } });

    await p.acquire('a'); p.release('a');
    await p.acquire('b'); p.release('b');
    await p.acquire('c');

    assert.equal(p.resident.length, 2);
    assert.deepEqual(rt.unloadCalls, ['a']);
  });

  test('同じモデルへの同時要求で二重にロードしない', async () => {
    const rt = new FakeRuntime(50);
    const { p } = pool(rt);
    const [x, y] = await Promise.all([p.acquire('a'), p.acquire('a')]);
    assert.equal(rt.loadCalls.length, 1, '二重にロードしている');
    assert.equal(x.baseUrl, y.baseUrl);
  });

  test('全部使用中なら降ろさずに載せる（作業を止めない）', async () => {
    const rt = new FakeRuntime(5);
    const { p } = pool(rt, { vram: 4, sizes: { a: 4, b: 4 } });
    await p.acquire('a'); // 使用中のまま
    await p.acquire('b'); // VRAMは足りないが、降ろせる相手がいない
    assert.equal(p.resident.length, 2);
    assert.deepEqual(rt.unloadCalls, []);
  });

  test('状態を一覧できる', async () => {
    const rt = new FakeRuntime(5);
    const { p } = pool(rt, { vram: 16 });
    await p.acquire('a');
    await p.acquire('b'); p.release('b');

    const status = p.status();
    assert.equal(status.find((s) => s.ref === 'a')?.inUse, true);
    assert.equal(status.find((s) => s.ref === 'b')?.inUse, false);
  });

  test('shutdown で全て降ろす', async () => {
    const rt = new FakeRuntime(5);
    const { p } = pool(rt, { vram: 16 });
    await p.acquire('a'); p.release('a');
    await p.acquire('b'); p.release('b');
    await p.shutdown();
    assert.deepEqual(p.resident, []);
    assert.deepEqual(rt.unloadCalls.sort(), ['a', 'b']);
  });
});
