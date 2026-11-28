/**
 * 使うほど計画が当たる（docs/PLACEMENT.md の「使うほど計画が当たる」）。
 *
 * 実際の読み込みの秒数と生成の tok/s を、モデル・置き方・機械ごとに覚え、次の計画の目安を実測で置き換える。
 * 読めなかった置き方（メモリの不足・時間切れ）も覚え、次は最初からその段を避ける。件数に上限を付け、古いものから落とす。
 * 消すのは clean（既定は一覧を見せるだけ）。ここは、計算・覚え・読み込み・画面の API・clean を、偽のライブラリと仮のフォルダで見る。
 * 時刻は渡すか、書かれた値を読む（待って比べない）。走らせる場所で結果が変わらない。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { tempDir } from './tmp.ts';
import { cleanAasEnv } from './env.ts';
import { installRoot } from '../src/core/home.ts';
import { needsStripFlag } from '../src/core/node-flags.ts';
import {
  describePlacement, placementDetail, placementOptions, planPlacement, retryLadder, GIB,
  type PlacementMachine, type PlacementModel,
} from '../src/runtime/placement.ts';
import {
  applyHistory, avoidFailed, failedFor, historyFile, machineKey, measuredFor, readHistory, trimHistory, PlacementHistory,
  FAILURE_KEEP_DAYS, MAX_HISTORY_ENTRIES, MIN_SPEED_TOKENS, type HistoryEntry,
} from '../src/runtime/placement-history.ts';

const STATE = await tempDir('aas-history-state-');
process.env.AAS_STATE_DIR = STATE;
const { InProcRuntime } = await import('../src/runtime/inproc.ts');
const { UiServer } = await import('../src/ui/server.ts');
const { findRemovable } = await import('../src/runtime/cleanup.ts');

const MB = 1024 ** 2;
const run = promisify(execFile);
const root = installRoot();

const M9: PlacementModel = { ref: 'Qwen3.5-9B-Q4_K_M.gguf', fileBytes: 5_680_522_464, layers: 32, kvBytesPerToken: 131_072, trainedContext: 262_144, downloaded: true };
const cpu16: PlacementMachine = { ramBytes: 16 * GIB, gpus: [], cores: 8, swapBytes: 0 };
const gpu8: PlacementMachine = { ramBytes: 32 * GIB, gpus: [{ vramBytes: 8 * GIB }], cores: 8, swapGrows: true, systemDiskFreeBytes: 100 * GIB };
const M27: PlacementModel = { ref: 'Qwen3.6-27B-Q4_K_M.gguf', fileBytes: 16_817_244_384, layers: 64, kvBytesPerToken: 262_144, trainedContext: 262_144, downloaded: true };

const entry = (more: Partial<HistoryEntry>): HistoryEntry => ({
  ref: M9.ref, fileBytes: M9.fileBytes, machine: machineKey(cpu16), gpuLayers: 0, ssd: false, contextSize: 8192, sequences: 1,
  samples: 0, at: '2026-11-01T00:00:00.000Z', ...more,
});

describe('計画の目安を、実測で置き換える', () => {
  test('実測が在れば「実測」、無ければ「目安」と言う。具合と待つ長さも、実測の速さで決め直す', () => {
    const plan = planPlacement(M9, cpu16);
    assert.equal(plan.fit, 'slow');
    assert.match(describePlacement(plan), /。目安 4\.8 tok\/s。遅いですが、動きます$/);
    assert.ok(placementDetail(plan, M9).includes('速さの目安: 4.8 tok/s'));

    const measured = applyHistory(plan, M9, cpu16, [entry({ tokensPerSecond: 9.37, samples: 3, loadSeconds: 41.2 })]);
    assert.equal(measured.estimatedTps, 9.4);
    assert.equal(measured.fit, 'comfortable', '実測が 8 tok/s 以上なのに、遅いと言っている');
    assert.match(describePlacement(measured), /。実測 9\.4 tok\/s$/);
    assert.ok(placementDetail(measured, M9).includes('速さの実測: 9.4 tok/s（3 回の平均・読み込み 41.2 秒）'), placementDetail(measured, M9).join(' / '));
    assert.ok(measured.timeouts.stallMs <= plan.timeouts.stallMs);

    // 遅い実測は、待つ長さを延ばす（動いているものを、停滞で止めない）
    const crawl = applyHistory(plan, M9, cpu16, [entry({ tokensPerSecond: 0.1, samples: 1 })]);
    assert.equal(crawl.timeouts.stallMs, 300_000);
    assert.ok(crawl.timeouts.stallMs > plan.timeouts.stallMs);
  });

  test('別のモデル・別の機械（RAM の違い）・別の置き方（SSD から読む）の実測は使わない（対）', () => {
    const plan = planPlacement(M9, cpu16);
    for (const other of [
      entry({ ref: 'other.gguf', tokensPerSecond: 9, samples: 1 }),
      entry({ fileBytes: 1, tokensPerSecond: 9, samples: 1 }),
      entry({ machine: machineKey({ ...cpu16, ramBytes: 32 * GIB }), tokensPerSecond: 9, samples: 1 }),
      entry({ ssd: true, tokensPerSecond: 9, samples: 1 }),
      entry({ loadSeconds: 12, samples: 0 }),
    ]) {
      const got = applyHistory(plan, M9, cpu16, [other]);
      assert.equal(got.measured, undefined, JSON.stringify(other));
      assert.equal(got.estimatedTps, plan.estimatedTps);
    }
  });

  test('コンテキストウィンドウだけが違う実測は使う。GPU の層は、数層のずれまで使い、大きく違えば使わない', () => {
    const plan = planPlacement(M9, cpu16);
    assert.equal(applyHistory(plan, M9, cpu16, [entry({ contextSize: 32_768, tokensPerSecond: 3.3, samples: 2 })]).estimatedTps, 3.3);

    const part = planPlacement(M27, gpu8);
    assert.ok(part.gpuLayers > 0 && part.gpuLayers < 64, String(part.gpuLayers));
    const at = (gpuLayers: number): HistoryEntry => entry({ ref: M27.ref, fileBytes: M27.fileBytes, machine: machineKey(gpu8), gpuLayers, tokensPerSecond: 5.5, samples: 1 });
    assert.equal(measuredFor([at(part.gpuLayers + 3)], M27, gpu8, part)?.tokensPerSecond, 5.5);
    assert.equal(measuredFor([at(part.gpuLayers + 30)], M27, gpu8, part), undefined);
    assert.equal(measuredFor([at(0)], M27, gpu8, part), undefined, 'GPU を使わない実測を、GPU に載せる計画に当てている');
  });

  test('選べる置き方の一行にも、実測か目安かが出る', () => {
    const past = [entry({ tokensPerSecond: 6.1, samples: 4 })];
    const options = placementOptions(M9, cpu16, {}, (p, of) => applyHistory(p, of, cpu16, past));
    assert.match(options[0]!.line, /^実測 6\.1 tok\/s・/);
    assert.match(placementOptions(M9, cpu16)[0]!.line, /^目安 4\.8 tok\/s・/);
  });
});

describe('読めなかった置き方を、次は最初から避ける', () => {
  const machine: PlacementMachine = { ramBytes: 32 * GIB, gpus: [{ vramBytes: 8 * GIB }], cores: 8, swapBytes: 0 };
  const steps = retryLadder(M9, machine, { context: 32_768, sequences: 2 });
  const failedAt = (i: number, why: 'memory' | 'timeout', at = '2026-11-20T00:00:00.000Z'): HistoryEntry => {
    const p = steps[i]!.plan;
    return entry({ machine: machineKey(machine), gpuLayers: p.gpuLayers, ssd: p.ssdBytes > 0, contextSize: p.contextSize, sequences: p.sequences, failed: why, failedAt: at });
  };
  const now = Date.parse('2026-11-28T00:00:00.000Z');

  test('計画どおりの段が前に落ちていれば、その段を飛ばして次の段から読む。落ちていない段は残す', () => {
    assert.ok(steps.length >= 3, `段が足りない: ${steps.map((s) => s.id).join(',')}`);
    const got = avoidFailed(steps, M9, machine, [failedAt(0, 'memory')], now);
    assert.deepEqual(got.steps.map((s) => s.id), steps.slice(1).map((s) => s.id));
    assert.deepEqual(got.skipped.map((s) => [s.step.id, s.why]), [['as-planned', 'memory']]);
    const timed = avoidFailed(steps, M9, machine, [failedAt(1, 'timeout')], now);
    assert.deepEqual(timed.skipped.map((s) => [s.step.id, s.why]), [[steps[1]!.id, 'timeout']]);
    assert.equal(timed.steps[0]!.id, 'as-planned');
  });

  test('覚えが無ければ、全部の段を上から試す（対）。全部の段が落ちた覚えなら、避けずに上から試す', () => {
    assert.deepEqual(avoidFailed(steps, M9, machine, [], now), { steps: [...steps], skipped: [] });
    const all = avoidFailed(steps, M9, machine, steps.map((_, i) => failedAt(i, 'memory')), now);
    assert.equal(all.steps.length, steps.length);
    assert.deepEqual(all.skipped, []);
  });

  test(`${FAILURE_KEEP_DAYS} 日より前の覚えは使わない（ほかのアプリがメモリを使っていただけ、を引きずらない）`, () => {
    const old = failedAt(0, 'memory', '2026-10-01T00:00:00.000Z');
    assert.equal(failedFor([old], M9, machine, steps[0]!.plan, now), undefined);
    assert.equal(failedFor([failedAt(0, 'memory')], M9, machine, steps[0]!.plan, now), 'memory');
    assert.equal(avoidFailed(steps, M9, machine, [old], now).skipped.length, 0);
  });

  test('読めなかった置き方には、計画の一行と細かい計画で、そう添える', () => {
    const plan = applyHistory(steps[0]!.plan, M9, machine, [failedAt(0, 'timeout', new Date().toISOString())]);
    assert.equal(plan.failedBefore, 'timeout');
    assert.ok(placementDetail(plan, M9).some((l) => l.startsWith('前の読み込み: 時間切れになりました')), placementDetail(plan, M9).join(' / '));
  });
});

describe('覚えを書く・古いものから落とす', () => {
  test('読めた秒数と速さを覚える。速さは平均し、短すぎる生成は入れない。読めたら、読めなかった覚えは消える', async () => {
    const dir = await tempDir('aas-history-store-');
    const store = new PlacementHistory(dir);
    const plan = planPlacement(M9, cpu16);
    await store.recordFailure(M9, cpu16, plan, 'memory');
    assert.equal((await readHistory(dir))[0]!.failed, 'memory');
    await store.recordLoad(M9, cpu16, plan, 12.34);
    assert.equal(store.recordSpeed(M9, cpu16, plan, MIN_SPEED_TOKENS - 1, 1), undefined, '数トークンの生成を、速さに入れている');
    await store.recordSpeed(M9, cpu16, plan, 40, 10);
    await store.recordSpeed(M9, cpu16, plan, 60, 10);
    const got = await readHistory(dir);
    assert.equal(got.length, 1, '同じ置き方が、二件になっている');
    assert.equal(got[0]!.loadSeconds, 12.3);
    assert.equal(got[0]!.tokensPerSecond, 5);
    assert.equal(got[0]!.samples, 2);
    assert.equal(got[0]!.failed, undefined);
    assert.equal(got[0]!.machine, 'vram0.0-ram16.0');
  });

  test('並べて書いても、取りこぼさない（同じプロセスの中の書き込みは順に行う）', async () => {
    const dir = await tempDir('aas-history-queue-');
    const store = new PlacementHistory(dir);
    const plan = planPlacement(M9, cpu16);
    await Promise.all(Array.from({ length: 10 }, () => store.recordSpeed(M9, cpu16, plan, 20, 2)));
    assert.equal((await readHistory(dir))[0]!.samples, 10);
  });

  test(`上限（${MAX_HISTORY_ENTRIES} 件）を超えたら、古いものから落とす`, async () => {
    const many = Array.from({ length: 5 }, (_, i) => entry({ ref: `m${i}.gguf`, at: `2026-11-0${i + 1}T00:00:00.000Z` }));
    assert.deepEqual(trimHistory(many, 3).map((e) => e.ref).sort(), ['m2.gguf', 'm3.gguf', 'm4.gguf']);
    assert.equal(trimHistory(many, 5).length, 5);
    // ファイルでも: 上限いっぱいの覚えに 1 件足すと、いちばん古い 1 件が落ちる
    const dir = await tempDir('aas-history-trim-');
    const full = Array.from({ length: MAX_HISTORY_ENTRIES }, (_, i) => entry({ ref: `m${i}.gguf`, at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() }));
    await writeFile(historyFile(dir), JSON.stringify({ version: 1, entries: full }));
    await new PlacementHistory(dir).recordLoad(M9, cpu16, planPlacement(M9, cpu16), 1);
    const after = await readHistory(dir);
    assert.equal(after.length, MAX_HISTORY_ENTRIES);
    assert.ok(!after.some((e) => e.ref === 'm0.gguf'), 'いちばん古いものが残っている');
    assert.ok(after.some((e) => e.ref === 'm1.gguf') && after.some((e) => e.ref === M9.ref));
  });

  test('壊れたファイルは、何も覚えていないものとして読み、次の書き込みで作り直す', async () => {
    const dir = await tempDir('aas-history-broken-');
    await writeFile(historyFile(dir), '{ こわれた');
    assert.deepEqual(await readHistory(dir), []);
    await writeFile(historyFile(dir), JSON.stringify({ entries: [{ ref: 'x' }, entry({})] }));
    assert.equal((await readHistory(dir)).length, 1, '形の違う件を、そのまま読んでいる');
    await new PlacementHistory(dir).recordLoad(M9, cpu16, planPlacement(M9, cpu16), 2);
    assert.equal((await readHistory(dir)).length, 1);
  });
});

/** 中身の無い（疎な）.gguf。大きさだけが本物。 */
async function sparse(dir: string, name: string, bytes: number): Promise<void> {
  const fh = await open(join(dir, name), 'w');
  try { await fh.write('GGUF'); await fh.truncate(bytes); } finally { await fh.close(); }
}

