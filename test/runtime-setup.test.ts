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
import { writeFile } from 'node:fs/promises';
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
    await writeFile(join(dir, 'a.gguf'), 'x');
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
