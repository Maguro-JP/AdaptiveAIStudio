/**
 * 大きいモデルを、断らずに読む（src/runtime/inproc.ts と placement.ts の繋ぎ）。
 *
 * ここまでの形:
 *   ・メモリの 85% より大きいファイルは、読む前に「大きすぎます」で断っていた
 *   ・読み込みの返事を、読み終えてから一度に返していた（5 分を超える読み込みは、返事の頭を待つ側が先に切る）
 *   ・メモリや VRAM が足りずに落ちたら、そこで終わりか、CPU で丸ごと読み直していた
 *   ・本文に出ないまま 10 分を超えて作り続けるモデルを、停滞で落としていた
 * どれも、本物の代わりのライブラリ（モック）で、読み方と渡した値を見る。メモリは試験の口で小さく見せる。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { open, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tempDir } from './tmp.ts';
import { InProcRuntime } from '../src/runtime/inproc.ts';
import { OpenAiCompatibleProvider } from '../src/providers/openai-compatible.ts';
import { Priority } from '../src/providers/contract.ts';

const MB = 1024 ** 2;

interface Seen { loads: Record<string, unknown>[]; contexts: Record<string, unknown>[]; disposed: number }

/** 渡された値を覚える偽のライブラリ。`fail` が文を返した読み込み・context は、その文で落ちる。 */
function fakeLib(seen: Seen, opts: {
  gpu?: boolean;
  failLoad?: (o: Record<string, unknown>, n: number) => string | undefined;
  failContext?: (o: Record<string, unknown>, n: number) => string | undefined;
  loadMs?: number;
} = {}) {
  return async () => ({
    getLlama: async () => ({
      ...(opts.gpu ? {
        gpu: 'cuda' as const,
        getGpuDeviceNames: async () => ['NVIDIA GeForce RTX 4060'],
        getVramState: async () => ({ total: 8 * 1024 ** 3, used: 0, free: 8 * 1024 ** 3 }),
      } : {}),
      loadModel: async (o: Record<string, unknown> & { onLoadProgress?: (d: number) => void }) => {
        const { onLoadProgress, loadSignal: _s, ...rest } = o;
        seen.loads.push(rest);
        const bad = opts.failLoad?.(rest, seen.loads.length);
        if (bad) throw new Error(bad);
        for (const d of [0.25, 0.5, 0.75, 1]) {
          if (opts.loadMs) await new Promise((r) => setTimeout(r, opts.loadMs! / 4));
          onLoadProgress?.(d);
        }
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

/** 中身の無い（疎な）.gguf。大きさだけが本物。 */
async function sparse(dir: string, name: string, bytes: number): Promise<void> {
  const fh = await open(join(dir, name), 'w');
  try { await fh.write('GGUF'); await fh.truncate(bytes); } finally { await fh.close(); }
}

/** 試験の口（環境変数）を立てて、終わったら戻す。 */
async function withEnv<T>(set: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const before: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(set)) { before[k] = process.env[k]; process.env[k] = v; }
  try { return await run(); } finally {
    for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

describe('メモリより大きいモデルを、断らずに読む', () => {
  test('メモリを 1MB に見せた機械で 3MB のモデル: SSD から読む計画で読み、メモリには固定しない', async () => {
    const dir = await tempDir('aas-large-ssd-');
    await sparse(dir, 'big.gguf', 3 * MB);
    const seen: Seen = { loads: [], contexts: [], disposed: 0 };
    const said: string[] = [];
    await withEnv({ AAS_TEST_RAM_BYTES: String(1 * MB), AAS_TEST_PAGING_BYTES: String(8 * 1024 * MB) }, async () => {
      const rt = new InProcRuntime({ modelsDir: dir, port: 0, load: fakeLib(seen), onLog: (l) => said.push(l) });
      try {
        const got = await rt.ensureLoaded('big.gguf');
        assert.equal(got.placement?.fit, 'ssd');
        assert.equal(rt.placementOf('big.gguf')?.fitLabel, 'SSD から読む（とても遅い）');
      } finally { await rt.shutdown(); }
    });
    assert.equal(seen.loads.length, 1);
    assert.equal(seen.loads[0]!.useMmap, true, 'ファイルの写しで読む');
    assert.equal(seen.loads[0]!.useMlock, false, 'メモリに固定しない');
    assert.equal(seen.loads[0]!.ignoreMemorySafetyChecks, true, 'ライブラリの「足りない」で断らせない');
    assert.equal(seen.contexts[0]!.ignoreMemorySafetyChecks, true);
    assert.equal(seen.contexts[0]!.contextSize, 4096, '入り切らないときは、コンテキストウィンドウを下限にする');
    assert.equal(seen.contexts[0]!.sequences, 1);
    assert.equal(seen.contexts[0]!.batchSize, 256, 'メモリが苦しいときは小さく刻む');
    const plan = said.find((l) => l.startsWith('配置の計画（SSD から読む（とても遅い））: この PC では: '));
    assert.ok(plan && /SSD から読みます。目安 [\d.]+ tok\/s。とても遅いですが、動きます/.test(plan), said.join(' / '));
    assert.ok(said.some((l) => l.includes('配置の計画: コンテキストウィンドウを 8192 から 4096 に狭めました')));
  });

  test('ページングの空きも無い機械では読まずに断り、何があれば動くかを言う（対）', async () => {
    const dir = await tempDir('aas-large-no-');
    await sparse(dir, 'big.gguf', 3 * MB);
    const seen: Seen = { loads: [], contexts: [], disposed: 0 };
    await withEnv({ AAS_TEST_RAM_BYTES: String(1 * MB), AAS_TEST_PAGING_BYTES: '0' }, async () => {
      const rt = new InProcRuntime({ modelsDir: dir, port: 0, load: fakeLib(seen) });
      try {
        await assert.rejects(rt.ensureLoaded('big.gguf'), (e: Error) => {
          assert.match(e.message, /big\.gguf: この PC では: 入りません（メモリとページングの空きを足しても届きません）。動かすには: ページングの場所/);
          assert.match(e.message, /動かすには: メモリを/);
          return true;
        });
      } finally { await rt.shutdown(); }
    });
    assert.equal(seen.loads.length, 0, '入らないと分かっているものを、読みに行かない');
  });

  test('メモリに載るモデルは、今までどおりに読む（余計な値を渡さない）', async () => {
    const dir = await tempDir('aas-large-small-');
    await writeFile(join(dir, 'm.gguf'), 'GGUF');
    const seen: Seen = { loads: [], contexts: [], disposed: 0 };
    const said: string[] = [];
    const rt = new InProcRuntime({ modelsDir: dir, port: 0, load: fakeLib(seen), onLog: (l) => said.push(l) });
    try { await rt.ensureLoaded('m.gguf'); } finally { await rt.shutdown(); }
    assert.deepEqual(Object.keys(seen.loads[0]!), ['modelPath']);
    assert.deepEqual(seen.contexts[0], { contextSize: 8192, sequences: 1 });
    assert.equal(said.some((l) => l.startsWith('配置の計画')), false, '小さいモデルで、毎回一行増やさない');
  });
});

describe('メモリが足りずに落ちたら、段を下げて読み直す', () => {
  test('context が入らない: コンテキストウィンドウを狭めて作り直す。重みは読み直さない', async () => {
    const dir = await tempDir('aas-large-ladder-');
    await writeFile(join(dir, 'm.gguf'), 'GGUF');
    const seen: Seen = { loads: [], contexts: [], disposed: 0 };
    const said: string[] = [];
    const rt = new InProcRuntime({
      modelsDir: dir, port: 0, onLog: (l) => said.push(l),
      load: fakeLib(seen, { failContext: (c) => (Number(c.contextSize) > 4096 ? 'A context size of 8192 is too large for the available RAM' : undefined) }),
    });
    try {
      await rt.ensureLoaded('m.gguf');
      assert.equal(rt.windowOf('m.gguf'), 4096, '実際に開いた長さを持つ');
    } finally { await rt.shutdown(); }
    assert.equal(seen.loads.length, 1, '数GBを読み直さない');
    assert.deepEqual(seen.contexts.map((c) => c.contextSize), [8192, 4096]);
    assert.ok(said.some((l) => l === 'm.gguf: 読み込めませんでした（A context size of 8192 is too large for the available RAM）'), said.join(' / '));
    assert.ok(said.some((l) => l === 'm.gguf: やり直し 1/1: コンテキストウィンドウを 4096 に狭めて、読み直します'));
    assert.ok(said.some((l) => l.includes('コンテキストウィンドウ: 4096・並列 1 本で開きました')));
  });

  test('GPU: 計画どおり → 層を減らす → コンテキストウィンドウを狭める → GPU を使わない、の順に下げる', async () => {
    const dir = await tempDir('aas-large-gpu-');
    await writeFile(join(dir, 'm.gguf'), 'GGUF');
    // 2 回目までは VRAM の確保で落ちる
    const seen: Seen = { loads: [], contexts: [], disposed: 0 };
    const said: string[] = [];
    const rt = new InProcRuntime({
      modelsDir: dir, port: 0, onLog: (l) => said.push(l),
      load: fakeLib(seen, { gpu: true, failContext: (_c, n) => (n <= 2 ? 'ErrorOutOfDeviceMemory' : undefined) }),
    });
    try { await rt.ensureLoaded('m.gguf'); } finally { await rt.shutdown(); }
    // 計画どおりの段は、「このコンテキストウィンドウが VRAM に入る範囲で、載るだけ」と頼む
    assert.deepEqual(seen.loads[0]!.gpuLayers, { fitContext: { contextSize: 8192 } });
    const retries = said.filter((l) => l.startsWith('m.gguf: やり直し '));
    assert.ok(retries.length >= 2, said.join(' / '));
    assert.ok(seen.disposed >= 1, '載せ方を変えるときは、前の重みを解いてから読む');
    assert.equal(said.some((l) => l.includes('GPU で読めなかったので、CPU で読み直します')), false, '段で読めたなら、丸ごとの読み直しまで行かない');
  });

  test('メモリの失敗でないもの（壊れたファイル）は、同じ読み込みを繰り返さない（対）', async () => {
    const dir = await tempDir('aas-large-broken-');
    await writeFile(join(dir, 'm.gguf'), 'GGUF');
    const seen: Seen = { loads: [], contexts: [], disposed: 0 };
    const rt = new InProcRuntime({ modelsDir: dir, port: 0, load: fakeLib(seen, { failLoad: () => 'invalid magic characters' }) });
    try { await assert.rejects(rt.ensureLoaded('m.gguf'), /invalid magic/); } finally { await rt.shutdown(); }
    assert.equal(seen.loads.length, 1);
  });
});

describe('読み込みの返事を流す', () => {
  test('読んでいる間、進み具合が一行ずつ届き、最後の一行で結果が来る', async () => {
    const dir = await tempDir('aas-large-stream-');
    await writeFile(join(dir, 'm.gguf'), 'GGUF');
    const seen: Seen = { loads: [], contexts: [], disposed: 0 };
    const rt = new InProcRuntime({ modelsDir: dir, port: 0, control: true, loadBeatMs: 20, load: fakeLib(seen, { loadMs: 400 }) });
    try {
      const base = (await rt.serve()).replace(/\/v1$/, '');
      const began = Date.now();
      const res = await fetch(`${base}/control/load`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ref: 'm.gguf' }) });
      const headAt = Date.now() - began;
      const lines = (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l) as { progress?: number; done?: { model: string; window: number }; error?: string });
      assert.ok(headAt < 300, `返事の頭を、読み終えるまで待たせている（${headAt}ms）`);
      const progress = lines.flatMap((l) => (typeof l.progress === 'number' ? [l.progress] : []));
      assert.ok(progress.length >= 3, `進み具合が流れていない: ${JSON.stringify(lines)}`);
      assert.ok(progress.some((p) => p > 0 && p < 100), '途中の値が無い');
      assert.equal(lines.at(-1)?.done?.model, 'm.gguf');
      assert.equal(lines.at(-1)?.done?.window, 8192);
    } finally { await rt.shutdown(); }
  });

  test('読み込めなかったときは、最後の一行で理由が来る', async () => {
    const dir = await tempDir('aas-large-stream-bad-');
    await writeFile(join(dir, 'm.gguf'), 'GGUF');
    const seen: Seen = { loads: [], contexts: [], disposed: 0 };
    const rt = new InProcRuntime({ modelsDir: dir, port: 0, control: true, load: fakeLib(seen, { failLoad: () => 'invalid magic characters' }) });
    try {
      const base = (await rt.serve()).replace(/\/v1$/, '');
      const res = await fetch(`${base}/control/load`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ref: 'm.gguf' }) });
      const last = JSON.parse((await res.text()).trim().split('\n').at(-1)!) as { error?: string };
      assert.match(last.error ?? '', /invalid magic/);
    } finally { await rt.shutdown(); }
  });
});

