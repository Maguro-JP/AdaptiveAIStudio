/**
 * このプログラムの中でモデルを読む道。
 *
 * 二つ目の実行ファイルを置けない機械では、これだけが道になる。
 * 本物のライブラリと GGUF は用意できないので、読み込みは差し替える。
 * **偶然通っている試験にしない。**差し替えたことが分かる形で書く。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
import { tempDir } from './tmp.ts';
import { InProcRuntime, listGguf, chooseModel, MAX_WINDOW, SAFE_WINDOW, fitWindow } from '../src/runtime/inproc.ts';
import { ggufHead } from './gguf-head.ts';

/**
 * 本物の代わり。読んだことにして、決まった返事をする。
 * 渡された履歴と、いま訊かれたことを覚えておき、試験から見る。
 */
interface Spy { history: unknown[]; asked: string; opts: Record<string, unknown> }

function fakeLib(said = 'こんにちは'): { load: () => Promise<unknown>; spy: Spy } {
  const spy: Spy = { history: [], asked: '', opts: {} };
  const load = async () => ({
    getLlama: async () => ({
      loadModel: async () => ({
        createContext: async () => ({ getSequence: () => ({}), dispose: async () => {} }),
      }),
    }),
    LlamaChatSession: class {
      setChatHistory(h: unknown[]) { spy.history = h; }
      async prompt(text: string, o: { onTextChunk?: (t: string) => void } = {}) {
        spy.asked = text;
        spy.opts = o as Record<string, unknown>;
        // 本物は少しずつ返す。**分けて渡すところ**まで真似ないと、
        // 流して返す道が試験を素通りする。
        for (const part of [...said]) o.onTextChunk?.(part);
        return said;
      }
    },
  });
  return { load, spy };
}

/** SSE を読んで、文字だけを繋ぐ。上の層（provider）と同じ読み方。 */
async function readStream(res: Response): Promise<{ text: string; done: boolean }> {
  const raw = await res.text();
  let text = '';
  let done = false;
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6).trim();
    if (data === '[DONE]') { done = true; continue; }
    const parsed = JSON.parse(data) as { choices: { delta: { content?: string } }[] };
    text += parsed.choices[0]?.delta?.content ?? '';
  }
  return { text, done };
}

describe('置き場の GGUF を見つける', () => {
  test('名前は問わない。拡張子だけで選ぶ', async () => {
    const dir = await tempDir('aas-gguf-');
    await writeFile(join(dir, 'qwen2.5-3b-instruct-q4_k_m.gguf'), 'GGUF');
    await writeFile(join(dir, 'メモ.txt'), 'x');
    await mkdir(join(dir, 'sub'));
    const got = await listGguf(dir);
    assert.deepEqual(got.map((m) => m.ref), ['qwen2.5-3b-instruct-q4_k_m.gguf']);
    assert.equal(got[0]!.sizeBytes, 4);
  });

  test('置き場が無くても落ちない', async () => {
    assert.deepEqual(await listGguf('/そんな場所は無い'), []);
  });
});

