/**
 * 先読み（token predictor）を付けない。
 *
 * 本物の重みで、先読みが入力の数字を答えに混ぜた（「1 から 15 まで」で `let i = 15` と書いた）。
 * ライブラリが先読みを持っていても、sequence には渡さないことを見る。
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { tempDir } from './tmp.ts';
import { InProcRuntime } from '../src/runtime/inproc.ts';

const running: InProcRuntime[] = [];
afterEach(async () => { for (const r of running.splice(0)) await r.shutdown(); });

test('ライブラリに先読みがあっても、sequence には渡さない', async () => {
  const seen: unknown[] = [];
  const load = async () => ({
    getLlama: async () => ({
      loadModel: async () => ({
        createContext: async () => ({ getSequence: (o?: unknown) => { seen.push(o); return {}; }, dispose: async () => {} }),
        dispose: async () => {},
      }),
    }),
    InputLookupTokenPredictor: class {},
    LlamaChatSession: class { setChatHistory() {} async prompt() { return 'ok'; } },
  });
  const dir = await tempDir('aas-nopred-');
  await writeFile(join(dir, 'a.gguf'), 'x');
  const rt = new InProcRuntime({ modelsDir: dir, port: 0, load, contextSize: 4096, sequences: 2 } as ConstructorParameters<typeof InProcRuntime>[0]);
  running.push(rt);
  await rt.ensureLoaded('a.gguf');
  assert.equal(seen.length, 2);
  for (const o of seen) assert.ok(!(o as { tokenPredictor?: unknown } | undefined)?.tokenPredictor, '先読みを渡している');
});