/**
 * 本文を一つ出したあと、本文に出ないまま作り続ける相手（遅いモデルが、ツールの呼び出しを組んでいる形）。
 * `counting` なら、合図に作った数を添える（`: working 1` `: working 2` …）。添えなければ、数の無い合図だけ。
 */
async function silentWorker(opts: { quietMs: number; beatMs: number; counting: boolean }) {
  const timers: Array<ReturnType<typeof setInterval>> = [];
  const server: Server = createServer((req, res) => {
    if (req.url?.endsWith('/models')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"data":[{"id":"m"}]}'); }
    req.on('data', () => undefined);
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (delta: unknown, finish: string | null = null) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      send({ content: ' ' });
      let made = 0;
      const beat = setInterval(() => { made += 1; if (!res.writableEnded) res.write(opts.counting ? `: working ${made}\n\n` : ': working\n\n'); }, opts.beatMs);
      timers.push(beat);
      const done = setTimeout(() => {
        clearInterval(beat);
        send({ content: '7006652' });
        send({}, 'stop');
        res.end('data: [DONE]\n\n');
      }, opts.quietMs);
      timers.push(done as unknown as ReturnType<typeof setInterval>);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise<void>((r) => { timers.forEach((t) => clearInterval(t)); server.closeAllConnections(); server.close(() => r()); }),
  };
}

async function collect(baseUrl: string) {
  // 無音の上限（300ms）より長く、本文に出ないまま作り続ける
  const p = new OpenAiCompatibleProvider({ id: 'inproc', baseUrl, locality: 'local', stallTimeoutMs: 200, quietCeilingMs: 300 });
  let text = '';
  let failed: string | undefined;
  try {
    for await (const ev of p.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }], priority: Priority.top }, new AbortController().signal)) {
      if (ev.type === 'text') text += ev.delta;
    }
  } catch (e) { failed = (e as Error).message; }
  return { text, failed };
}

describe('遅いモデルを、停滞で止めない', () => {
  test('本文に出ない間も、作った数が増えていれば待つ（上限を超えても）', async () => {
    const fake = await silentWorker({ quietMs: 1200, beatMs: 50, counting: true });
    try {
      const got = await collect(fake.baseUrl);
      assert.equal(got.failed, undefined, `進んでいるのに落としている: ${got.failed}`);
      assert.match(got.text, /7006652/);
    } finally { await fake.close(); }
  });

  test('数が増えない合図だけなら、今までどおり上限で止める（対）', async () => {
    const fake = await silentWorker({ quietMs: 1200, beatMs: 50, counting: false });
    try {
      const got = await collect(fake.baseUrl);
      assert.match(got.failed ?? '', /応答しませんでした（停滞）/);
    } finally { await fake.close(); }
  });
});
