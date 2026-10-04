/**
 * 手元でモデルを動かす所の不具合（25 回目の調査）。
 *
 * - 繰り返しで切った答えを `stop`（言い終えた）で返さない
 * - 降ろすとき・context を作れなかったときに、重み（モデル）も解く
 * - 降ろすときは、答えている最中の口が戻るのを待ってから解く
 * - 読めないと分かっている切り替え先のために、今のモデルを先に降ろさない
 * - 切り替えを一つずつ通し、二つのモデルを同時に載せない
 * - 401・403 の冷やしは有限で、単調な時計で数える
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { tempDir } from './tmp.ts';
import { InProcRuntime } from '../src/runtime/inproc.ts';

interface Counts { loads: string[]; modelDisposed: string[]; contextDisposed: string[] }

/** 偽のライブラリ。読んだ・解いたを数える。`gate` を渡すと、その名前の読み込みを門で止める。 */
function fakeLib(counts: Counts, opts: { failContext?: boolean; gate?: { name: string; wait: Promise<void> }; reply?: (o: { onTextChunk?: (t: string) => void; signal?: AbortSignal }) => string } = {}) {
  return async () => ({
    getLlama: async () => ({
      loadModel: async ({ modelPath }: { modelPath: string }) => {
        const name = modelPath.split(/[\\/]/).pop()!;
        counts.loads.push(name);
        if (opts.gate && opts.gate.name === name) await opts.gate.wait;
        return {
          dispose: async () => { counts.modelDisposed.push(name); },
          createContext: async () => {
            if (opts.failContext) throw new Error('KV が入りません');
            return { getSequence: () => ({}), dispose: async () => { counts.contextDisposed.push(name); } };
          },
        };
      },
    }),
    LlamaChatSession: class {
      chatWrapper = { wrapperName: 'QwenChatWrapper' };
      setChatHistory(): void { /* 見ない */ }
      async prompt(_t: string, o: { onTextChunk?: (t: string) => void; signal?: AbortSignal } = {}): Promise<string> {
        if (opts.reply) return opts.reply(o);
        o.onTextChunk?.('答えです。');
        return '答えです。';
      }
    },
  });
}

async function runtime(names: Record<string, string>, lib: ReturnType<typeof fakeLib>) {
  const dir = await tempDir('aas-model-life-');
  for (const [n, body] of Object.entries(names)) await writeFile(join(dir, n), body);
  return new InProcRuntime({ modelsDir: dir, port: 0, load: lib } as ConstructorParameters<typeof InProcRuntime>[0]);
}

async function chat(baseUrl: string, model: string, stream: boolean): Promise<{ status: number; finish?: string }> {
  const r = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, stream, messages: [{ role: 'user', content: '1+1=' }] }),
  });
  const raw = await r.text();
  if (!stream) {
    const j = JSON.parse(raw || '{}') as { choices?: { finish_reason?: string }[] };
    return { status: r.status, finish: j.choices?.[0]?.finish_reason };
  }
  let finish: string | undefined;
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data: {')) continue;
    const f = (JSON.parse(line.slice(6)) as { choices?: { finish_reason?: string | null }[] }).choices?.[0]?.finish_reason;
    if (f) finish = f;
  }
  return { status: r.status, finish };
}

describe('繰り返しで切った答え', () => {
  const zeros = (o: { onTextChunk?: (t: string) => void; signal?: AbortSignal }) => {
    let out = '1+1';
    o.onTextChunk?.('1+1');
    for (let i = 0; i < 4000 && !o.signal?.aborted; i++) { out += '0'; o.onTextChunk?.('0'); }
    return out;
  };
  for (const stream of [true, false]) {
    test(`**${stream ? '流す' : 'まとめて返す'}道でも、言い終えたこと（stop）にしない**`, async () => {
      const counts: Counts = { loads: [], modelDisposed: [], contextDisposed: [] };
      const rt = await runtime({ 'm.gguf': 'GGUF' }, fakeLib(counts, { reply: zeros }));
      const { baseUrl } = await rt.ensureLoaded('m.gguf');
      try {
        const got = await chat(baseUrl, 'm.gguf', stream);
        assert.equal(got.finish, 'length');
      } finally { await rt.shutdown(); }
    });
  }
  test('繰り返さない答えは、今までどおり stop（対）', async () => {
    const counts: Counts = { loads: [], modelDisposed: [], contextDisposed: [] };
    const rt = await runtime({ 'm.gguf': 'GGUF' }, fakeLib(counts));
    const { baseUrl } = await rt.ensureLoaded('m.gguf');
    try {
      assert.equal((await chat(baseUrl, 'm.gguf', true)).finish, 'stop');
    } finally { await rt.shutdown(); }
  });
});