interface Seen { contexts: Record<string, unknown>[]; loads: number }

/** `failContext` が文を返した回は、context を作る所でその文で落ちる。`slowLoadMs` なら、読み込みがその長さかかる。 */
function fakeLib(seen: Seen, opts: { failContext?: (c: Record<string, unknown>) => string | undefined; slowLoadMs?: number; tokens?: number } = {}) {
  return async () => ({
    getLlama: async () => ({
      loadModel: async (o: { onLoadProgress?: (d: number) => void }) => {
        seen.loads += 1;
        if (opts.slowLoadMs) await new Promise((r) => setTimeout(r, opts.slowLoadMs));
        o.onLoadProgress?.(1);
        return {
          dispose: async () => {},
          createContext: async (c: Record<string, unknown>) => {
            seen.contexts.push(c);
            const no = opts.failContext?.(c);
            if (no) throw new Error(no);
            return { getSequence: () => ({}), dispose: async () => {} };
          },
        };
      },
    }),
    LlamaChatSession: class {
      setChatHistory() {}
      async prompt(_t: string, o: { onTextChunk?: (t: string) => void; onResponseChunk?: (c: { text: string; tokens?: unknown[] }) => void } = {}) {
        for (let i = 0; i < (opts.tokens ?? 0); i += 1) {
          o.onResponseChunk?.({ text: 'は', tokens: [i] });
          o.onTextChunk?.('は');
          // 生成の時間が 0 にならないよう、少しずつ出す
          if (i === 0) await new Promise((r) => setTimeout(r, 30));
        }
        return 'は'.repeat(opts.tokens ?? 0);
      }
    },
  });
}

