/**
 * 読む側が、実際に何で動いているか（backend）を持ち、言う。
 *
 * nvidia-smi に GPU が見えることと、読む側が GPU を使うことは別。
 * 見えているのに CPU で回り、記憶を使い切って答えなかった（実機。GPU 用の binary を
 * 同梱せず、gpu: false で読んでいた）。使っているものを一行で記録し、選ぶ側もそれを見る。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tempDir } from './tmp.ts';
import { ggufHead } from './gguf-head.ts';
import {
  InProcRuntime, probeBackend, describeBackend, describeSpeed, type LlamaLib,
} from '../src/runtime/inproc.ts';
import { InProcHost, hostArgs } from '../src/runtime/inproc-host-client.ts';

const GB = 1024 ** 3;
const here = dirname(fileURLToPath(import.meta.url));

interface FakeOpts {
  gpu?: 'cuda' | false;
  vram?: number;
  /** getLlama の最中に、向こうが console.warn / console.error に書く文。 */
  warn?: string[];
  error?: string[];
  gpuLayers?: number;
  totalLayers?: number;
  /** 一回の答えで出すトークンの数。 */
  tokens?: number;
  /** 読み終えた入力の数（sequence.nextTokenIndex）。 */
  seen?: number;
  throwOnGetLlama?: Error;
  /** 最初のトークンを出す前に待つ（入力を読んでいる時間の代わり）。 */
  beforeFirstToken?: () => Promise<void>;
}

/** 本物の代わり。getLlama に渡されたものと、createContext に渡されたものを覚える。 */
function fakeLib(o: FakeOpts = {}): LlamaLib & { getLlamaCalls: unknown[]; contexts: unknown[] } {
  const getLlamaCalls: unknown[] = [];
  const contexts: unknown[] = [];
  const lib: LlamaLib & { getLlamaCalls: unknown[]; contexts: unknown[] } = {
    getLlamaCalls,
    contexts,
    getLlama: async (opts) => {
      getLlamaCalls.push(opts);
      for (const w of o.warn ?? []) console.warn(w);
      for (const e of o.error ?? []) console.error(e);
      if (o.throwOnGetLlama) throw o.throwOnGetLlama;
      return {
        ...(o.gpu ? { gpu: o.gpu } : {}),
        getGpuDeviceNames: async () => ['NVIDIA GeForce RTX 4060'],
        getVramState: async () => ({ total: o.vram ?? 0, used: 0, free: o.vram ?? 0 }),
        loadModel: async () => ({
          ...(o.gpuLayers !== undefined ? { gpuLayers: o.gpuLayers } : {}),
          ...(o.totalLayers !== undefined ? { fileInsights: { totalLayers: o.totalLayers } } : {}),
          createContext: async (c) => {
            contexts.push(c);
            return { getSequence: () => ({ nextTokenIndex: o.seen }), dispose: async () => {} };
          },
        }),
      };
    },
    LlamaChatSession: class {
      sequence: unknown;
      constructor(c: { contextSequence: unknown }) { this.sequence = c.contextSequence; }
      setChatHistory() {}
      async prompt(_t: string, p: {
        onTextChunk?: (t: string) => void;
        onResponseChunk?: (c: { type?: string; segmentType?: string; text: string; tokens?: unknown[] }) => void;
      } = {}) {
        await o.beforeFirstToken?.();
        for (let i = 0; i < (o.tokens ?? 3); i += 1) {
          p.onResponseChunk?.({ text: 'は', tokens: [i] });
          p.onTextChunk?.('は');
        }
        return 'は'.repeat(o.tokens ?? 3);
      }
    },
  };
  return lib;
}

const facts = () => ggufHead({
  'general.architecture': 'qwen3',
  'qwen3.context_length': 32768,
  'qwen3.block_count': 4,
  'qwen3.embedding_length': 512,
  'qwen3.attention.head_count': 8,
  'qwen3.attention.head_count_kv': 2,
});

