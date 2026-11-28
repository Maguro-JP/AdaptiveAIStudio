/**
 * 大きいモデルの結合の試験（docs/PLACEMENT.md）。
 *
 * 部品ごとの試験（placement.test.ts・large-load.test.ts）は、計算と読み方を別々に見ている。ここは繋ぎを見る:
 *   ・計画が、実際の読み込みの引数に効く（VRAM を小さく見せると、渡す値が変わる）
 *   ・落ちたら GPU の層を減らして読み直す（段ごとに、渡した値を見る）
 *   ・読み込みの時間切れが、合図を見ないライブラリでも効き、口（/control/load）の最後の一行に理由が来る
 *   ・計画の待つ長さが、送り側（openai-compatible.ts）の待ちを延ばす
 *   ・計画と「なぜ動かないか・どうすれば動くか」が、画面の API（/api/models）・モデルのパネル・doctor に出る
 * 本物の形の GGUF は scripts/tiny-gguf.mjs（種を固定）で組む。機械は試験の口（AAS_TEST_*）で小さく見せる。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, open, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tempDir } from './tmp.ts';
import { cleanAasEnv } from './env.ts';
import { installDom, createNode, type StubNode } from './dom-stub.ts';
import { installRoot } from '../src/core/home.ts';
import { needsStripFlag } from '../src/core/node-flags.ts';

// 記録の保存先を、試験専用の場所へ移してから読み込む（test/no-model.test.ts と同じ）
process.env.AAS_STATE_DIR = await tempDir('aas-large-int-state-');
const { InProcRuntime } = await import('../src/runtime/inproc.ts');
const { OpenAiCompatibleProvider } = await import('../src/providers/openai-compatible.ts');
const { Priority } = await import('../src/providers/contract.ts');
const { UiServer } = await import('../src/ui/server.ts');
const { detectPlacementMachine, placementModelOf } = await import('../src/runtime/placement-machine.ts');

const MB = 1024 ** 2;
const GB = 1024 ** 3;
const run = promisify(execFile);
const root = installRoot();

interface Seen {
  loads: Record<string, unknown>[]; contexts: Record<string, unknown>[]; disposed: number;
  signals: AbortSignal[]; release: Array<() => void>;
}
const seenNothing = (): Seen => ({ loads: [], contexts: [], disposed: 0, signals: [], release: [] });

/** 渡された値を覚える偽のライブラリ。`hang` なら、読み込みは `release` を呼ぶまで返らない（合図も見ない）。 */
function fakeLib(seen: Seen, opts: {
  gpu?: boolean; hang?: boolean;
  /** 読み込みの進み具合として言う値。既定は 1 だけ。 */
  progress?: number[];
  failContext?: (o: Record<string, unknown>, n: number) => string | undefined;
} = {}) {
  return async () => ({
    getLlama: async () => ({
      ...(opts.gpu ? {
        gpu: 'cuda' as const,
        getGpuDeviceNames: async () => ['NVIDIA GeForce RTX 4060'],
        getVramState: async () => ({ total: 8 * GB, used: 0, free: 8 * GB }),
      } : {}),
      loadModel: async (o: Record<string, unknown> & { onLoadProgress?: (d: number) => void; loadSignal?: AbortSignal }) => {
        const { onLoadProgress, loadSignal, ...rest } = o;
        seen.loads.push(rest);
        if (loadSignal) seen.signals.push(loadSignal);
        if (opts.hang) await new Promise<void>((r) => seen.release.push(r));
        for (const d of opts.progress ?? [1]) onLoadProgress?.(d);
        return {
          ...(opts.gpu ? { gpuLayers: 20, fileInsights: { totalLayers: 32 } } : {}),
          dispose: async () => { seen.disposed += 1; },
          createContext: async (c: Record<string, unknown>) => {
            seen.contexts.push(c);
            const no = opts.failContext?.(c, seen.contexts.length);
            if (no) throw new Error(no);
            return { getSequence: () => ({}), dispose: async () => {} };
          },
        };
      },
    }),
    LlamaChatSession: class { setChatHistory() {} async prompt() { return ''; } },
  });
}