describe('中で読む', () => {
  test('OpenAI 互換の口が、自分の中に立つ', async () => {
    const dir = await tempDir('aas-inproc-');
    await writeFile(join(dir, 'm.gguf'), 'GGUF');
    const { load } = fakeLib('はい');
    const rt = new InProcRuntime({ modelsDir: dir, port: 0, load });
    const loaded = await rt.ensureLoaded('m.gguf');

    // 外に出る口を増やさない。127.0.0.1 だけ。
    assert.match(loaded.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    assert.equal(loaded.model, 'm.gguf');

    // **上の層は必ず stream: true で呼ぶ。**普通の JSON を返すと動かない。
    const r = await fetch(`${loaded.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'm.gguf', stream: true,
        messages: [{ role: 'user', content: 'やあ' }],
      }),
    });
    assert.match(r.headers.get('content-type') ?? '', /text\/event-stream/);
    const got = await readStream(r);
    assert.equal(got.text, 'はい');
    assert.equal(got.done, true, '[DONE] で閉じていない');

    await rt.shutdown();
    assert.deepEqual(rt.loaded(), []);
  });

  test('名前が食い違っても、一つしか無いならそれで答える', async () => {
    // 上の層が言ってくる名前は、候補の決め方によって GGUF の名前と
    // 一致しないことがある。一つしか読んでいないなら、それで答える。
    // ただし**黙って替えない**。替えたことは記録に出す。
    const dir = await tempDir('aas-inproc2-');
    await writeFile(join(dir, 'm.gguf'), 'GGUF');
    const said: string[] = [];
    const rt = new InProcRuntime({
      modelsDir: dir, port: 0, load: fakeLib('はい').load, onLog: (l) => said.push(l),
    });
    const { baseUrl } = await rt.ensureLoaded('m.gguf');
    const r = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'よその.gguf', stream: true, messages: [{ role: 'user', content: 'や' }] }),
    });
    assert.equal(r.status, 200);
    assert.equal((await readStream(r)).text, 'はい');
    assert.ok(said.some((l) => l.includes('よその.gguf')), '替えたことを言っていない');
    await rt.shutdown();
  });

  test('読み込んでいなければ、そう言う', async () => {
    const dir = await tempDir('aas-inproc3-');
    await writeFile(join(dir, 'a.gguf'), 'GGUF');
    await writeFile(join(dir, 'b.gguf'), 'GGUF');
    const rt = new InProcRuntime({ modelsDir: dir, port: 0, load: fakeLib().load });
    const { baseUrl } = await rt.ensureLoaded('a.gguf');
    await rt.ensureLoaded('b.gguf');
    // 二つ読んでいるので、どれを指しているか決められない。勝手に選ばない。
    const r = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'よその.gguf', messages: [] }),
    });
    assert.equal(r.status, 400);
    await rt.shutdown();
  });

  test('ライブラリが無いときは、無いと言う', async () => {
    const rt = new InProcRuntime({
      modelsDir: '/tmp',
      load: () => Promise.reject(new Error('Cannot find module')),
    });
    await assert.rejects(() => rt.ensureLoaded('m.gguf'), /node-llama-cpp/);
  });
});

describe('設定でつながっている', () => {
  test('kind: inproc で、中で読む形になる', async () => {
    const { buildRuntime } = await import('../src/core/runtime-setup.ts');
    const rt = await buildRuntime(
      { providers: [], runtime: { kind: 'inproc', modelsDir: '/tmp' } } as never,
      { vramBytes: 0, ramBytes: 0 } as never,
    );
    assert.equal(rt.id, 'inproc');
  });
});

describe('上の層が呼ぶとおりに答える', () => {
  test('履歴と、いま訊いていることを、分けて渡す', async () => {
    // 上の層は毎回すべての履歴を送ってくる。最後の user が「いま訊いて
    // いること」で、それを履歴にも入れると同じことを二度言うことになる。
    const dir = await tempDir('aas-hist-');
    await writeFile(join(dir, 'm.gguf'), 'GGUF');
    const { load, spy } = fakeLib('ok');
    const rt = new InProcRuntime({ modelsDir: dir, port: 0, load });
    const { baseUrl } = await rt.ensureLoaded('m.gguf');

    await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'm.gguf', stream: true, temperature: 0.2, max_tokens: 128,
        messages: [
          { role: 'system', content: '日本語で答える' },
          { role: 'user', content: '一つめ' },
          { role: 'assistant', content: 'はい' },
          { role: 'user', content: 'ふたつめ' },
        ],
      }),
    }).then(readStream);

    assert.equal(spy.asked, 'ふたつめ');
    assert.deepEqual(spy.history, [
      { type: 'system', text: '日本語で答える' },
      { type: 'user', text: '一つめ' },
      { type: 'model', response: ['はい'] },
    ]);
    // 設定した値を捨てない。
    assert.equal(spy.opts.temperature, 0.2);
    assert.equal(spy.opts.maxTokens, 128);
    await rt.shutdown();
  });

  test('繋がるかの確認に答える', async () => {
    // provider は /models を叩いて生死を見る。404 を返すと死んで見える。
    const dir = await tempDir('aas-mdl-');
    await writeFile(join(dir, 'm.gguf'), 'GGUF');
    const rt = new InProcRuntime({ modelsDir: dir, port: 0, load: fakeLib().load });
    const { baseUrl } = await rt.ensureLoaded('m.gguf');
    const r = await fetch(`${baseUrl}/models`);
    assert.equal(r.status, 200);
    const body = await r.json() as { data: { id: string }[] };
    assert.deepEqual(body.data.map((m) => m.id), ['m.gguf']);
    await rt.shutdown();
  });

  test('stream: false なら、まとめて返す', async () => {
    const dir = await tempDir('aas-once-');
    await writeFile(join(dir, 'm.gguf'), 'GGUF');
    const rt = new InProcRuntime({ modelsDir: dir, port: 0, load: fakeLib('まとめて').load });
    const { baseUrl } = await rt.ensureLoaded('m.gguf');
    const r = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm.gguf', stream: false, messages: [{ role: 'user', content: 'や' }] }),
    });
    const body = await r.json() as { choices: { message: { content: string } }[] };
    assert.equal(body.choices[0]!.message.content, 'まとめて');
    await rt.shutdown();
  });
});

describe('繋ぎ先を、利用者に書かせない', () => {
  test('この中で読む設定なら、繋ぎ先はこちらで埋める', async () => {
    // 口はこのプログラムの中に立つ。番号は毎回変わってはいけないし、
    // 利用者に書かせると、間違えたときに「繋がりません」とだけ出て終わる。
    const { loadConfig } = await import('../src/config.ts');
    const { INPROC_PORT } = await import('../src/runtime/inproc.ts');
    const dir = await tempDir('aas-wire-');
    const at = join(dir, 'aas.config.json');
    await writeFile(at, JSON.stringify({ runtime: { kind: 'inproc' } }));
    process.env.AAS_CONFIG = at;
    const { config } = loadConfig();
    const local = config.providers.find((p) => p.locality === 'local');
    assert.equal(local?.baseUrl, `http://127.0.0.1:${INPROC_PORT}/v1`);
    delete process.env.AAS_CONFIG;
  });

  test('番号を決めているなら、そちらに合わせる', async () => {
    const { loadConfig } = await import('../src/config.ts');
    const dir = await tempDir('aas-wire2-');
    const at = join(dir, 'aas.config.json');
    await writeFile(at, JSON.stringify({ runtime: { kind: 'inproc', basePort: 4321 } }));
    process.env.AAS_CONFIG = at;
    const { config } = loadConfig();
    assert.equal(config.providers.find((p) => p.locality === 'local')?.baseUrl,
      'http://127.0.0.1:4321/v1');
    delete process.env.AAS_CONFIG;
  });

  test('他の道では、繋ぎ先に触らない', async () => {
    const { loadConfig } = await import('../src/config.ts');
    const dir = await tempDir('aas-wire3-');
    const at = join(dir, 'aas.config.json');
    await writeFile(at, JSON.stringify({ runtime: { kind: 'ollama' } }));
    process.env.AAS_CONFIG = at;
    const { config } = loadConfig();
    assert.match(config.providers.find((p) => p.locality === 'local')?.baseUrl ?? '', /11434/);
    delete process.env.AAS_CONFIG;
  });
});

describe('読み込みの進み具合を言う', () => {
  test('黙って待たせない', async () => {
    // 数GBを読むので 10〜60秒かかる。何も言わないと固まったように見える。
    const dir = await tempDir('aas-prog-');
    await writeFile(join(dir, 'm.gguf'), 'GGUF');
    const said: string[] = [];
    const load = async () => ({
      getLlama: async () => ({
        loadModel: async (o: { onLoadProgress?: (d: number) => void }) => {
          for (const d of [0, 0.05, 0.2, 0.55, 1]) o.onLoadProgress?.(d);
          return { createContext: async () => ({ getSequence: () => ({}), dispose: async () => {} }) };
        },
      }),
      LlamaChatSession: class { setChatHistory() {} async prompt() { return ''; } },
    });
    const rt = new InProcRuntime({ modelsDir: dir, port: 0, load, onLog: (l) => said.push(l) });
    await rt.ensureLoaded('m.gguf');
    await rt.shutdown();

    const pcts = said.filter((l) => l.includes('読み込み中'));
    assert.ok(pcts.length >= 3, `進み具合が出ていない: ${said.join(' / ')}`);
    // 細かすぎると流れが埋まる。5回すべては出さない。
    assert.ok(pcts.length <= 4, `細かすぎる: ${pcts.join(' / ')}`);
    assert.ok(said.some((l) => l.includes('読み込み中 100%')), '終わりまで言っていない');
  });
});

describe('GGUF を置く道を、ひとまとめに見る', () => {
  test('llamacpp と inproc は、どちらも GGUF の道', async () => {
    // 片方だけを見る分岐を書くと、もう片方を足したときに置き去りになる。
    // 実際に「モデルを取ってくる」が inproc のとき Ollama を叩いていた。
    const { usesGguf } = await import('../src/runtime/local-runtime.ts');
    assert.equal(usesGguf('llamacpp'), true);
    assert.equal(usesGguf('inproc'), true);
    assert.equal(usesGguf('ollama'), false);
  });

  test('どちらか一方だけを見る分岐が残っていない', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { installRoot } = await import('../src/core/home.ts');
    for (const rel of [['src', 'cli', 'models.ts'], ['src', 'ui', 'server.ts']]) {
      const src = await readFile(join(installRoot(), ...rel), 'utf8');
      const bad = src.split('\n').filter((l) => /runtime\.id [!=]== 'llamacpp'/.test(l));
      assert.deepEqual(bad, [], `${rel.join('/')} に片方だけの分岐が残っている`);
    }
  });
});

describe('名指しされた GGUF に切り替える', () => {
  test('置き場に在る別の GGUF を頼まれたら、解いて読み替える', async () => {
    const dir = await tempDir('aas-switch-');
    await writeFile(join(dir, 'a.gguf'), 'GGUF');
    await writeFile(join(dir, 'b.gguf'), 'GGUF');
    const { load } = fakeLib('こんにちは');
    const rt = new InProcRuntime({ modelsDir: dir, port: 0, load });
    try {
      const { baseUrl } = await rt.ensureLoaded('a.gguf');
      const r = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'b.gguf', messages: [{ role: 'user', content: 'x' }], stream: false }),
      });
      assert.equal(r.status, 200);
      // 二つ同時に持たない。a は解かれ、b だけが残る。
      assert.deepEqual(rt.loaded(), ['b.gguf']);
    } finally { await rt.shutdown(); }
  });

  test('置き場に無い名前なら、読んでいる一つで答える（対）', async () => {
    const dir = await tempDir('aas-switch-');
    await writeFile(join(dir, 'a.gguf'), 'GGUF');
    const { load } = fakeLib('こんにちは');
    const rt = new InProcRuntime({ modelsDir: dir, port: 0, load });
    try {
      const { baseUrl } = await rt.ensureLoaded('a.gguf');
      const r = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'zzz.gguf', messages: [{ role: 'user', content: 'x' }], stream: false }),
      });
      assert.equal(r.status, 200);
      assert.deepEqual(rt.loaded(), ['a.gguf']);
    } finally { await rt.shutdown(); }
  });
});