describe('読み込みが、覚えを書き、次の読み込みが使う', () => {
  test('1 回目は計画どおりの段がメモリの不足で落ちて段を下げる。2 回目は、その段を最初から避けて読む', async () => {
    const dir = await tempDir('aas-history-load-');
    const state = await tempDir('aas-history-load-state-');
    await sparse(dir, 'big.gguf', 3 * MB);
    // コンテキストウィンドウが 8192 の段だけが落ちる機械
    const failBig = (c: Record<string, unknown>) => (c.contextSize === 8192 ? 'Failed to create context: out of memory' : undefined);

    const first: Seen = { contexts: [], loads: 0 };
    const said1: string[] = [];
    const a = new InProcRuntime({ modelsDir: dir, stateDir: state, port: 0, load: fakeLib(first, { failContext: failBig }), onLog: (l) => said1.push(l) });
    try { await a.ensureLoaded('big.gguf'); } finally { await a.shutdown(); }
    assert.deepEqual(first.contexts.map((c) => c.contextSize), [8192, 4096]);
    assert.ok(said1.some((l) => l.includes('やり直し 1/1: コンテキストウィンドウを 4096 に狭めて、読み直します')), said1.join(' / '));
    const kept = await readHistory(state);
    assert.deepEqual(kept.map((e) => [e.contextSize, e.failed ?? 'ok', typeof e.loadSeconds]).sort(), [[4096, 'ok', 'number'], [8192, 'memory', 'undefined']]);

    const second: Seen = { contexts: [], loads: 0 };
    const said2: string[] = [];
    const b = new InProcRuntime({ modelsDir: dir, stateDir: state, port: 0, load: fakeLib(second, { failContext: failBig }), onLog: (l) => said2.push(l) });
    try { await b.ensureLoaded('big.gguf'); } finally { await b.shutdown(); }
    assert.deepEqual(second.contexts.map((c) => c.contextSize), [4096], '前に落ちた段を、もう一度試している');
    assert.ok(said2.some((l) => l === 'big.gguf: 前にメモリが足りずに落ちた置き方（コンテキストウィンドウ 8192 × 1 本・GPU 0 層）を避けて、次の段から読みます'), said2.join(' / '));
    assert.ok(!said2.some((l) => l.includes('読み込めませんでした')), said2.join(' / '));
  });

  test('覚えを消すと、もう一度計画どおりの段から試す（戻せる）', async () => {
    const dir = await tempDir('aas-history-forget-');
    const state = await tempDir('aas-history-forget-state-');
    await sparse(dir, 'big.gguf', 3 * MB);
    const plan = { gpuLayers: 0, ssdBytes: 0, contextSize: 8192, sequences: 1 };
    const { size } = await (await open(join(dir, 'big.gguf'))).stat();
    const machine = { ramBytes: (await import('node:os')).totalmem(), gpus: [] };
    await new PlacementHistory(state).recordFailure({ ref: 'big.gguf', fileBytes: size }, machine, plan, 'timeout');
    const loadOnce = async (): Promise<unknown[]> => {
      const seen: Seen = { contexts: [], loads: 0 };
      const rt = new InProcRuntime({ modelsDir: dir, stateDir: state, port: 0, load: fakeLib(seen) });
      try { await rt.ensureLoaded('big.gguf'); } finally { await rt.shutdown(); }
      return seen.contexts.map((c) => c.contextSize);
    };
    assert.deepEqual(await loadOnce(), [4096], '時間切れになった段を避けていない');
    const { rm } = await import('node:fs/promises');
    await rm(historyFile(state));
    assert.deepEqual(await loadOnce(), [8192]);
  });

  test('読み込みの時間切れも覚える（試験の口で上限を 5 ミリ秒に。読み込みは 60 ミリ秒かかる）', async () => {
    const dir = await tempDir('aas-history-timeout-');
    const state = await tempDir('aas-history-timeout-state-');
    await sparse(dir, 'big.gguf', 3 * MB);
    const before = process.env.AAS_TEST_LOAD_TIMEOUT_MS;
    process.env.AAS_TEST_LOAD_TIMEOUT_MS = '5';
    try {
      const rt = new InProcRuntime({ modelsDir: dir, stateDir: state, port: 0, load: fakeLib({ contexts: [], loads: 0 }, { slowLoadMs: 60 }) });
      try { await assert.rejects(rt.ensureLoaded('big.gguf'), /読み込みが 0\.005 秒で終わりませんでした/); } finally { await rt.shutdown(); }
    } finally { if (before === undefined) delete process.env.AAS_TEST_LOAD_TIMEOUT_MS; else process.env.AAS_TEST_LOAD_TIMEOUT_MS = before; }
    assert.deepEqual((await readHistory(state)).map((e) => [e.contextSize, e.failed]), [[8192, 'timeout']]);
  });

  test('答えるたびに、生成の速さを覚える。置く所を渡さない試験の中では、覚えない（対）', async () => {
    const dir = await tempDir('aas-history-speed-');
    const state = await tempDir('aas-history-speed-state-');
    await sparse(dir, 'big.gguf', 3 * MB);
    const askOnce = async (stateDir: string | undefined): Promise<void> => {
      const rt = new InProcRuntime({ modelsDir: dir, ...(stateDir ? { stateDir } : {}), port: 0, load: fakeLib({ contexts: [], loads: 0 }, { tokens: 12 }) });
      try {
        const got = await rt.ensureLoaded('big.gguf');
        const res = await fetch(`${got.baseUrl}/chat/completions`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'big.gguf', stream: true, messages: [{ role: 'user', content: 'x' }] }),
        });
        await res.text();
      } finally { await rt.shutdown(); }
    };
    await askOnce(state);
    const got = await readHistory(state);
    assert.equal(got.length, 1);
    assert.equal(got[0]!.samples, 1);
    assert.ok((got[0]!.tokensPerSecond ?? 0) > 0, JSON.stringify(got[0]));
    assert.equal(typeof got[0]!.loadSeconds, 'number');
    // 置く所を渡さない: 既定の場所（AAS_STATE_DIR）に何も書かない
    await askOnce(undefined);
    assert.equal(existsSync(historyFile(STATE)), false, '試験の中で、既定の場所に覚えを書いている');
  });
});