/** 試験の口（環境変数）を立てて、終わったら戻す。 */
async function withEnv<T>(set: Record<string, string>, body: () => Promise<T>): Promise<T> {
  const before: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(set)) { before[k] = process.env[k]; process.env[k] = v; }
  try { return await body(); } finally {
    for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

/** 中身の無い（疎な）.gguf。大きさだけが本物。 */
async function sparse(dir: string, name: string, bytes: number): Promise<void> {
  const fh = await open(join(dir, name), 'w');
  try { await fh.write('GGUF'); await fh.truncate(bytes); } finally { await fh.close(); }
}

/** 本物の形の小さな GGUF（種を固定。走らせるたびに同じ中身）。 */
async function tinyGguf(dir: string, name: string): Promise<string> {
  const at = join(dir, name);
  await run(process.execPath, [join(root, 'scripts', 'tiny-gguf.mjs'), at, '--seed', '7']);
  return at;
}

async function loadOverHttp(rt: InstanceType<typeof InProcRuntime>, ref: string) {
  const base = (await rt.serve()).replace(/\/v1$/, '');
  const res = await fetch(`${base}/control/load`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ref }) });
  const lines = (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l) as {
    progress?: number; error?: string; done?: { model: string; window: number; placement?: { fit: string; contextSize: number; totalLayers: number; layersGuessed: boolean } };
  });
  return lines.at(-1)!;
}

describe('計画が、実際の読み込みの引数に効く', () => {
  test('本物の形の GGUF から層の数と長さを読み、その計画で読む。メモリを 6 割に見せると SSD から読む計画になる', async () => {
    const dir = await tempDir('aas-large-int-tiny-');
    const at = await tinyGguf(dir, 'tiny.gguf');
    const bytes = (await stat(at)).size;
    const facts = await placementModelOf(at, 'tiny.gguf');
    assert.equal(facts.layers, 1, '層の数を GGUF から読めていない');
    assert.equal(facts.trainedContext, 2048);
    const seen = seenNothing();
    const said: string[] = [];
    await withEnv({ AAS_TEST_RAM_BYTES: String(Math.floor(bytes * 0.6)), AAS_TEST_PAGING_BYTES: String(64 * GB) }, async () => {
      const rt = new InProcRuntime({ modelsDir: dir, port: 0, control: true, load: fakeLib(seen), onLog: (l) => said.push(l) });
      try {
        const last = await loadOverHttp(rt, 'tiny.gguf');
        assert.equal(last.done?.placement?.fit, 'ssd', JSON.stringify(last));
        assert.equal(last.done?.placement?.totalLayers, 1);
        assert.equal(last.done?.placement?.layersGuessed, false);
        assert.equal(last.done?.window, 2048, 'モデルの長さより広くは開かない');
      } finally { await rt.shutdown(); }
    });
    assert.equal(seen.loads[0]!.useMmap, true);
    assert.equal(seen.loads[0]!.useMlock, false);
    assert.equal(seen.loads[0]!.ignoreMemorySafetyChecks, true);
    assert.equal(seen.contexts[0]!.contextSize, 2048);
    assert.equal(seen.contexts[0]!.batchSize, 256);
    assert.ok(said.some((l) => l.startsWith('配置の計画（SSD から読む（とても遅い））: この PC では: ')), said.join(' / '));
  });

  test('同じファイルでも、メモリを小さく見せなければ、余計な値を渡さない（対）', async () => {
    const dir = await tempDir('aas-large-int-tiny-plain-');
    await tinyGguf(dir, 'tiny.gguf');
    const seen = seenNothing();
    const rt = new InProcRuntime({ modelsDir: dir, port: 0, control: true, load: fakeLib(seen) });
    try {
      const last = await loadOverHttp(rt, 'tiny.gguf');
      assert.notEqual(last.done?.placement?.fit, 'ssd');
    } finally { await rt.shutdown(); }
    assert.deepEqual(Object.keys(seen.loads[0]!), ['modelPath']);
    assert.equal(seen.contexts[0]!.ignoreMemorySafetyChecks, undefined);
  });

  test('VRAM を 1.5GB に見せると、全部を GPU に載せるためにコンテキストウィンドウを狭めて頼む', async () => {
    const dir = await tempDir('aas-large-int-vram-');
    await writeFile(join(dir, 'm.gguf'), 'GGUF');
    const small = seenNothing();
    await withEnv({ AAS_TEST_VRAM_BYTES: String(1.5 * GB) }, async () => {
      const rt = new InProcRuntime({ modelsDir: dir, port: 0, load: fakeLib(small, { gpu: true }) });
      try { await rt.ensureLoaded('m.gguf'); } finally { await rt.shutdown(); }
    });
    assert.deepEqual(small.loads[0]!.gpuLayers, { fitContext: { contextSize: 4096 } });
    assert.equal(small.contexts[0]!.contextSize, 4096);
    // 対: 見せなければ、8GB の VRAM で 8192 のまま頼む
    const full = seenNothing();
    const rt = new InProcRuntime({ modelsDir: dir, port: 0, load: fakeLib(full, { gpu: true }) });
    try { await rt.ensureLoaded('m.gguf'); } finally { await rt.shutdown(); }
    assert.deepEqual(full.loads[0]!.gpuLayers, { fitContext: { contextSize: 8192 } });
  });

  test('VRAM の試験の口は、小さく見せるだけ。GPU の無い機械に GPU は生えない', async () => {
    const env = { AAS_TEST_VRAM_BYTES: String(4 * GB) };
    const none = await detectPlacementMachine({ env, platform: 'linux' });
    assert.deepEqual(none.gpus, []);
    const capped = await detectPlacementMachine({ env, platform: 'linux', gpu: { vramBytes: 8 * GB, freeVramBytes: 7 * GB } });
    assert.equal(capped.gpus[0]!.vramBytes, 4 * GB);
    assert.equal(capped.gpus[0]!.freeVramBytes, 4 * GB);
    const bigger = await detectPlacementMachine({ env: { AAS_TEST_VRAM_BYTES: String(64 * GB) }, platform: 'linux', gpu: { vramBytes: 8 * GB } });
    assert.equal(bigger.gpus[0]!.vramBytes, 8 * GB, '本物より大きく見せている');
    const zero = await detectPlacementMachine({ env: { AAS_TEST_VRAM_BYTES: '0' }, platform: 'linux', gpu: { vramBytes: 8 * GB } });
    assert.deepEqual(zero.gpus, []);
  });
});