describe('文脈の大きさを決めておく', () => {
  async function libRecording(seen: unknown[]) {
    return {
      getLlama: async () => ({
        loadModel: async () => ({
          createContext: async (o?: unknown) => { seen.push(o); return { getSequence: () => ({}), dispose: async () => {} }; },
        }),
      }),
      LlamaChatSession: class { setChatHistory() {} async prompt() { return ''; } },
    };
  }
  test('**諸元が揃っていれば、モデルが持っている窓を使う**', async () => {
    const dir = await tempDir('aas-ctx-');
    await writeFile(join(dir, 'a.gguf'), ggufHead({
      'general.architecture': 'qwen3',
      'qwen3.context_length': 32768,
      'qwen3.block_count': 4,
      'qwen3.embedding_length': 512,
      'qwen3.attention.head_count': 8,
      'qwen3.attention.head_count_kv': 2,
    }));
    const seen: unknown[] = [];
    const rt = new InProcRuntime({ modelsDir: dir, port: 0, load: () => libRecording(seen) });
    try { await rt.ensureLoaded('a.gguf'); } finally { await rt.shutdown(); }
    assert.deepEqual(seen, [{ contextSize: 32768 }]);
  });

  test('**窓の値しか読めなければ、広げない**', async () => {
    // 層数や head 数の鍵は、アーキテクチャごとに名前が違う。読めないことがある。
    const dir = await tempDir('aas-ctx-');
    await writeFile(join(dir, 'a.gguf'), ggufHead({
      'general.architecture': 'qwen3', 'qwen3.context_length': 32768,
    }));
    const seen: unknown[] = [];
    const rt = new InProcRuntime({ modelsDir: dir, port: 0, load: () => libRecording(seen) });
    try { await rt.ensureLoaded('a.gguf'); } finally { await rt.shutdown(); }
    assert.deepEqual(seen, [{ contextSize: SAFE_WINDOW }],
      '記憶を数えられないのに広げている');
  });

  test('大きすぎる窓は、上限で止める（記憶を食い切らせない）', async () => {
    const dir = await tempDir('aas-ctx-');
    await writeFile(join(dir, 'a.gguf'), ggufHead({
      'general.architecture': 'llama',
      'llama.context_length': 1_048_576,
      'llama.block_count': 4,
      'llama.embedding_length': 512,
      'llama.attention.head_count': 8,
      'llama.attention.head_count_kv': 2,
    }));
    const seen: unknown[] = [];
    const rt = new InProcRuntime({ modelsDir: dir, port: 0, load: () => libRecording(seen) });
    try { await rt.ensureLoaded('a.gguf'); } finally { await rt.shutdown(); }
    assert.deepEqual(seen, [{ contextSize: MAX_WINDOW }]);
  });

  test('設定が在れば、そちらが勝つ', async () => {
    const dir = await tempDir('aas-ctx-');
    await writeFile(join(dir, 'a.gguf'), ggufHead({
      'general.architecture': 'qwen3', 'qwen3.context_length': 32768,
    }));
    const seen: unknown[] = [];
    const rt = new InProcRuntime({ modelsDir: dir, port: 0, contextSize: 4096, load: () => libRecording(seen) });
    try { await rt.ensureLoaded('a.gguf'); } finally { await rt.shutdown(); }
    assert.deepEqual(seen, [{ contextSize: 4096 }]);
  });

  test('読めないファイルなら、既定に落とす', async () => {
    const dir = await tempDir('aas-ctx-');
    await writeFile(join(dir, 'a.gguf'), 'GGUF');
    const seen: unknown[] = [];
    const rt = new InProcRuntime({ modelsDir: dir, port: 0, load: () => libRecording(seen) });
    try { await rt.ensureLoaded('a.gguf'); } finally { await rt.shutdown(); }
    assert.deepEqual(seen, [{ contextSize: 8192 }]);
  });
  test('設定で広げられる（対）', async () => {
    const dir = await tempDir('aas-ctx-');
    await writeFile(join(dir, 'a.gguf'), 'GGUF');
    const seen: unknown[] = [];
    const rt = new InProcRuntime({ modelsDir: dir, port: 0, contextSize: 32768, load: () => libRecording(seen) });
    try { await rt.ensureLoaded('a.gguf'); } finally { await rt.shutdown(); }
    assert.deepEqual(seen, [{ contextSize: 32768 }]);
  });
});