describe('重みを解く', () => {
  test('**降ろすとき、context だけでなく重みも解く**', async () => {
    const counts: Counts = { loads: [], modelDisposed: [], contextDisposed: [] };
    const rt = await runtime({ 'a.gguf': 'GGUF' }, fakeLib(counts));
    await rt.ensureLoaded('a.gguf');
    await rt.unload('a.gguf');
    assert.deepEqual(counts.contextDisposed, ['a.gguf']);
    assert.deepEqual(counts.modelDisposed, ['a.gguf']);
    await rt.shutdown();
  });

  test('**context を作れなかったら、読んだ重みを解いてから投げる**', async () => {
    const counts: Counts = { loads: [], modelDisposed: [], contextDisposed: [] };
    const rt = await runtime({ 'a.gguf': 'GGUF' }, fakeLib(counts, { failContext: true }));
    await assert.rejects(rt.ensureLoaded('a.gguf'));
    assert.deepEqual(counts.modelDisposed, ['a.gguf']);
    await rt.shutdown();
  });
});

describe('切り替え', () => {
  test('**読めない切り替え先（GGUF でない）のために、今のモデルを降ろさない**（503 で断る）', async () => {
    const counts: Counts = { loads: [], modelDisposed: [], contextDisposed: [] };
    const rt = await runtime({ 'a.gguf': 'GGUF', 'b.gguf': 'not a model' }, fakeLib(counts));
    const { baseUrl } = await rt.ensureLoaded('a.gguf');
    try {
      const got = await chat(baseUrl, 'b.gguf', false);
      assert.equal(got.status, 503);
      assert.deepEqual(rt.loaded(), ['a.gguf']);
      assert.deepEqual(counts.modelDisposed, []);
    } finally { await rt.shutdown(); }
  });

  test('**別のモデルを読み込んでいる間の切り替えでも、二つ同時に載せない**', async () => {
    const counts: Counts = { loads: [], modelDisposed: [], contextDisposed: [] };
    let open!: () => void;
    const wait = new Promise<void>((r) => { open = r; });
    const rt = await runtime({ 'a.gguf': 'GGUF', 'b.gguf': 'GGUF' }, fakeLib(counts, { gate: { name: 'b.gguf', wait } }));
    const { baseUrl } = await rt.ensureLoaded('a.gguf');
    try {
      const toB = chat(baseUrl, 'b.gguf', false);
      // b を読み始めるまで待つ（門で止まっている）
      for (let i = 0; i < 100 && !counts.loads.includes('b.gguf'); i++) await new Promise((r) => setTimeout(r, 10));
      const toA = chat(baseUrl, 'a.gguf', false);
      await new Promise((r) => setTimeout(r, 50));
      open();
      await Promise.all([toB, toA]);
      assert.equal(rt.loaded().length, 1, `同時に載っている: ${rt.loaded().join(',')}`);
      const live = counts.loads.length - counts.modelDisposed.length;
      assert.equal(live, 1, `解いていない重みが残っている: 読んだ ${counts.loads.join(',')} / 解いた ${counts.modelDisposed.join(',')}`);
    } finally { await rt.shutdown(); }
  });
});

describe('冷やし', () => {
  test('**401・403 の冷やしは有限で、明ければまた試す**', async () => {
    const { FALLBACK_RULES } = await import('../src/providers/errors.ts');
    assert.ok(Number.isFinite(FALLBACK_RULES.auth.cooldownMs), '無期限のまま');
    const { ProviderRegistry } = await import('../src/core/registry.ts');
    const reg = new ProviderRegistry();
    let now = 1_000;
    reg.setClockForTest(() => now);
    reg.cooldown('p', FALLBACK_RULES.auth.cooldownMs);
    assert.equal(reg.isAvailable('p'), false);
    now += FALLBACK_RULES.auth.cooldownMs + 1;
    assert.equal(reg.isAvailable('p'), true);
  });

  test('**壁時計が戻っても、冷やしは初めの長さを超えない**（単調な時計で数える）', async () => {
    const { ProviderRegistry } = await import('../src/core/registry.ts');
    const reg = new ProviderRegistry();
    const realNow = Date.now;
    reg.cooldown('p', 50);
    Date.now = () => realNow() - 60 * 60 * 1000; // 1 時間戻る
    try {
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(reg.isAvailable('p'), true, '時計が戻ったので冷えたまま');
    } finally { Date.now = realNow; }
  });
});
