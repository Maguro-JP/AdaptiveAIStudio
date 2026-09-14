/**
 * 画面は、**読む側が実際に使う backend と VRAM** でモデルを選ぶ。
 *
 * nvidia-smi に GPU が見えるかどうかで決めていた。読む側は CPU で回っていて、
 * VRAM も数えないので、8GB の GPU に 20GB のモデルを選び、記憶を使い切って
 * 答えなかった（実機）。ここでは backend が「CUDA・VRAM いくつ」と言う
 * モックを渡し、VRAM に丸ごと載るものが選ばれることを、送って読むところまで見る。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tempDir } from './tmp.ts';
import { until } from './until.ts';

const dir = await tempDir('aas-choose-be-');
process.env.AAS_HOME = dir;
process.env.AAS_STATE_DIR = join(dir, 'state');
process.env.AAS_CONFIG = join(dir, 'aas.config.json');
const { UiServer } = await import('../src/ui/server.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');

const MB = 1024 ** 2;

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

/** 読んだものを覚え、backend は CUDA・VRAM `vram` バイトと言うモック。 */
function fakeLoad(vram: number, loadedPaths: string[]) {
  return async () => ({
    getLlama: async () => ({
      gpu: 'cuda',
      getGpuDeviceNames: async () => ['NVIDIA GeForce RTX 4060'],
      getVramState: async () => ({ total: vram, used: 0, free: vram }),
      loadModel: async (o: { modelPath: string }) => {
        loadedPaths.push(o.modelPath);
        return { createContext: async () => ({ getSequence: () => ({}), dispose: async () => {} }) };
      },
    }),
    LlamaChatSession: class {
      setChatHistory() {}
      async prompt(_t: string, o: { onTextChunk?: (t: string) => void } = {}) { o.onTextChunk?.('はい'); return 'はい'; }
    },
  });
}

async function firstLoaded(vram: number): Promise<string[]> {
  const models = await tempDir('aas-choose-be-models-');
  // 2MB と 4 バイト。どちらも記憶には載る。VRAM の八割に載るかで分かれる。
  await writeFile(join(models, 'big.gguf'), Buffer.concat([Buffer.from('GGUF'), Buffer.alloc(2 * MB)]));
  await writeFile(join(models, 'small.gguf'), 'GGUF');
  const port = await freePort();
  const loadedPaths: string[] = [];
  const s = new UiServer({
    port: 0, inprocLoad: fakeLoad(vram, loadedPaths),
    config: {
      ...DEFAULT_CONFIG,
      providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1`, locality: 'local', models: ['big.gguf', 'small.gguf'] }],
      // model は名指ししない。自動で選ぶところを見る。
      runtime: { kind: 'inproc', modelsDir: models, basePort: port },
      initiative: { enabled: false },
    } as typeof DEFAULT_CONFIG,
  });
  const base = (await s.start()).replace(/\/$/, '');
  try {
    const r = await fetch(`${base}/api/send`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'x' }),
      signal: AbortSignal.timeout(8000),
    });
    const { conversationId } = await r.json() as { conversationId: string };
    await until(async () => {
      const m = await (await fetch(`${base}/api/conversations/messages?id=${conversationId}`)).json() as { messages: { role: string }[] };
      return m.messages.some((x) => x.role === 'assistant');
    }, '答える', { timeoutMs: 20_000, everyMs: 100 });
    return loadedPaths.map((p) => p.split(/[\\/]/).at(-1) ?? p);
  } finally {
    await s.stop();
  }
}

describe('画面は、読む側の backend と VRAM でモデルを選ぶ', () => {
  test('**VRAM に丸ごと載るもののうち大きい方**（2MB は 1MB の VRAM に載らない → small）', async () => {
    assert.deepEqual(await firstLoaded(1 * MB), ['small.gguf']);
  });

  test('VRAM が足りるなら、大きい方（対）', async () => {
    assert.deepEqual(await firstLoaded(4 * MB), ['big.gguf']);
  });
});