describe('記憶に載らないものを読みに行かない', () => {
  test('記憶より大きければ、そう言う', async () => {
    const { tooBigForRam } = await import('../src/runtime/inproc.ts');
    const GB = 1024 ** 3;
    assert.match(tooBigForRam(30 * GB, 16 * GB) ?? '', /大きすぎます/);
  });
  test('載るなら何も言わない（対）', async () => {
    const { tooBigForRam } = await import('../src/runtime/inproc.ts');
    const GB = 1024 ** 3;
    assert.equal(tooBigForRam(4 * GB, 16 * GB), undefined);
    assert.equal(tooBigForRam(undefined, 16 * GB), undefined, '大きさが分からないものは止めない');
  });
});

/**
 * 窓は、そのまま記憶（KV）になる。
 *
 * **広げた分を数えずに広げない。**8B のモデルで 8k から 32k へ広げると、
 * それだけで 3.4GB 増える（重み 5GB + KV 4.5GB = 9.5GB）。
 * 16GB の機械では、他が何も動かなくなる。
 */
describe('窓を、この機械の記憶に合わせる', () => {
  const GB = 1024 ** 3;
  /** Qwen3 8B 相当（層36・埋め4096・頭32・KV頭8・重み5GB）。 */
  const big = { trained: 32768, layers: 36, embedding: 4096, heads: 32, kvHeads: 8, weightBytes: 5 * GB };

  test('余裕があれば、モデルの窓をそのまま使う', () => {
    const got = fitWindow({ ...big, ramBytes: 64 * GB });
    assert.equal(got.window, 32768);
    assert.equal(got.why, undefined);
  });

  test('16GB なら、8B でもそのまま入る（狭めない）', () => {
    // 重み 5GB + KV 4.8GB = 9.8GB。7 割（11.2GB）に収まる。
    assert.equal(fitWindow({ ...big, ramBytes: 16 * GB }).window, 32768);
  });

  test('**足りなければ狭める。**しかも、なぜ狭めたかを言う', () => {
    // 8GB の機械。重み 5GB を引くと、KV に使えるのは 0.6GB しか無い。
    const got = fitWindow({ ...big, ramBytes: 8 * GB });
    assert.ok(got.window < 32768, `狭めていない: ${got.window}`);
    assert.ok(got.window >= 4096, `狭めすぎ: ${got.window}`);
    assert.match(got.why ?? '', /狭めました/);
    const perToken = 2 * 36 * (4096 / 32) * 8 * 2;
    assert.ok(5 * GB + got.window * perToken <= 8 * GB * 0.7 + perToken * 4096,
      `収まっていない: 窓 ${got.window}`);
  });

  test('狭くしすぎない（決まりだけで溢れる）', () => {
    // 記憶が足りていない機械。ここで 0 にすると、何も動かない。
    assert.equal(fitWindow({ ...big, ramBytes: 6 * GB }).window, 4096);
  });

  /*
   * ここは「読めないモデルほど不利にしない」として、諸元が読めないときに
   * `trained` をそのまま通していた。**判断を覆した。**
   *
   * KV の大きさを計算できないだけで、KV が要らなくなるわけではない。
   * 上の例は 4GB の機械に 32768 を渡していて、そのまま読ませれば
   * 追い出しが起きて読み込みが終わらない。
   */
  test('**諸元が読めないときは、広げない**（記憶を数えられないので）', () => {
    const got = fitWindow({ trained: 32768, ramBytes: 4 * GB });
    assert.equal(got.window, SAFE_WINDOW, `記憶を数えずに広げている: ${got.window}`);
    assert.match(got.why ?? '', /読めない/);
  });

  test('モデルの窓より広げはしない', () => {
    const got = fitWindow({ trained: 4096, layers: 4, embedding: 512, heads: 8, ramBytes: 64 * GB });
    assert.equal(got.window, 4096);
  });
});

