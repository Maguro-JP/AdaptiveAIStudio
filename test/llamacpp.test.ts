/**
 * llama.cpp 直接制御ランタイムの検証。
 * プランナの計算値が実際に引数として渡ることを確認する。
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { tempDir } from './tmp.ts';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LlamaCppRuntime } from '../src/runtime/llamacpp.ts';
import { REFERENCE_MACHINE } from '../src/runtime/spec.ts';

const here = join(fileURLToPath(import.meta.url), '..');
const FAKE = join(here, 'fixtures', 'fake-llama-server.mjs');

let portCursor = 19100;

async function modelsDir(files: string[] = ['qwen2.5-coder-32b.gguf']): Promise<string> {
  const dir = await tempDir('aas-models-');
  for (const f of files) await writeFile(join(dir, f), 'GGUF');
  return dir;
}

function runtime(dir: string, extra: Partial<ConstructorParameters<typeof LlamaCppRuntime>[0]> = {}) {
  return new LlamaCppRuntime({
    // 実物の代わりに node で fake サーバを起動する
    command: process.execPath,
    commandArgs: [FAKE],
    modelsDir: dir,
    machine: REFERENCE_MACHINE,
    basePort: (portCursor += 10),
    startupTimeoutMs: 15_000,
    ...extra,
  });
}

const started: LlamaCppRuntime[] = [];
after(async () => { await Promise.all(started.map((r) => r.shutdown())); });

describe('モデル一覧', () => {
  test('GGUFファイルだけを列挙する', async () => {
    const dir = await modelsDir(['a-7b.gguf', 'readme.txt', 'b-14b.gguf']);
    const rt = runtime(dir);
    const list = await rt.list();
    assert.deepEqual(list.map((m) => m.ref).sort(), ['a-7b.gguf', 'b-14b.gguf']);
    assert.ok(list[0]!.sizeBytes! > 0);
  });

  test('ディレクトリが無くても落ちない', async () => {
    const rt = runtime('/nonexistent/models');
    assert.deepEqual(await rt.list(), []);
  });
});

describe('実行計画', () => {
  test('ファイル名から規模を判定し、部分オフロードの計画を出す', async () => {
    const dir = await modelsDir(['qwen2.5-coder-32b.gguf']);
    const plan = runtime(dir).planFor('qwen2.5-coder-32b.gguf')!;
    assert.equal(plan.placement, 'partialOffload');
    assert.ok(plan.gpuLayers > 0 && plan.gpuLayers < plan.totalLayers);
  });

  test('規模が読めないファイルは計画を出せない', async () => {
    const dir = await modelsDir(['mystery.gguf']);
    assert.equal(runtime(dir).planFor('mystery.gguf'), undefined);
  });
});

describe('起動と停止', () => {
  test('commandArgs が command の直後に渡る（ラッパー経由の起動）', async () => {
    const dir = await modelsDir(['a-7b.gguf']);
    const rt = runtime(dir); started.push(rt);
    // fake サーバは commandArgs 経由で起動されている。
    // 渡っていなければ node が --model を解釈できず起動に失敗する。
    const loaded = await rtEnsure(rt, dir, 'a-7b.gguf');
    const res = await fetch(`${loaded.baseUrl}/models`);
    assert.equal(res.ok, true);
  });

  test('プランナの計算値が llama-server の引数として渡る', async () => {
    const dir = await modelsDir(['qwen2.5-coder-32b.gguf']);
    const rt = runtime(dir, { parallel: 2 });
    started.push(rt);

    const loaded = await rtEnsure(rt, dir, 'qwen2.5-coder-32b.gguf');
    const res = await fetch(`${loaded.baseUrl}/models`);
    const body = (await res.json()) as { received: Record<string, string | boolean> };

    const plan = rt.planFor('qwen2.5-coder-32b.gguf')!;
    assert.equal(body.received.nGpuLayers, String(plan.gpuLayers));
    // context は 並列数ぶん確保される
    assert.equal(body.received.ctxSize, String(plan.contextLength * 2));
    assert.equal(body.received.parallel, '2');
    assert.equal(body.received.mmap, plan.useMmap);
    assert.ok(String(body.received.model).endsWith('qwen2.5-coder-32b.gguf'));

    assert.ok(loaded.loadSeconds! >= 0);
    assert.deepEqual(rt.loaded(), ['qwen2.5-coder-32b.gguf']);
  });

  test('同じモデルを二重に起動しない', async () => {
    const dir = await modelsDir(['a-7b.gguf']);
    const rt = runtime(dir); started.push(rt);
    const first = await rtEnsure(rt, dir, 'a-7b.gguf');
    const second = await rtEnsure(rt, dir, 'a-7b.gguf');
    assert.equal(first.baseUrl, second.baseUrl);
    assert.equal(rt.loaded().length, 1);
  });

  test('unload するとプロセスが止まり、接続できなくなる', async () => {
    const dir = await modelsDir(['a-7b.gguf']);
    const rt = runtime(dir); started.push(rt);
    const loaded = await rtEnsure(rt, dir, 'a-7b.gguf');
    await rt.unload('a-7b.gguf');
    assert.deepEqual(rt.loaded(), []);
    const reachable = await fetch(`${loaded.baseUrl}/models`, { signal: AbortSignal.timeout(1000) })
      .then(() => true, () => false);
    assert.equal(reachable, false, 'unload 後も接続できてしまう');
  });

  test('起動に失敗したら待ち続けず、標準エラーを添えて失敗する', async () => {
    const dir = await modelsDir(['a-7b.gguf']);
    const rt = runtime(dir); started.push(rt);
    process.env.FAKE_LLAMA_FAIL = '1';
    try {
      await assert.rejects(
        () => rtEnsure(rt, dir, 'a-7b.gguf'),
        (e: Error) => /起動に失敗/.test(e.message) && /failed to load model/.test(e.message),
      );
    } finally {
      delete process.env.FAKE_LLAMA_FAIL;
    }
  });

  test('実行ファイルが無いときは、その理由を添えて失敗する（番号だけにしない）', async () => {
    const dir = await modelsDir(['a-7b.gguf']);
    const rt = runtime(dir, { command: join(dir, 'no-such-llama-server'), commandArgs: [] }); started.push(rt);
    await assert.rejects(
      () => rtEnsure(rt, dir, 'a-7b.gguf'),
      (e: Error) => /起動に失敗/.test(e.message) && /ENOENT/.test(e.message),
    );
  });

  test('起動が遅くても、応答可能になるまで待つ', async () => {
    const dir = await modelsDir(['a-7b.gguf']);
    const rt = runtime(dir); started.push(rt);
    process.env.FAKE_LLAMA_DELAY_MS = '1200';
    try {
      const loaded = await rtEnsure(rt, dir, 'a-7b.gguf');
      assert.ok(loaded.loadSeconds! >= 1, `待っていない: ${loaded.loadSeconds}秒`);
    } finally {
      delete process.env.FAKE_LLAMA_DELAY_MS;
    }
  });

  test('shutdown で全て解放される', async () => {
    const dir = await modelsDir(['a-7b.gguf', 'b-14b.gguf']);
    const rt = runtime(dir);
    await rtEnsure(rt, dir, 'a-7b.gguf');
    await rtEnsure(rt, dir, 'b-14b.gguf');
    assert.equal(rt.loaded().length, 2);
    await rt.shutdown();
    assert.deepEqual(rt.loaded(), []);
  });
});

async function rtEnsure(rt: LlamaCppRuntime, _dir: string, ref: string) {
  return rt.ensureLoaded(ref);
}