describe('読み込みの進み具合', () => {
  test('99% のあとに来た 100% を、記録に必ず残す（10% 刻みの間引きで落とさない）', async () => {
    const dir = await tempDir('aas-large-int-progress-');
    await writeFile(join(dir, 'm.gguf'), 'GGUF');
    const said: string[] = [];
    const rt = new InProcRuntime({
      modelsDir: dir, port: 0, onLog: (l) => said.push(l),
      load: fakeLib(seenNothing(), { progress: [0.24, 0.5, 0.74, 0.995, 1, 1] }),
    });
    try { await rt.ensureLoaded('m.gguf'); } finally { await rt.shutdown(); }
    const lines = said.filter((l) => l.startsWith('読み込み中 '));
    assert.deepEqual(lines, ['読み込み中 24%: m.gguf', '読み込み中 50%: m.gguf', '読み込み中 74%: m.gguf', '読み込み中 99%: m.gguf', '読み込み中 100%: m.gguf']);
  });

  test('ライブラリが 99% までしか言わなくても、読み終えたら 100% を残す', async () => {
    const dir = await tempDir('aas-large-int-progress-99-');
    await writeFile(join(dir, 'm.gguf'), 'GGUF');
    const said: string[] = [];
    const rt = new InProcRuntime({ modelsDir: dir, port: 0, onLog: (l) => said.push(l), load: fakeLib(seenNothing(), { progress: [0.5, 0.995] }) });
    try { await rt.ensureLoaded('m.gguf'); } finally { await rt.shutdown(); }
    assert.deepEqual(said.filter((l) => l.startsWith('読み込み中 ')), ['読み込み中 50%: m.gguf', '読み込み中 99%: m.gguf', '読み込み中 100%: m.gguf']);
  });
});

