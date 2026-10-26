/**
 * GPU で読めなかったら、CPU で読み直して答える。
 *
 * GPU の部品は起きても、重みや KV を載せる所で落ちる機械がある（ドライバ、VRAM）。
 * そこで止めると、利用者には「動かない」としか見えない。
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { tempDir } from './tmp.ts';
import { InProcRuntime } from '../src/runtime/inproc.ts';

const running: InProcRuntime[] = [];
afterEach(async () => { for (const r of running.splice(0)) await r.shutdown(); });

function lib(gpuLoad: 'fails' | 'works') {
  const asked: (string | false)[] = [];
  const load = async () => ({
    getLlama: async (o: { gpu?: false | string } = {}) => {
      const gpu = o.gpu === false ? false : 'cuda';
      return {
        gpu,
        getGpuDeviceNames: async () => ['GPU'],
        getVramState: async () => ({ total: 8 * 1024 ** 3, used: 0, free: 8 * 1024 ** 3 }),
        loadModel: async () => {
          asked.push(gpu);
          if (gpu && gpuLoad === 'fails') throw new Error('ggml_cuda_init: failed');
          return { createContext: async () => ({ getSequence: () => ({}), dispose: async () => {} }), dispose: async () => {} };
        },
      };
    },
    LlamaChatSession: class {
      setChatHistory() {}
      async prompt() { return 'ok'; }
    },
  });
  return { load, asked };
}

async function runtime(l: ReturnType<typeof lib>, said: string[]) {
  const dir = await tempDir('aas-gpufb-');
  await writeFile(join(dir, 'a.gguf'), 'x');
  const rt = new InProcRuntime({ modelsDir: dir, port: 0, load: l.load, contextSize: 4096, sequences: 1, onLog: (s: string) => said.push(s) } as ConstructorParameters<typeof InProcRuntime>[0]);
  running.push(rt);
  return rt;
}

test('GPU で読めなければ CPU で読み直し、以後は CPU のまま', async () => {
  const l = lib('fails');
  const said: string[] = [];
  const rt = await runtime(l, said);
  const got = await rt.ensureLoaded('a.gguf');
  assert.equal(got.model, 'a.gguf');
  assert.deepEqual(l.asked, ['cuda', false]);
  assert.ok(said.some((s) => s.includes('CPU で読み直します') && s.includes('ggml_cuda_init')), said.join('\n'));
  assert.equal((await rt.backend()).gpu, false);
});

test('GPU で読めるなら GPU のまま（読み直さない）', async () => {
  const l = lib('works');
  const rt = await runtime(l, []);
  await rt.ensureLoaded('a.gguf');
  assert.deepEqual(l.asked, ['cuda']);
});
