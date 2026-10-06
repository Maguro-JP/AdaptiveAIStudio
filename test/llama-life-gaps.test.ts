/**
 * llama-server と、中で読む子（inproc）を立てる・止める所の不具合（46 回目の調査）。
 *
 * - 固定の版（b4585）が知らない `--mmap` を渡していた（GPU に全部載らない計画のたび）
 * - KV を下げる計画で V も下げていた（flash attention 無しでは context を作れずに落ちる版がある）
 * - 準備を `/v1/models` の 200 で見ていて、新しい版では読み終える前に「起動完了」と言う
 * - ■ で止める途中の起動に、後から来た人を相乗りさせ、止めていない人まで「中断されました」で落とす
 * - 名前だけで呼ぶ llama-server に、今のフォルダ（`.`）からライブラリを読ませる
 * - 中で読む子が口を言う前に止めると、口が開くのを待って最大 30 秒止まる
 * - 画面と端末が並んで動くと、モデルの実測（metrics.json）の回数を後から書いた方が消す
 *
 * 偽の llama-server（`test/fixtures/fake-llama-server.mjs`）は、本物と同じく知らない引数で落ち、読み込み中は `/health` が 503 になる。
 * 本物の b4585 の引数の一覧と V の量子化の制限は、ここでは本物を動かして確かめていない。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './tmp.ts';
import { until } from './until.ts';
import { LlamaCppRuntime } from '../src/runtime/llamacpp.ts';
import { REFERENCE_MACHINE } from '../src/runtime/spec.ts';
import { runtimeEnv } from '../src/runtime/llama-env.ts';
import { InProcHost } from '../src/runtime/inproc-host-client.ts';
import { MetricsStore } from '../src/runtime/metrics.ts';

const here = join(fileURLToPath(import.meta.url), '..');
const FAKE = join(here, 'fixtures', 'fake-llama-server.mjs');

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((ok) => probe.listen(0, '127.0.0.1', ok));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((ok) => probe.close(() => ok()));
  return port;
}

async function runtime(machine = REFERENCE_MACHINE): Promise<LlamaCppRuntime> {
  const dir = await tempDir('aas-llama-life-');
  for (const f of ['a-70b.gguf', 'a-14b.gguf']) await writeFile(join(dir, f), 'GGUF');
  return new LlamaCppRuntime({
    command: process.execPath, commandArgs: [FAKE], modelsDir: dir,
    machine, basePort: await freePort(), startupTimeoutMs: 15_000,
  });
}

async function withEnv<T>(env: Record<string, string>, run: () => Promise<T>): Promise<T> {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  try { return await run(); } finally { for (const k of Object.keys(env)) delete process.env[k]; }
}

describe('llama-server へ渡す引数', () => {
  test('**載せきれない計画でも、固定の版が知らない引数を渡さない**（偽物は知らない引数で落ちる）', async () => {
    const rt = await runtime();
    try {
      const plan = rt.planFor('a-14b.gguf')!;
      assert.notEqual(plan.placement, 'fullGpu', '前提: GPU に全部は載らない計画');
      assert.equal(plan.useMmap, true, '前提: mmap を使う計画');
      const loaded = await rt.ensureLoaded('a-14b.gguf');
      const body = await (await fetch(`${loaded.baseUrl}/models`)).json() as { received: Record<string, unknown> };
      assert.equal(body.received.noMmap, false);
    } finally { await rt.shutdown(); }
  });

  test('**KV を下げる計画では K だけを下げ、V は下げない**', async () => {
    const rt = await runtime();
    try {
      const plan = rt.planFor('a-70b.gguf')!;
      assert.notEqual(plan.kvCacheType, 'f16', '前提: KV を下げる計画');
      const loaded = await rt.ensureLoaded('a-70b.gguf');
      const body = await (await fetch(`${loaded.baseUrl}/models`)).json() as { received: Record<string, unknown> };
      assert.equal(body.received.cacheTypeK, plan.kvCacheType);
      assert.equal(body.received.cacheTypeV, undefined);
    } finally { await rt.shutdown(); }
  });
});

describe('準備できたか', () => {
  test('**読み終えるまで（/health が 200 になるまで）「起動完了」と言わない**', async () => {
    const rt = await runtime();
    try {
      await withEnv({ FAKE_LLAMA_LOAD_MS: '1500' }, async () => {
        const loaded = await rt.ensureLoaded('a-14b.gguf');
        const health = await fetch(new URL('/health', loaded.baseUrl));
        assert.equal(health.status, 200, '読み込み中に起動完了と言った');
      });
    } finally { await rt.shutdown(); }
  });
});

describe('■ で止めた直後', () => {
  test('**止める途中の起動に相乗りさせず、後から頼んだ人の分は起こし直す**', async () => {
    const rt = await runtime();
    try {
      await withEnv({ FAKE_LLAMA_DELAY_MS: '1500' }, async () => {
        const mine = new AbortController();
        const first = rt.ensureLoaded('a-14b.gguf', mine.signal).then(() => 'loaded', (e: Error) => e.message);
        mine.abort();
        assert.match(await first, /中断/);
        const next = await rt.ensureLoaded('a-14b.gguf', new AbortController().signal).then(() => 'loaded', (e: Error) => e.message);
        assert.equal(next, 'loaded', '止めていない人まで「中断されました」で落とした');
      });
    } finally { await rt.shutdown(); }
  });
});

describe('共有ライブラリの探し場所', () => {
  test('**名前だけで呼ぶときは、今のフォルダ（.）を足さない**', () => {
    const env = runtimeEnv('llama-server', 'linux', { LD_LIBRARY_PATH: '/usr/lib' });
    assert.equal(env.LD_LIBRARY_PATH, '/usr/lib');
    assert.equal(runtimeEnv('llama-server', 'darwin', {}).DYLD_LIBRARY_PATH, undefined);
  });
});

describe('中で読む子', () => {
  test('**口を言う前の子は、頼まずにすぐ止める**（口が開くのを待って 30 秒止まっていた）', { timeout: 60_000 }, async () => {
    const dir = await tempDir('aas-llama-life-host-');
    const entry = join(dir, 'silent-host.mjs');
    // 立ち上がっても口を言わない子
    await writeFile(entry, 'setInterval(() => {}, 1000);\n');
    const host = new InProcHost({ modelsDir: dir, port: 0, entry, startWaitMs: 30_000 });
    const pending = host.backend().catch(() => undefined);
    await until(() => host.pid() !== undefined, '子が起きない');
    const began = Date.now();
    await host.shutdown();
    const took = Date.now() - began;
    await pending;
    assert.ok(took < 8_000, `止めるのに ${took}ms かかった`);
  });
});

describe('モデルの実測の記録', () => {
  test('**二つのプロセスが並んで書いても、両方の回数が残る**', async () => {
    const path = join(await tempDir('aas-llama-life-metrics-'), 'metrics.json');
    const ui = new MetricsStore(path);
    const cli = new MetricsStore(path);
    await ui.load();
    await cli.load();
    for (let i = 0; i < 10; i++) ui.record({ modelId: 'm', success: true, outputTokens: 100, seconds: 2 });
    await ui.save();
    cli.record({ modelId: 'm', success: false, outputTokens: 100, seconds: 2 });
    await cli.save();
    const after = new MetricsStore(path);
    await after.load();
    assert.equal(after.get('m')?.successes, 10, '先に書いた方の成功を消した');
    assert.equal(after.get('m')?.failures, 1);
    // もう一度書いても、同じ差を二度足さない
    await cli.save();
    const again = new MetricsStore(path);
    await again.load();
    assert.equal(again.get('m')?.successes, 10, '同じ差を二度足した');
  });
});