describe('どの GGUF を読むか', () => {
  /**
   * ここは名前で並べた先頭を無条件で選んでいた。検証用に大小いくつも
   * 置いてある保存先では、**たまたま名前が前に来た大きいほう**が選ばれる。
   * 記憶に辛うじて載る大きさだと、追い出しが起きて読み込みが終わらない。
   * 小さいものが同じフォルダに在っても見なかった。
   */
  const GB = 1024 ** 3;
  const ram = 16 * GB;

  test('**名前の順ではなく、記憶に載るものを選ぶ**', () => {
    // 名前は a が先。だが 14GB は 16GB の機械には載らない（0.85 で 13.6GB まで）。
    const got = chooseModel([
      { ref: 'a-big.gguf', sizeBytes: 14 * GB },
      { ref: 'z-small.gguf', sizeBytes: 2 * GB },
    ], ram);
    assert.equal(got?.chosen.ref, 'z-small.gguf');
    assert.equal(got?.fits, true);
  });

  test('GPU が在るなら、載るもののうち大きいほうを選ぶ', () => {
    const got = chooseModel([
      { ref: 'small.gguf', sizeBytes: 2 * GB },
      { ref: 'mid.gguf', sizeBytes: 8 * GB },
    ], ram, undefined, { hasGpu: true });
    assert.equal(got?.chosen.ref, 'mid.gguf');
  });

  /*
   * **「載る」を「良い」と読んでいた。**
   *
   * GPU の無い機械で 8B・4.7GB を選ぶと、最初の送信で何分も待つ。
   * 賢さは待ち時間で相殺されるどころか、返ってこないのと変わらない。
   * 同じフォルダに 2B が在るのに、大きい方を掴んでいた（実機でそうなった）。
   */
  test('GPU が無いなら、載るもののうち小さいほうを選ぶ', () => {
    const got = chooseModel([
      { ref: 'small.gguf', sizeBytes: 2 * GB },
      { ref: 'mid.gguf', sizeBytes: 8 * GB },
    ], ram, undefined, { hasGpu: false });
    assert.equal(got?.chosen.ref, 'small.gguf');
    assert.equal(got?.fits, true);
  });

  test('GPU が無くても、名指しがあればそちら（利用者が決めたものが最優先）', () => {
    const got = chooseModel([
      { ref: 'small.gguf', sizeBytes: 2 * GB },
      { ref: 'mid.gguf', sizeBytes: 8 * GB },
    ], ram, 'mid.gguf', { hasGpu: false });
    assert.equal(got?.chosen.ref, 'mid.gguf');
  });

  test('設定で名指しされていれば、それを使う（対）', () => {
    const got = chooseModel([
      { ref: 'small.gguf', sizeBytes: 2 * GB },
      { ref: 'mid.gguf', sizeBytes: 8 * GB },
    ], ram, 'small.gguf');
    assert.equal(got?.chosen.ref, 'small.gguf');
  });

  test('どれも載らないなら、載らないと言う', () => {
    const got = chooseModel([
      { ref: 'huge.gguf', sizeBytes: 40 * GB },
      { ref: 'big.gguf', sizeBytes: 30 * GB },
    ], ram);
    assert.equal(got?.fits, false);
    assert.equal(got?.chosen.ref, 'big.gguf', 'いちばん小さいものを指していない');
  });

  test('一つも無ければ、選ばない', () => {
    assert.equal(chooseModel([], ram), undefined);
  });
});

