/**
 * 設定から土台を組むところ。
 *
 * 繋ぐ側（wireInProc）と待つ側（InProcRuntime）が同じ口を向くこと。
 * basePort を設定に書くと、繋ぐ側だけがそれを向き、待つ側は既定の口に
 * 立っていた。永久に繋がらない。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tempDir } from './tmp.ts';
import { buildRuntime } from '../src/core/runtime-setup.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { InProcRuntime } from '../src/runtime/inproc.ts';

const fakeLib = async () => ({
  getLlama: async () => ({
    loadModel: async () => ({ createContext: async () => ({ getSequence: () => ({}), dispose: async () => {} }) }),
  }),
  LlamaChatSession: class { setChatHistory() {} async prompt() { return ''; } },
});

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

describe('この中で読む土台', () => {
  test('設定の basePort に立つ', async () => {
    const dir = await tempDir('aas-rt-');
    await writeFile(join(dir, 'a.gguf'), 'GGUF');
    const port = await freePort();
    const rt = await buildRuntime(
      { ...DEFAULT_CONFIG, runtime: { kind: 'inproc', modelsDir: dir, basePort: port } },
      { gpuName: undefined, ramBytes: 0 } as never,
      undefined,
      { inprocLoad: fakeLib },
    );
    assert.ok(rt instanceof InProcRuntime);
    try {
      const { baseUrl } = await rt.ensureLoaded('a.gguf');
      assert.equal(new URL(baseUrl).port, String(port), '繋ぐ側と違う口に立っている');
    } finally { await rt.shutdown(); }
  });
});

describe('置き場は一つ', () => {
  test('llamacpp も --get・設定画面・doctor と同じ置き場を見る', async () => {
    // ここだけ ~/.aas/models を見ていて、AAS_HOME が別の場所だと
    // 「取ってきたのに『モデルが見つかりません』」になっていた。
    const home = await tempDir('aas-home-');
    await mkdir(join(home, 'models'));
    await writeFile(join(home, 'models', 'a.gguf'), 'GGUF');
    const saved = process.env.AAS_HOME;
    process.env.AAS_HOME = home;
    try {
      const rt = await buildRuntime(
        { ...DEFAULT_CONFIG, runtime: { kind: 'llamacpp', command: 'llama-server' } },
        { gpuName: undefined, ramBytes: 0 } as never,
      );
      const refs = (await rt.list()).map((m) => m.ref);
      assert.deepEqual(refs, ['a.gguf'], `AAS_HOME/models を見ていない: ${refs.join(',')}`);
    } finally {
      if (saved === undefined) delete process.env.AAS_HOME; else process.env.AAS_HOME = saved;
    }
  });
});

describe('既定は、この中で読む', () => {
  test('動かし方を書いていなければ inproc（Ollama ではない）', async () => {
    // 書いていない設定を Ollama 扱いにしていたので、何も入れていない機械で
    // 「Ollama に繋がりません」と出ていた。既定は何も入れずに動く道。
    const rt = await buildRuntime(
      { ...DEFAULT_CONFIG, runtime: {} },
      { gpuName: undefined, ramBytes: 0 } as never,
      undefined,
      { inprocLoad: fakeLib },
    );
    assert.equal(rt.id, 'inproc');
  });
});