describe('backend を言う', () => {
  test('GPU なら、何で・どの GPU で・VRAM いくつで読むかを一行にする', () => {
    assert.equal(
      describeBackend({ gpu: 'cuda', devices: ['NVIDIA GeForce RTX 4060'], vramBytes: 8 * GB }),
      'GPU で読みます: CUDA（NVIDIA GeForce RTX 4060、VRAM 8.0GB）',
    );
    assert.equal(describeBackend({ gpu: 'vulkan', devices: [], vramBytes: 0 }), 'GPU で読みます: Vulkan（GPU）');
  });

  test('CPU なら、なぜ CPU なのかを添える', () => {
    assert.equal(describeBackend({ gpu: false, devices: [], vramBytes: 0, reason: 'no-binary' }),
      'CPU で読みます（GPU 用の binary が入っていません）');
    assert.equal(describeBackend({ gpu: false, devices: [], vramBytes: 0, reason: 'off' }),
      'CPU で読みます（設定 runtime.gpu が off）');
    assert.match(describeBackend({ gpu: false, devices: [], vramBytes: 0, reason: 'load-failed' }), /読めませんでした/);
    assert.match(describeBackend({ gpu: false, devices: [], vramBytes: 0 }), /見つかりませんでした/);
  });
});

describe('backend を調べる（probeBackend）', () => {
  test('GPU を使えたら、名前と VRAM を持ち帰る。gpu は auto で頼む', async () => {
    const lib = fakeLib({ gpu: 'cuda', vram: 8 * GB });
    const { backend } = await probeBackend(lib);
    assert.deepEqual(backend, { gpu: 'cuda', devices: ['NVIDIA GeForce RTX 4060'], vramBytes: 8 * GB });
    assert.deepEqual(lib.getLlamaCalls, [{ gpu: 'auto', build: 'never', logLevel: 'error' }]);
  });

  /*
   * ライブラリは GPU 用の binary が無いと、console.warn に**直に**
   * 「A prebuilt binary was not found, falling back to …」と何行も書く。
   * 利用者にはそのまま貼られ、壊れているようにしか見えない（実際に言われた）。
   * 黙らせて拾い、理由（無い／読めない）に引き直す。
   */
  test('**向こうの「binary が無い」は表に出さず、理由 no-binary に引き直す**', async () => {
    const leaked: unknown[] = [];
    const warn = console.warn;
    console.warn = (...a: unknown[]) => { leaked.push(a); };
    try {
      const lib = fakeLib({ gpu: false, warn: ['[node-llama-cpp] A prebuilt binary was not found, falling back to using Vulkan', '[node-llama-cpp] A prebuilt binary was not found, falling back to using no GPU'] });
      const { backend } = await probeBackend(lib);
      assert.equal(backend.gpu, false);
      assert.equal(backend.reason, 'no-binary');
      assert.deepEqual(leaked, [], '向こうの声が表に漏れている');
      assert.equal(typeof console.warn, 'function');
    } finally {
      console.warn = warn;
    }
  });

  test('在るのに読めない（ドライバが古い等）は load-failed', async () => {
    const error = console.error;
    console.error = () => {};
    try {
      const lib = fakeLib({ gpu: false, error: ['[node-llama-cpp] Failed to load a prebuilt binary for CUDA, falling back to using no GPU'] });
      const { backend } = await probeBackend(lib);
      assert.equal(backend.reason, 'load-failed');
    } finally {
      console.error = error;
    }
  });

  test('何も言わずに CPU になったなら、GPU が見つからなかった', async () => {
    const { backend } = await probeBackend(fakeLib({ gpu: false }));
    assert.equal(backend.reason, 'no-gpu');
  });

  test('off なら GPU を探させず（gpu: false）、理由は off', async () => {
    const lib = fakeLib({ gpu: false });
    const { backend } = await probeBackend(lib, 'off');
    assert.equal(backend.reason, 'off');
    assert.deepEqual(lib.getLlamaCalls, [{ gpu: false, build: 'never', logLevel: 'error' }]);
  });

  test('getLlama が投げても、console.warn は元に戻す（対）', async () => {
    const warn = console.warn;
    await assert.rejects(() => probeBackend(fakeLib({ throwOnGetLlama: new Error('駄目') })), /駄目/);
    assert.equal(console.warn, warn, 'console.warn を戻していない');
  });
});