describe('諸元が読めないとき、窓を広げない', () => {
  /**
   * `contextLength` だけ読めて層数や head 数が読めない GGUF は珍しくない
   * （アーキテクチャごとに鍵の名前が違う）。そのとき **32768 を記憶の勘定
   * なしで渡していた**。8B なら KV だけで +4.5GB。重みと合わせて 16GB の
   * 機械の容量を越え、追い出しが始まって読み込みが終わらなくなる。
   *
   * GGUF がまったく読めないときは 8192 に落ちるのに、半端に読めたときだけ
   * 無防備、という食い違いでもあった。
   */
  const GB = 1024 ** 3;

  test('**層数が読めなければ、広げない**', () => {
    const got = fitWindow({ trained: 32768, ramBytes: 16 * GB, weightBytes: 8 * GB });
    assert.equal(got.window, SAFE_WINDOW, `記憶を数えずに広げている: ${got.window}`);
    assert.match(got.why ?? '', /読めない/, 'なぜ狭めたかを言っていない');
  });

  test('モデルの窓がもともと狭ければ、そのまま', () => {
    const got = fitWindow({ trained: 4096, ramBytes: 16 * GB });
    assert.equal(got.window, 4096);
    assert.equal(got.why, undefined, '狭めていないのに理由を言っている');
  });

  test('諸元が揃っていれば、今までどおり計算する（対）', () => {
    const got = fitWindow({
      trained: 32768, layers: 32, embedding: 4096, heads: 32, kvHeads: 8,
      weightBytes: 4 * GB, ramBytes: 64 * GB,
    });
    assert.equal(got.window, 32768, '余裕がある機械なのに狭めている');
  });

  test('諸元が揃っていて記憶が足りなければ、そこで狭める（対）', () => {
    const got = fitWindow({
      trained: 32768, layers: 32, embedding: 4096, heads: 32, kvHeads: 32,
      weightBytes: 8 * GB, ramBytes: 16 * GB,
    });
    assert.ok(got.window < 32768, `記憶が足りないのに広げている: ${got.window}`);
  });
});