describe('落ちたら、GPU の層を減らして読み直す', () => {
  test('VRAM が足りずに 3 回落ちる: 載るだけ → 16 層まで → コンテキストウィンドウを下限 → GPU なし、の順に渡す値が変わる', async () => {
    const dir = await tempDir('aas-large-int-ladder-');
    await writeFile(join(dir, 'm.gguf'), 'GGUF');
    const seen = seenNothing();
    const said: string[] = [];
    await withEnv({ AAS_TEST_VRAM_BYTES: String(1.5 * GB) }, async () => {
      const rt = new InProcRuntime({
        modelsDir: dir, port: 0, onLog: (l) => said.push(l),
        load: fakeLib(seen, { gpu: true, failContext: (_c, n) => (n <= 3 ? 'ErrorOutOfDeviceMemory' : undefined) }),
      });
      try {
        const got = await rt.ensureLoaded('m.gguf');
        assert.equal(got.placement?.contextSize, 4096);
        assert.equal(seen.disposed, 3, '載せ方を変えるたびに、前の重みを解く（止める前に数える）');
      } finally { await rt.shutdown(); }
    });
    assert.deepEqual(seen.loads.map((l) => l.gpuLayers), [
      { fitContext: { contextSize: 4096 } },
      { max: 16, fitContext: { contextSize: 8192 } },
      { max: 16, fitContext: { contextSize: 4096 } },
      0,
    ]);
    assert.deepEqual(seen.contexts.map((c) => c.contextSize), [4096, 8192, 4096, 4096]);
    const retries = said.filter((l) => l.startsWith('m.gguf: やり直し '));
    assert.deepEqual(retries, [
      'm.gguf: やり直し 1/3: GPU に載せる層を 32 から 16 に減らして、読み直します',
      'm.gguf: やり直し 2/3: コンテキストウィンドウを 4096 に狭めて、読み直します',
      'm.gguf: やり直し 3/3: GPU を使わず、メモリと SSD で読み直します',
    ]);
    assert.equal(said.some((l) => l.includes('GPU で読めなかったので、CPU で読み直します')), false);
  });

  test('試験の口（AAS_TEST_LOAD_FAILS=1）: 最初の段だけ落ち、次の段で読める。口を立てなければ落ちない（対）', async () => {
    const dir = await tempDir('aas-large-int-inject-');
    await tinyGguf(dir, 'tiny.gguf');
    const seen = seenNothing();
    const said: string[] = [];
    await withEnv({ AAS_TEST_LOAD_FAILS: '1' }, async () => {
      const rt = new InProcRuntime({ modelsDir: dir, port: 0, control: true, onLog: (l) => said.push(l), load: fakeLib(seen, { gpu: true }) });
      try {
        const last = await loadOverHttp(rt, 'tiny.gguf');
        assert.equal(last.done?.model, 'tiny.gguf', JSON.stringify(last));
      } finally { await rt.shutdown(); }
    });
    assert.ok(said.includes('tiny.gguf: 読み込めませんでした（メモリが足りません（試験の口 AAS_TEST_LOAD_FAILS の 1/1 段目））'), said.join(' / '));
    assert.ok(said.includes('tiny.gguf: やり直し 1/2: GPU に載せる層を 1 から 0 に減らして、読み直します'), said.join(' / '));
    assert.equal(seen.loads.length, 1, '落とした段は、ライブラリまで行かない');
    // GPU では並列 2 本で開くので、VRAM に入れる長さは 2048 × 2
    assert.deepEqual(seen.loads[0]!.gpuLayers, { max: 0, fitContext: { contextSize: 4096 } });

    const plain = seenNothing();
    const quiet: string[] = [];
    const rt = new InProcRuntime({ modelsDir: dir, port: 0, onLog: (l) => quiet.push(l), load: fakeLib(plain, { gpu: true }) });
    try { await rt.ensureLoaded('tiny.gguf'); } finally { await rt.shutdown(); }
    assert.equal(quiet.some((l) => l.includes('やり直し')), false);
    assert.deepEqual(plain.loads[0]!.gpuLayers, { fitContext: { contextSize: 4096 } });
  });

  test('コンテキストウィンドウがもう下限なら、「狭めて」と言わず、並列を減らすと言う', async () => {
    const dir = await tempDir('aas-large-int-seq-');
    await tinyGguf(dir, 'tiny.gguf');
    const { retryLadder } = await import('../src/runtime/placement.ts');
    const facts = await placementModelOf(join(dir, 'tiny.gguf'), 'tiny.gguf');
    const steps = retryLadder(facts, { ramBytes: 16 * GB, gpus: [], cores: 4 }, { context: 2048, sequences: 2 });
    assert.deepEqual(steps.map((s) => s.say), ['計画どおりに読みます', '並列を 2 本から 1 本に減らして、読み直します']);
    assert.deepEqual(steps.map((s) => [s.plan.contextSize, s.plan.sequences]), [[2048, 2], [2048, 1]]);
  });

  test('どの段でも落ちたら、最後の理由を返し、読んだ重みを残さない', async () => {
    const dir = await tempDir('aas-large-int-allfail-');
    await writeFile(join(dir, 'm.gguf'), 'GGUF');
    const seen = seenNothing();
    const rt = new InProcRuntime({ modelsDir: dir, port: 0, control: true, load: fakeLib(seen, { failContext: () => 'failed to allocate' }) });
    try {
      const last = await loadOverHttp(rt, 'm.gguf');
      assert.match(last.error ?? '', /failed to allocate/);
    } finally { await rt.shutdown(); }
    assert.equal(seen.disposed, 1);
  });
});