describe('runtime は backend を一度だけ調べ、記録し、それで数える', () => {
  test('backend() が一行を記録し、読み込みで getLlama をやり直さない', async () => {
    const dir = await tempDir('aas-be-');
    await writeFile(join(dir, 'a.gguf'), 'GGUF');
    const lib = fakeLib({ gpu: 'cuda', vram: 8 * GB, gpuLayers: 37, totalLayers: 37 });
    const said: string[] = [];
    const rt = new InProcRuntime({ modelsDir: dir, port: 0, load: async () => lib, onLog: (l) => said.push(l) });
    try {
      const b = await rt.backend();
      assert.equal(b.gpu, 'cuda');
      await rt.backend();
      await rt.ensureLoaded('a.gguf');
      assert.equal(lib.getLlamaCalls.length, 1, 'getLlama を何度も呼んでいる');
      assert.equal(said.filter((l) => l.startsWith('GPU で読みます: CUDA（NVIDIA GeForce RTX 4060、VRAM 8.0GB）')).length, 1, said.join(' | '));
      assert.ok(said.includes('GPU に 37/37 層を載せました'), said.join(' | '));
    } finally {
      await rt.shutdown();
    }
  });

  test('載り切らなかった層があるなら、それが遅い理由だと言う', async () => {
    const dir = await tempDir('aas-be-');
    await writeFile(join(dir, 'a.gguf'), 'GGUF');
    const said: string[] = [];
    const rt = new InProcRuntime({ modelsDir: dir, port: 0, load: async () => fakeLib({ gpu: 'cuda', vram: 8 * GB, gpuLayers: 12, totalLayers: 37 }), onLog: (l) => said.push(l) });
    try {
      await rt.ensureLoaded('a.gguf');
      assert.ok(said.some((l) => l.startsWith('GPU に 12/37 層を載せました（載り切らない分は CPU')), said.join(' | '));
    } finally {
      await rt.shutdown();
    }
  });

  test('設定 gpu: off は、そのまま getLlama へ（gpu: false）', async () => {
    const dir = await tempDir('aas-be-');
    await writeFile(join(dir, 'a.gguf'), 'GGUF');
    const lib = fakeLib({ gpu: false });
    const said: string[] = [];
    const rt = new InProcRuntime({ modelsDir: dir, port: 0, gpu: 'off', load: async () => lib, onLog: (l) => said.push(l) });
    try {
      await rt.ensureLoaded('a.gguf');
      assert.deepEqual(lib.getLlamaCalls, [{ gpu: false, build: 'never', logLevel: 'error' }]);
      assert.ok(said.includes('CPU で読みます（設定 runtime.gpu が off）'), said.join(' | '));
    } finally {
      await rt.shutdown();
    }
  });

  /*
   * **KV を数える器は、重みが在る場所。**丸ごと VRAM に載るなら KV も VRAM に置かれる。
   * RAM（32GB）で数えると、8GB の GPU に 32GB ぶんのコンテキストウィンドウを開けようとして落ちる。
   */
  test('**重みが VRAM に丸ごと載るなら、KV は VRAM で数える**', async () => {
    const dir = await tempDir('aas-be-');
    await writeFile(join(dir, 'a.gguf'), facts());
    const said: string[] = [];
    // VRAM が 8GB なら、この小さな模型の 32k × 2 本は楽に載る。
    const wide = fakeLib({ gpu: 'cuda', vram: 8 * GB });
    const rt = new InProcRuntime({ modelsDir: dir, port: 0, load: async () => wide, onLog: (l) => said.push(l) });
    try {
      await rt.ensureLoaded('a.gguf');
      assert.ok(said.some((l) => l.includes('KV は VRAM（8.0GB）で数えました')), said.join(' | '));
      assert.equal((wide.contexts[0] as { contextSize: number }).contextSize, 32768);
    } finally {
      await rt.shutdown();
    }
    // VRAM が 64MB しか無ければ、同じ模型でもコンテキストウィンドウは 32k より狭くなる。
    const narrow = fakeLib({ gpu: 'cuda', vram: 64 * 1024 ** 2 });
    const rt2 = new InProcRuntime({ modelsDir: dir, port: 0, load: async () => narrow });
    try {
      await rt2.ensureLoaded('a.gguf');
      assert.ok((narrow.contexts[0] as { contextSize: number }).contextSize < 32768, JSON.stringify(narrow.contexts));
    } finally {
      await rt2.shutdown();
    }
  });

  test('CPU なら、KV は記憶で数える（対）', async () => {
    const dir = await tempDir('aas-be-');
    await writeFile(join(dir, 'a.gguf'), facts());
    const said: string[] = [];
    const rt = new InProcRuntime({ modelsDir: dir, port: 0, load: async () => fakeLib({ gpu: false }), onLog: (l) => said.push(l) });
    try {
      await rt.ensureLoaded('a.gguf');
      assert.ok(!said.some((l) => l.includes('KV は VRAM')), said.join(' | '));
    } finally {
      await rt.shutdown();
    }
  });
});

