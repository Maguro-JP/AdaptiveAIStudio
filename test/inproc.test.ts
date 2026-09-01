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

/** 本物の代わり。読んだことにして、決まった返事をする。 */
function fakeLib(said = 'こんにちは') {
  return async () => ({
    getLlama: async () => ({
      loadModel: async () => ({
        createContext: async () => ({ getSequence: () => ({}), dispose: async () => {} }),
      }),
    }),
    LlamaChatSession: class { prompt = async () => said; },
  });
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
    const rt = new InProcRuntime({ modelsDir: dir, load: fakeLib('はい') });
    const loaded = await rt.ensureLoaded('m.gguf');

    // 外に出る口を増やさない。127.0.0.1 だけ。
    assert.match(loaded.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    assert.equal(loaded.model, 'm.gguf');

    const r = await fetch(`${loaded.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm.gguf', messages: [{ role: 'user', content: 'やあ' }] }),
    });
    const body = await r.json() as { choices: { message: { content: string } }[] };
    assert.equal(body.choices[0]!.message.content, 'はい');

    await rt.shutdown();
    assert.deepEqual(rt.loaded(), []);
  });

  test('読み込んでいないものは、そう言う', async () => {
    const dir = await tempDir('aas-inproc2-');
    await writeFile(join(dir, 'm.gguf'), 'x');
    const rt = new InProcRuntime({ modelsDir: dir, load: fakeLib() });
    const { baseUrl } = await rt.ensureLoaded('m.gguf');
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