describe('読み込みの時間切れ', () => {
  test('合図を見ないライブラリでも、上限で返る。理由が口の最後の一行に来て、段を下げて繰り返さず、遅れて届いた重みは解く', async () => {
    const dir = await tempDir('aas-large-int-timeout-');
    await writeFile(join(dir, 'm.gguf'), 'GGUF');
    const seen = seenNothing();
    await withEnv({ AAS_TEST_LOAD_TIMEOUT_MS: '80' }, async () => {
      const rt = new InProcRuntime({ modelsDir: dir, port: 0, control: true, load: fakeLib(seen, { hang: true }) });
      try {
        const began = Date.now();
        // 上限が効かなくなったら、ここで待ち続けずに落ちる
        const last = await Promise.race([
          loadOverHttp(rt, 'm.gguf'),
          new Promise<never>((_, no) => setTimeout(() => no(new Error('上限を過ぎても、読み込みの返事が来ない')), 4000).unref()),
        ]);
        const took = Date.now() - began;
        assert.match(last.error ?? '', /^m\.gguf の読み込みが 0\.08 秒で終わりませんでした。ディスクが遅いか、メモリが足りずに行き来しています。/, JSON.stringify(last));
        assert.ok(took >= 80 && took < 5000, `上限で返っていない（${took}ms）`);
        assert.equal(seen.loads.length, 1, '時間切れを、段を下げて繰り返している');
        assert.equal(seen.signals[0]!.aborted, true, 'ライブラリに、止める合図を出していない');
        // 遅れて読み終えた重みが届く
        seen.release.forEach((r) => r());
        await new Promise((r) => setTimeout(r, 30));
        assert.equal(seen.disposed, 1, '遅れて届いた重みを、置きっぱなしにしている');
      } finally { seen.release.forEach((r) => r()); await rt.shutdown(); }
    });
  });

  test('GPU で時間切れになっても、CPU で同じ長さを待ち直さない', async () => {
    const dir = await tempDir('aas-large-int-timeout-gpu-');
    await writeFile(join(dir, 'm.gguf'), 'GGUF');
    const seen = seenNothing();
    const said: string[] = [];
    await withEnv({ AAS_TEST_LOAD_TIMEOUT_MS: '60' }, async () => {
      const rt = new InProcRuntime({ modelsDir: dir, port: 0, onLog: (l) => said.push(l), load: fakeLib(seen, { gpu: true, hang: true }) });
      try {
        await assert.rejects(rt.ensureLoaded('m.gguf'), /終わりませんでした/);
      } finally { seen.release.forEach((r) => r()); await rt.shutdown(); }
    });
    assert.equal(seen.loads.length, 1);
    assert.equal(said.some((l) => l.includes('CPU で読み直します')), false);
  });

  test('上限までに読み終えるなら、口を立てていても読める（対）', async () => {
    const dir = await tempDir('aas-large-int-timeout-ok-');
    await writeFile(join(dir, 'm.gguf'), 'GGUF');
    const seen = seenNothing();
    await withEnv({ AAS_TEST_LOAD_TIMEOUT_MS: '5000' }, async () => {
      const rt = new InProcRuntime({ modelsDir: dir, port: 0, control: true, load: fakeLib(seen) });
      try {
        const last = await loadOverHttp(rt, 'm.gguf');
        assert.equal(last.done?.model, 'm.gguf');
      } finally { await rt.shutdown(); }
    });
    assert.equal(seen.signals[0]!.aborted, false);
  });
});

/** 借りた直後に待つ長さを言い（言わないこともできる）、本文を一つ出してから `quietMs` 黙って、答える相手。 */
async function slowTalker(opts: { quietMs: number; waits?: string }) {
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  const server: Server = createServer((req, res) => {
    if (req.url?.endsWith('/models')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"data":[{"id":"m"}]}'); }
    req.on('data', () => undefined);
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (delta: unknown, finish: string | null = null) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      res.write(`: started\n\n${opts.waits ? `: waits ${opts.waits}\n\n` : ''}`);
      timers.push(setTimeout(() => send({ content: ' ' }), 20));
      timers.push(setTimeout(() => {
        send({ content: '7006652' });
        send({}, 'stop');
        res.end('data: [DONE]\n\n');
      }, 20 + opts.quietMs));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise<void>((r) => { timers.forEach((t) => clearTimeout(t)); server.closeAllConnections(); server.close(() => r()); }),
  };
}

async function collect(baseUrl: string) {
  const p = new OpenAiCompatibleProvider({ id: 'inproc', baseUrl, locality: 'local', stallTimeoutMs: 150, quietCeilingMs: 150 });
  let text = '';
  let failed: string | undefined;
  try {
    for await (const ev of p.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }], priority: Priority.top }, new AbortController().signal)) {
      if (ev.type === 'text') text += ev.delta;
    }
  } catch (e) { failed = (e as Error).message; }
  return { text, failed };
}