describe('一回の答えの速さを記録に出す', () => {
  test('入力と出力を分けて、秒と tok/s にする', () => {
    assert.equal(
      describeSpeed({ started: 0, firstAt: 2000, ended: 4000, seen: 100, generated: 40 }),
      '答えました: 入力 100 トークン（2.0 秒・50.0 tok/s）、出力 40 トークン（2.0 秒・20.0 tok/s）',
    );
  });

  test('入力の数が分からなければ、最初の 1 トークンまでの秒だけ', () => {
    assert.equal(
      describeSpeed({ started: 0, firstAt: 1500, ended: 1500, generated: 0 }),
      '答えました: 最初の 1 トークンまで 1.5 秒、出力 0 トークン（0.0 秒・0.0 tok/s）',
    );
  });

  test('流して答えた後に、一行出る', async () => {
    const dir = await tempDir('aas-be-');
    await writeFile(join(dir, 'a.gguf'), 'GGUF');
    const said: string[] = [];
    const rt = new InProcRuntime({ modelsDir: dir, port: 0, load: async () => fakeLib({ gpu: false, tokens: 3, seen: 5 }), onLog: (l) => said.push(l) });
    try {
      const { baseUrl } = await rt.ensureLoaded('a.gguf');
      const r = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'a.gguf', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
        signal: AbortSignal.timeout(10_000),
      });
      await r.text();
      const line = said.find((l) => l.startsWith('答えました: '));
      assert.ok(line, said.join(' | '));
      assert.match(line, /入力 5 トークン/);
      assert.match(line, /出力 3 トークン/);
    } finally {
      await rt.shutdown();
    }
  });
});

describe('入力を読んでいる間も黙らない', () => {
  /*
   * 最初のトークンまで一バイトも書かないと、Node の fetch（undici）は本文の無音
   * 300 秒で切る。CPU で長い入力を読む実機では、三回とも 300 秒で切れて落ちた。
   * 並んでいる間の `: queued` と同じ間隔で `: working` を打ち、最初のトークンが
   * 出たら止める。
   */
  test('**最初のトークンまで `: working` を打ち続け、出たら止める**', async () => {
    const dir = await tempDir('aas-be-');
    await writeFile(join(dir, 'a.gguf'), 'GGUF');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const lib = fakeLib({ gpu: false, tokens: 2, beforeFirstToken: () => gate });
    const rt = new InProcRuntime({ modelsDir: dir, port: 0, queueHeartbeatMs: 10, load: async () => lib });
    try {
      const { baseUrl } = await rt.ensureLoaded('a.gguf');
      const r = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'a.gguf', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
        signal: AbortSignal.timeout(10_000),
      });
      const reader = r.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';
      let released = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        // 読んでいる間（最初のトークン前）に、二回以上打っているのを見てから、出させる。
        if (!released && (text.match(/^: working$/gm) ?? []).length >= 2) { released = true; release(); }
      }
      assert.ok(released, `出す前に \`: working\` が二回来なかった:\n${text}`);
      const lastBeat = text.lastIndexOf(': working');
      const firstToken = text.indexOf('"content":"は"');
      assert.ok(firstToken > 0, text);
      assert.ok(lastBeat < firstToken, `最初のトークンの後にも打っている:\n${text}`);
      assert.ok(text.includes('data: [DONE]'), text);
    } finally {
      release();
      await rt.shutdown();
    }
  });
});

describe('別のプロセスでも backend が分かる', () => {
  test('--gpu は子へそのまま渡す', () => {
    const args = hostArgs({ modelsDir: '/m', gpu: 'off' });
    assert.ok(args.includes('--gpu') && args[args.indexOf('--gpu') + 1] === 'off', args.join(' '));
    assert.ok(!hostArgs({ modelsDir: '/m' }).includes('--gpu'), '渡していないのに付けている');
  });

  test('/control/backend 越しに、子の backend と記録が届く', async () => {
    const dir = await tempDir('aas-be-host-');
    await writeFile(join(dir, 'a.gguf'), 'GGUF');
    const said: string[] = [];
    const host = new InProcHost({ modelsDir: dir, port: 0, lib: join(here, 'fake-llama-lib-gpu.ts'), onLog: (l) => said.push(l) });
    try {
      const b = await host.backend();
      assert.equal(b.gpu, 'cuda');
      assert.equal(b.vramBytes, 8 * GB);
      assert.deepEqual(b.devices, ['NVIDIA GeForce RTX 4060']);
      assert.ok(said.some((l) => l.startsWith('GPU で読みます: CUDA')), said.join(' | '));
    } finally {
      await host.shutdown().catch(() => undefined);
    }
  });
});
