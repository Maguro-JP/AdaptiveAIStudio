/**
 * 起動と設定の不具合（29 回目の調査）。
 *
 * - 設定の形が違うときは、素の TypeError ではなく直せる形（ConfigBroken）で断る
 * - 守りの一覧（harness.protectedPaths）を文字列一つで書いたら断る（一字ずつの型として入り、守りが黙って外れていた）
 * - runtime.kind の綴りの間違いを断る（黙って Ollama の口へ繋ぎに行っていた）
 * - runtime を書いていないとき、利用者が書いた手元の口の URL を書き換えない。無効にした口を付け替えない
 * - 有効な手元の口が無ければ、モデルを読み込んで候補を固定しない
 * - 常時ロード: VRAM が無い機械では一つだけ。表示は動かし方ごと。明示指定の provider: も外す
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { loadConfig, ConfigBroken, DEFAULT_CONFIG, type AasConfig } from '../src/config.ts';
import { withLocalCandidate, readyLocalModel } from '../src/core/local-ready.ts';
import { startWarmPool } from '../src/core/warm-setup.ts';
import { LlamaCppRuntime } from '../src/runtime/llamacpp.ts';
import type { LocalRuntime } from '../src/runtime/local-runtime.ts';

async function load(body: string): Promise<ReturnType<typeof loadConfig>> {
  const home = await tempDir('aas-startup-gaps-');
  const at = join(home, 'aas.config.json');
  await writeFile(at, body);
  const saved = { c: process.env.AAS_CONFIG, h: process.env.AAS_HOME, s: process.env.AAS_STATE_DIR };
  process.env.AAS_CONFIG = at;
  process.env.AAS_HOME = home;
  process.env.AAS_STATE_DIR = join(home, 'state');
  try {
    return loadConfig(home);
  } finally {
    for (const [k, v] of [['AAS_CONFIG', saved.c], ['AAS_HOME', saved.h], ['AAS_STATE_DIR', saved.s]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

describe('設定の形', () => {
  for (const [label, body] of [
    ['中身が null だけ', 'null'],
    ['providers が並びでない', '{"providers":{"ollama":{"kind":"openai-compatible"}}}'],
    ['providers の中に null', '{"providers":[null]}'],
    ['lane に candidates が無い', '{"agent":{"lanes":[{"id":"a","parallel":1}]}}'],
  ] as const) {
    test(`**${label}なら、直せる形で断る**（素の TypeError で起動ごと落とさない）`, async () => {
      await assert.rejects(load(body), (e) => e instanceof ConfigBroken, label);
    });
  }
  test('**守りの一覧を文字列一つで書いたら断る**（一字ずつの型として入り、守りが黙って外れていた）', async () => {
    await assert.rejects(load('{"harness":{"protectedPaths":"secrets/**"}}'), (e) => e instanceof ConfigBroken);
  });
  test('**runtime.kind の綴りの間違いを断る**', async () => {
    await assert.rejects(load('{"runtime":{"kind":"llama.cpp"}}'), (e) => e instanceof ConfigBroken && /inproc/.test(e.message));
  });
  test('正しい形は、今までどおり読む（対）', async () => {
    await load('{"harness":{"protectedPaths":["secrets/**"]},"runtime":{"kind":"none"}}'); // 投げれば落ちる
    const { config } = await load('{"harness":{"protectedPaths":["secrets/**"]}}');
    assert.deepEqual(config.harness?.protectedPaths, ['secrets/**']);
  });
});

describe('手元の口', () => {
  test('**runtime を書いていないとき、利用者が書いた手元の URL を書き換えない**', async () => {
    const { config } = await load(JSON.stringify({
      providers: [{ id: 'lmstudio', kind: 'openai-compatible', baseUrl: 'http://192.168.1.10:1234/v1', locality: 'local' }],
    }));
    assert.equal(config.providers.find((p) => p.id === 'lmstudio')?.baseUrl, 'http://192.168.1.10:1234/v1');
  });
  test('**既定の口を無効にしたら、付け替えない**（クラウドだけで使う）', async () => {
    const { config } = await load(JSON.stringify({
      providers: [
        { id: 'ollama', kind: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', locality: 'local', enabled: false },
        { id: 'claude', kind: 'anthropic', locality: 'cloud', apiKeyEnv: 'X' },
      ],
    }));
    const ollama = config.providers.find((p) => p.id === 'ollama');
    assert.equal(ollama?.baseUrl, 'http://localhost:11434/v1', `無効の口を付け替えた: ${JSON.stringify(config.providers)}`);
    assert.ok(!config.providers.some((p) => p.id === 'inproc'), JSON.stringify(config.providers));
  });
  test('既定の口は、今までどおり inproc に付け替える（対）', async () => {
    const { config } = await load(JSON.stringify({
      providers: [{ id: 'ollama', kind: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', locality: 'local' }],
    }));
    assert.ok(config.providers.some((p) => p.id === 'inproc' && /127\.0\.0\.1/.test(p.baseUrl ?? '')), JSON.stringify(config.providers));
  });

  const fakeInproc = (): LocalRuntime => ({
    id: 'inproc', loaded: () => ['a.gguf'], list: async () => [], windowOf: () => undefined,
  }) as unknown as LocalRuntime;
  test('**有効な手元の口が無ければ、モデルを読み込んで候補を固定しない**', async () => {
    const config = {
      ...structuredClone(DEFAULT_CONFIG), runtime: { kind: 'inproc' },
      providers: [
        { id: 'ollama', kind: 'openai-compatible', baseUrl: 'http://x/v1', locality: 'local', enabled: false },
        { id: 'claude', kind: 'anthropic', locality: 'cloud' },
      ],
    } as AasConfig;
    const r = await readyLocalModel(config, fakeInproc());
    assert.equal(r.config.candidates, undefined, `候補を固定した: ${JSON.stringify(r.config.candidates)}`);
  });
  test('**inproc の口があれば、それに名前を付ける**（利用者が別に書いた手元の口に付けない）', () => {
    const config = {
      ...structuredClone(DEFAULT_CONFIG),
      providers: [
        { id: 'lmstudio', kind: 'openai-compatible', baseUrl: 'http://192.168.1.10:1234/v1', locality: 'local' },
        { id: 'inproc', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:4177/v1', locality: 'local' },
      ],
    } as AasConfig;
    assert.deepEqual(withLocalCandidate(config, 'a.gguf').candidates, ['inproc:a.gguf']);
  });
});

describe('常時ロード', () => {
  function fakeLlama(refs: string[]) {
    const loaded: string[] = [];
    const rt = Object.create(LlamaCppRuntime.prototype) as LlamaCppRuntime;
    Object.assign(rt, {
      list: async () => refs.map((ref) => ({ ref })),
      planFor: () => ({ vramUsedBytes: 0 }),
      ensureLoaded: async (ref: string) => { loaded.push(ref); return { baseUrl: 'http://x' }; },
      unload: async (ref: string) => { loaded.splice(loaded.indexOf(ref), 1); },
      loaded: () => [...loaded],
    });
    return { rt, loaded };
  }
  const config = (warm: Record<string, unknown> = {}) => ({
    ...structuredClone(DEFAULT_CONFIG), runtime: { kind: 'llamacpp', warm },
    providers: [{ id: 'llamacpp', kind: 'openai-compatible', baseUrl: 'http://x/v1', locality: 'local' }],
  }) as AasConfig;
  test('**VRAM が無い機械では、一つだけ温める**（候補を全部システムの記憶へ温めない）', async () => {
    const { rt, loaded } = fakeLlama(['a.gguf', 'b.gguf', 'c.gguf']);
    await startWarmPool(config(), rt, { vramBytes: 0 } as never, ['llamacpp:a.gguf', 'llamacpp:b.gguf', 'llamacpp:c.gguf']);
    assert.ok(loaded.length <= 1, `温めすぎた: ${loaded.join(',')}`);
  });
  test('**明示指定の provider: も外して照らす**', async () => {
    const { rt } = fakeLlama(['x.gguf']);
    const r = await startWarmPool(config({ preload: ['llamacpp:x.gguf'] }), rt, { vramBytes: 8e9 } as never, []);
    assert.ok(!r.notes.some((n) => /見つかりませんでした/.test(n)), r.notes.join(' / '));
  });
  test('**inproc では、Ollama の名前を出さない**', async () => {
    const r = await startWarmPool({ ...config(), runtime: { kind: 'inproc' } } as AasConfig,
      { id: 'inproc' } as unknown as LocalRuntime, { vramBytes: 0 } as never, []);
    assert.ok(!r.notes.some((n) => /Ollama/.test(n)), r.notes.join(' / '));
  });
});