describe('計画の待つ長さが、送り側の待ちを延ばす', () => {
  test('無音 150ms の送り側でも、相手が「無音 3000ms まで」と言えば、600ms の無音を待つ', async () => {
    const fake = await slowTalker({ quietMs: 600, waits: '5000 3000' });
    try {
      const got = await collect(fake.baseUrl);
      assert.equal(got.failed, undefined, `計画の長さまで待っていない: ${got.failed}`);
      assert.match(got.text, /7006652/);
    } finally { await fake.close(); }
  });

  test('言わなければ、今までどおり自分の長さで止める（対）', async () => {
    const fake = await slowTalker({ quietMs: 600 });
    try {
      const got = await collect(fake.baseUrl);
      assert.match(got.failed ?? '', /応答しませんでした（停滞）/);
    } finally { await fake.close(); }
  });

  test('短い値が来ても、縮めない（100ms の無音を、「無音 10ms」と言われても待つ）', async () => {
    const fake = await slowTalker({ quietMs: 100, waits: '10 10' });
    try {
      const got = await collect(fake.baseUrl);
      assert.equal(got.failed, undefined, got.failed);
    } finally { await fake.close(); }
  });

  test('中で読む口は、借りた直後に、読んだ計画の待つ長さを言う', async () => {
    const dir = await tempDir('aas-large-int-waits-');
    await sparse(dir, 'big.gguf', 3 * MB);
    const seen = seenNothing();
    await withEnv({ AAS_TEST_RAM_BYTES: String(1 * MB), AAS_TEST_PAGING_BYTES: String(8 * GB) }, async () => {
      const rt = new InProcRuntime({ modelsDir: dir, port: 0, load: fakeLib(seen) });
      try {
        const got = await rt.ensureLoaded('big.gguf');
        const res = await fetch(`${got.baseUrl}/chat/completions`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'big.gguf', stream: true, messages: [{ role: 'user', content: 'x' }] }),
        });
        const text = await res.text();
        const said = /^: waits (\d+) (\d+)$/m.exec(text);
        assert.ok(said, `待つ長さを言っていない: ${text.slice(0, 200)}`);
        assert.equal(Number(said![1]), got.placement!.timeouts.firstTokenMs);
        assert.equal(Number(said![2]), got.placement!.timeouts.stallMs);
        assert.ok(text.indexOf(': started') < text.indexOf(': waits'), '借りる前に言っている');
      } finally { await rt.shutdown(); }
    });
  });
});

async function uiConfig(models: string) {
  return {
    providers: [],
    candidates: [],
    runtime: { kind: 'inproc', modelsDir: models },
    agent: { root: await tempDir('aas-large-int-root-'), approval: 'auto', verify: { enabled: false } },
    initiative: { enabled: false },
  } as never;
}

interface ModelsAnswer {
  engine: string | null;
  installed: Array<{ ref: string; tooBig: string | null; fit?: string; fitLabel?: string; plan?: string; detail?: string[] }>;
  catalog: Array<{ id: string; approxGB: number; possible?: boolean; fit?: string; fitLabel?: string; plan?: string; detail?: string[]; needDiskBytes?: number }>;
}

async function modelsOf(models: string, env: Record<string, string>): Promise<ModelsAnswer> {
  return withEnv(env, async () => {
    const server = new UiServer({ config: await uiConfig(models), port: 0, inprocLoad: fakeLib(seenNothing()) as never });
    try {
      const base = (await server.start()).replace(/\/$/, '');
      return await (await fetch(`${base}/api/models`)).json() as ModelsAnswer;
    } finally { await server.stop(); }
  });
}

