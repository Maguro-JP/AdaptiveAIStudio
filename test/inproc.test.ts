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
import { InProcRuntime, listGguf } from '../src/runtime/inproc.ts';

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
    await writeFile(join(dir, 'qwen2.5-3b-instruct-q4_k_m.gguf'), 'x');
    await writeFile(join(dir, 'メモ.txt'), 'x');
    await mkdir(join(dir, 'sub'));
    const got = await listGguf(dir);
    assert.deepEqual(got.map((m) => m.ref), ['qwen2.5-3b-instruct-q4_k_m.gguf']);
    assert.equal(got[0]!.sizeBytes, 1);
  });

  test('置き場が無くても落ちない', async () => {
    assert.deepEqual(await listGguf('/そんな場所は無い'), []);
  });
});

describe('中で読む', () => {
  test('OpenAI 互換の口が、自分の中に立つ', async () => {
    const dir = await tempDir('aas-inproc-');
    await writeFile(join(dir, 'm.gguf'), 'x');
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
    await writeFile(join(dir, 'm.gguf'), 'x');
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
    await writeFile(join(dir, 'a.gguf'), 'x');
    await writeFile(join(dir, 'b.gguf'), 'x');
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
    await writeFile(join(dir, 'm.gguf'), 'x');
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
    await writeFile(join(dir, 'm.gguf'), 'x');
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
    await writeFile(join(dir, 'm.gguf'), 'x');
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