async function withEnv<T>(set: Record<string, string>, body: () => Promise<T>): Promise<T> {
  const before: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(set)) { before[k] = process.env[k]; process.env[k] = v; }
  try { return await body(); } finally {
    for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

describe('画面の API と clean', () => {
  // メモリ 1MB・ページング 64GB の機械に見せた 3MB のモデル（SSD から読む・4096・GPU なし）
  const HOOKS = { AAS_TEST_RAM_BYTES: String(1 * MB), AAS_TEST_PAGING_BYTES: String(64 * GIB), AAS_TEST_DISK_BYTES: String(18 * GIB) };
  const mine = (more: Partial<HistoryEntry>): HistoryEntry => ({
    ref: 'big.gguf', fileBytes: 3 * MB, machine: 'vram0.0-ram0.0', gpuLayers: 0, ssd: true, contextSize: 4096, sequences: 1,
    samples: 0, at: new Date().toISOString(), ...more,
  });
  interface Row { ref: string; plan?: string; detail?: string[]; fitLabel?: string; options?: Array<{ id: string; line: string }> }
  async function rowWith(entries: HistoryEntry[] | undefined): Promise<Row> {
    const models = await tempDir('aas-history-ui-');
    await sparse(models, 'big.gguf', 3 * MB);
    const { rm } = await import('node:fs/promises');
    await rm(historyFile(STATE), { force: true });
    if (entries) await writeFile(historyFile(STATE), JSON.stringify({ version: 1, entries }));
    try {
      return await withEnv(HOOKS, async () => {
        const server = new UiServer({
          config: {
            providers: [], candidates: [], runtime: { kind: 'inproc', modelsDir: models },
            agent: { root: await tempDir('aas-history-root-'), approval: 'auto', verify: { enabled: false } }, initiative: { enabled: false },
          } as never,
          port: 0, inprocLoad: fakeLib({ contexts: [], loads: 0 }) as never,
        });
        try {
          const base = (await server.start()).replace(/\/$/, '');
          return ((await (await fetch(`${base}/api/models`)).json()) as { installed: Row[] }).installed.find((m) => m.ref === 'big.gguf')!;
        } finally { await server.stop(); }
      });
    } finally { await rm(historyFile(STATE), { force: true }); }
  }

  test('/api/models: 実測が在れば、一行と「計画を見る」と置き方の一行が「実測」になる。無ければ「目安」（対）', async () => {
    const before = await rowWith(undefined);
    assert.match(before.plan ?? '', /SSD から読みます。目安 [\d.]+ tok\/s。とても遅いですが、動きます$/);
    assert.ok(before.detail?.some((l) => l.startsWith('速さの目安: ')));

    const after = await rowWith([mine({ tokensPerSecond: 3.21, samples: 5, loadSeconds: 7.5 })]);
    assert.match(after.plan ?? '', /SSD から読みます。実測 3\.2 tok\/s。とても遅いですが、動きます$/);
    assert.ok(after.detail?.includes('速さの実測: 3.2 tok/s（5 回の平均・読み込み 7.5 秒）'), after.detail?.join(' / '));
    assert.equal(after.fitLabel, 'SSD から読む（とても遅い）', 'SSD から読む計画を、速さだけで快適と言っている');
    assert.match(after.options?.find((o) => o.id === 'auto')?.line ?? '', /^実測 3\.2 tok\/s・/);
  });

  test('/api/models: 前に読めなかった置き方には、そう添える', async () => {
    const got = await rowWith([mine({ failed: 'memory', failedAt: new Date().toISOString() })]);
    assert.ok(got.detail?.some((l) => l.startsWith('前の読み込み: メモリが足りずに落ちました。次は、この段を避けて下の段から読みます')), got.detail?.join(' / '));
    assert.match(got.options?.find((o) => o.id === 'auto')?.line ?? '', /前にメモリが足りずに落ちた置き方なので、次は段を下げて読みます$/);
  });

  test('clean: 既定は一覧に出すだけで消さない。--yes で消す', async () => {
    const dir = await tempDir('aas-history-clean-');
    const home = join(dir, 'home');
    await mkdir(home, { recursive: true });
    await writeFile(historyFile(home), JSON.stringify({ version: 1, entries: [mine({}), mine({ ref: 'other.gguf' })] }));
    const config = join(dir, 'aas.config.json');
    await writeFile(config, JSON.stringify({ runtime: { kind: 'inproc', modelsDir: join(dir, 'models') } }));
    const flags = needsStripFlag(process.versions.node) ? ['--experimental-strip-types'] : [];
    const clean = async (...args: string[]): Promise<string> => {
      const out = await run(process.execPath, [...flags, '--no-warnings', join(root, 'src', 'cli', 'clean.ts'), ...args], {
        env: cleanAasEnv({ AAS_HOME: home, AAS_CONFIG: config, NO_COLOR: '1' }), timeout: 120_000,
      }).catch((e: { stdout?: string; stderr?: string }) => e);
      return `${out.stdout ?? ''}${out.stderr ?? ''}`;
    };
    const listed = await clean();
    assert.match(listed, /placement-history\.json/);
    assert.match(listed, /置き方の実測の記録 2 件（消すと、計画の速さは目安に戻り、読めなかった置き方ももう一度試します）/);
    assert.match(listed, /消すときは --yes を付けてください/);
    assert.equal(existsSync(historyFile(home)), true, '--yes を付けていないのに、消している');
    assert.equal(JSON.parse(await readFile(historyFile(home), 'utf8')).entries.length, 2);
    await clean('--yes');
    assert.equal(existsSync(historyFile(home)), false);
    // 選んだ置き方（設定）は、片づけの対象にしない
    const items = await findRemovable({ keepTag: 'b0', runningTags: async () => new Set() });
    assert.ok(!items.some((i) => i.path.includes('placement-choices')), items.map((i) => i.path).join(', '));
  });
});