describe('計画と、なぜ動かないか・どうすれば動くかが、画面に出る', () => {
  test('/api/models: メモリより大きいモデルに、具合・どう置くかの一行・細かい計画が、選ぶ前に付く', async () => {
    const models = await tempDir('aas-large-int-ui-');
    await sparse(models, 'big.gguf', 3 * MB);
    const got = await modelsOf(models, { AAS_TEST_RAM_BYTES: String(1 * MB), AAS_TEST_PAGING_BYTES: String(64 * GB), AAS_TEST_DISK_BYTES: String(18 * GB) });
    const big = got.installed.find((m) => m.ref === 'big.gguf')!;
    assert.equal(big.tooBig, null, '入るものに「入らない」と付けている');
    assert.equal(big.fit, 'ssd');
    assert.equal(big.fitLabel, 'SSD から読む（とても遅い）');
    assert.match(big.plan ?? '', /^この PC では: GPU は使わず、メモリに載せて CPU で動かします、足りない分（.+GB）は SSD から読みます。目安 [\d.]+ tok\/s。とても遅いですが、動きます$/);
    for (const head of ['具合: ', 'モデルの大きさ: ', 'GPU: ', 'メモリ: ', 'SSD から読む分: ', 'コンテキストウィンドウ: ', '速さの目安: ', '待つ上限: 読み込み ']) {
      assert.ok(big.detail?.some((l) => l.startsWith(head)), `「計画を見る」に ${head} の行が無い: ${big.detail?.join(' / ')}`);
    }
    assert.equal(got.engine, 'CPU');
    // 取ってくる一覧: どれにも具合が付き、置けないものには理由と動かす手が付く
    assert.ok(got.catalog.length >= 6);
    for (const m of got.catalog) assert.ok(m.fitLabel && m.plan, `${m.id} に具合が無い`);
    const no = got.catalog.filter((m) => m.possible === false);
    assert.ok(no.length >= 1, '18GB の空きに置けないもの（約 16GB 以上）が、入ると出ている');
    for (const m of no) {
      assert.equal(m.fitLabel, '入らない');
      assert.match(m.plan ?? '', /入りません（ディスクの空きが足りません）。動かすには: モデルの保存先の空きを、あと [\d.]+GB 増やす/);
      assert.ok(m.detail?.some((l) => l.startsWith('動かすには: 小さい量子化か、小さいモデルを選ぶ')), m.detail?.join(' / '));
    }
    assert.ok(got.catalog.some((m) => m.possible !== false), '全部が入らないと出ている');
  });

  test('/api/models: ページングの空きも無い機械では、入らない理由と動かす手が付く（対）', async () => {
    const models = await tempDir('aas-large-int-ui-no-');
    await sparse(models, 'big.gguf', 3 * MB);
    const got = await modelsOf(models, { AAS_TEST_RAM_BYTES: String(1 * MB), AAS_TEST_PAGING_BYTES: '0' });
    const big = got.installed.find((m) => m.ref === 'big.gguf')!;
    assert.equal(big.fit, 'no');
    assert.match(big.tooBig ?? '', /^big\.gguf: この機械のメモリ（.+GB）に対して大きすぎます/);
    assert.match(big.tooBig ?? '', /入りません（メモリとページングの空きを足しても届きません）。動かすには: ページングの場所（swap・ページ ファイル）を、あと [\d.]+GB 増やす/);
    assert.match(big.tooBig ?? '', /動かすには: メモリを [\d.]+GB 足す/);
  });

  test('/api/models: メモリに載るモデルには、入らないとも SSD とも付けない（対）', async () => {
    const models = await tempDir('aas-large-int-ui-small-');
    await writeFile(join(models, 'small.gguf'), 'GGUF');
    const got = await modelsOf(models, {});
    const small = got.installed.find((m) => m.ref === 'small.gguf')!;
    assert.equal(small.tooBig, null);
    assert.ok(small.fit === 'comfortable' || small.fit === 'slow', small.fit);
  });
});

installDom();
const { PANELS } = await import('../src/ui/web/panels.js') as { PANELS: Record<string, (body: StubNode, ctx: unknown) => void> };

async function drawModels(answer: unknown): Promise<StubNode> {
  (globalThis as { fetch?: unknown }).fetch = (async (url: string) => (
    Response.json(String(url).includes('/api/models/newer') ? { findings: [] } : answer)
  )) as unknown as typeof fetch;
  const body = createNode('div');
  PANELS.models!(body, { onState: () => {} });
  await new Promise((r) => setTimeout(r, 20));
  return body;
}

describe('モデルのパネル', () => {
  const realFetch = globalThis.fetch;
  const answer = {
    runtime: 'inproc', modelsDir: '/models', llamaServer: null, engine: 'CPU',
    installed: [{
      ref: 'big.gguf', sizeBytes: 5 * GB, path: '/models/big.gguf', tooBig: null, fit: 'ssd', fitLabel: 'SSD から読む（とても遅い）',
      plan: 'この PC では: GPU は使わず、メモリに載せて CPU で動かします、足りない分（2.0GB）は SSD から読みます。目安 0.1 tok/s。とても遅いですが、動きます',
      detail: ['具合: SSD から読む（とても遅い）', 'SSD から読む分: 2.0GB'],
    }],
    catalog: [
      { id: 'fits', note: '小さい', approxGB: 2.5, ref: 'a/fits', possible: true, fit: 'slow', fitLabel: '動く（遅い）', plan: 'この PC では: GPU は使わず、メモリに載せて CPU で動かします。目安 2 tok/s。遅いですが、動きます', detail: ['具合: 動く（遅い）'] },
      { id: 'huge', note: '大きい', approxGB: 22, ref: 'a/huge', possible: false, fit: 'no', fitLabel: '入らない', plan: 'この PC では: 入りません（ディスクの空きが足りません）。動かすには: モデルの保存先の空きを、あと 6.0GB 増やす', detail: ['具合: 入らない', '動かすには: 小さい量子化か、小さいモデルを選ぶ'] },
    ],
  };

  test('読む前に、具合・どう置くか・「計画を見る」が出る。入らないものは取ってこさせず、理由と動かす手を出す', async () => {
    try {
      const body = await drawModels(answer);
      const said = body.text;
      assert.match(said, /SSD から読む（とても遅い）/);
      assert.match(said, /足りない分（2\.0GB）は SSD から読みます/);
      assert.match(said, /計画を見る/);
      assert.match(said, /SSD から読む分: 2\.0GB/);
      assert.match(said, /この PC のエンジン: CPU/);
      assert.match(said, /入りません（ディスクの空きが足りません）。動かすには: モデルの保存先の空きを、あと 6\.0GB 増やす/);
      const get = (id: string) => body.buttons().find((b) => b.textContent === `${id}（約${id === 'huge' ? 22 : 2.5}GB）`)!;
      assert.equal(Boolean(get('huge').disabled), true, '入らないものを、取ってこられる');
      assert.equal(Boolean(get('fits').disabled), false, '入るものを、取ってこられない');
    } finally { globalThis.fetch = realFetch; }
  });

  test('計画の無い返事（Ollama）でも、パネルは今までどおり出る（対）', async () => {
    try {
      const body = await drawModels({ runtime: 'ollama', modelsDir: '/models', llamaServer: null, installed: [{ ref: 'qwen3.5:9b', sizeBytes: 6 * GB }], catalog: [{ id: 'fits', note: '小さい', approxGB: 2.5, ref: 'x' }] });
      assert.doesNotMatch(body.text, /計画を見る|この PC のエンジン/);
      assert.match(body.text, /qwen3\.5:9b/);
    } finally { globalThis.fetch = realFetch; }
  });
});

async function runDoctor(env: Record<string, string>): Promise<string> {
  const flags = needsStripFlag(process.versions.node) ? ['--experimental-strip-types'] : [];
  const out = await run(process.execPath, [...flags, '--no-warnings', join(root, 'src', 'cli', 'doctor.ts')], {
    env: cleanAasEnv({ ...env, NO_COLOR: '1' }), timeout: 300_000,
  }).catch((e: { stdout?: string; stderr?: string }) => e);
  // eslint-disable-next-line no-control-regex
  const text = `${out.stdout ?? ''}${out.stderr ?? ''}`.replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(text, /動かせます|かたづければ動きます/, `締めまで出ていない:\n${text.slice(-600)}`);
  return text;
}

describe('doctor に、計画と動かす手が出る', () => {
  async function scratch() {
    const dir = await tempDir('aas-large-int-doc-');
    const models = join(dir, 'models');
    await mkdir(models, { recursive: true });
    await sparse(models, 'big.gguf', 3 * MB);
    const config = join(dir, 'aas.config.json');
    await writeFile(config, JSON.stringify({ runtime: { kind: 'inproc', modelsDir: models } }));
    return { AAS_HOME: join(dir, 'home'), AAS_CONFIG: config, AAS_REPORT_DIR: join(dir, 'reports') };
  }

  test('メモリより大きいモデル: 「大きすぎます」で終わらず、どう置くかを言う', async () => {
    const text = await runDoctor({ ...await scratch(), AAS_TEST_RAM_BYTES: String(1 * MB), AAS_TEST_PAGING_BYTES: String(8 * GB) });
    assert.match(text, /big\.gguf: メモリより大きいので、分けて置きます。この PC では: .*SSD から読みます。目安 [\d.]+ tok\/s/, text.slice(-1500));
    assert.doesNotMatch(text, /大きすぎます/);
  });

  test('どう置いても入らないモデル: 理由と、動かす手を言う（対）', async () => {
    const text = await runDoctor({ ...await scratch(), AAS_TEST_RAM_BYTES: String(1 * MB), AAS_TEST_PAGING_BYTES: '0' });
    assert.match(text, /big\.gguf: この機械のメモリ（.+GB）に対して大きすぎます/, text.slice(-1500));
    assert.match(text, /入りません（メモリとページングの空きを足しても届きません）。動かすには: ページングの場所/);
    assert.match(text, /動かすには: メモリを [\d.]+GB 足す/);
  });

  test('口を立てなければ、3MB のモデルに計画の行は出ない（対）', async () => {
    const text = await runDoctor(await scratch());
    assert.doesNotMatch(text, /分けて置きます|大きすぎます/);
  });
});
