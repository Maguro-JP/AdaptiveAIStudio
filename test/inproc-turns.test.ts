/**
 * 同時に来たとき、途中でやめられたとき、口が塞がっているとき。
 *
 * どれも**落ちない**ので気づきにくい。混ざった答えが返り、
 * 誰も読まない生成が回り続け、立ち上げが黙って返らない。
 * 落ちないものほど、検査で留めておく。
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tempDir } from './tmp.ts';
import { InProcRuntime } from '../src/runtime/inproc.ts';

const running: InProcRuntime[] = [];
afterEach(async () => { for (const r of running.splice(0)) await r.shutdown(); });

/** GGUF を1つ置いた置き場。 */
async function withModel(): Promise<{ dir: string; ref: string }> {
  const dir = await tempDir('aas-turn-');
  const ref = 'a.gguf';
  await writeFile(join(dir, ref), 'x');
  return { dir, ref };
}

/**
 * 履歴を持つ本物に似せた代わり。
 *
 * **prompt の最中に setChatHistory が来たら、それを記録する。**
 * 本物はここで混ざるが落ちない。代わりの側で見張らないと確かめられない。
 */
function slowLib(ms: number) {
  const state = { busy: false, overlapped: false, aborted: 0, started: 0 };
  const load = async () => ({
    getLlama: async () => ({
      loadModel: async () => ({
        createContext: async () => ({ getSequence: () => ({}), dispose: async () => {} }),
      }),
    }),
    LlamaChatSession: class {
      setChatHistory() { if (state.busy) state.overlapped = true; }
      async prompt(text: string, o: { onTextChunk?: (t: string) => void; signal?: AbortSignal } = {}) {
        if (state.busy) state.overlapped = true;
        state.busy = true;
        state.started++;
        try {
          for (const part of [...text]) {
            await new Promise((r) => setTimeout(r, ms));
            if (o.signal?.aborted) { state.aborted++; throw new Error('やめました'); }
            o.onTextChunk?.(part);
          }
          return text;
        } finally { state.busy = false; }
      }
    },
  });
  return { load, state };
}

function ask(url: string, ref: string, text: string, init: RequestInit = {}) {
  return fetch(`${url}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: ref, messages: [{ role: 'user', content: text }] }),
    ...init,
  });
}

describe('同時に来ても混ぜない', () => {
  test('二つ同時に来たら、順に答える', async () => {
    const { dir, ref } = await withModel();
    const { load, state } = slowLib(5);
    const rt = new InProcRuntime({ modelsDir: dir, port: 0, load });
    running.push(rt);
    const { baseUrl } = await rt.ensureLoaded(ref);

    const [a, b] = await Promise.all([
      ask(baseUrl, ref, 'あいうえお').then((r) => r.text()),
      ask(baseUrl, ref, 'かきくけこ').then((r) => r.text()),
    ]);

    assert.equal(state.overlapped, false, '答えている最中に割り込まれた');
    assert.equal(state.started, 2, '二つとも答えていない');
    // 待たせただけで、断ってはいない。両方に答えが返る。
    assert.match(a, /data: /);
    assert.match(b, /data: /);
  });
});

describe('やめたら、止める', () => {
  test('繋ぎを切ったら生成も止まる', async () => {
    const { dir, ref } = await withModel();
    const { load, state } = slowLib(20);
    const rt = new InProcRuntime({ modelsDir: dir, port: 0, load });
    running.push(rt);
    const { baseUrl } = await rt.ensureLoaded(ref);

    const stop = new AbortController();
    const call = ask(baseUrl, ref, 'ながいながいながい文', { signal: stop.signal });
    await new Promise((r) => setTimeout(r, 40));
    stop.abort();
    await call.then((r) => r.text()).catch(() => '');
    // 切ったことが生成まで届くのに、少し要る。
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(state.aborted, 1, '切ったのに生成が回り続けている');
  });

  test('切らなければ、最後まで答える（対）', async () => {
    // 上の試験は「常に止まる」でも通ってしまう。止まらない側を並べる。
    const { dir, ref } = await withModel();
    const { load, state } = slowLib(1);
    const rt = new InProcRuntime({ modelsDir: dir, port: 0, load });
    running.push(rt);
    const { baseUrl } = await rt.ensureLoaded(ref);
    const raw = await ask(baseUrl, ref, 'みじかい').then((r) => r.text());
    assert.equal(state.aborted, 0);
    assert.match(raw, /data: \[DONE\]/);
  });
});

describe('口が塞がっていたら、そう言う', () => {
  test('待たずに、理由を返す', async () => {
    const { dir, ref } = await withModel();
    const blocker = createServer(() => {});
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
    const addr = blocker.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    try {
      const { load } = slowLib(1);
      const rt = new InProcRuntime({ modelsDir: dir, port, load });
      running.push(rt);
      await assert.rejects(
        () => rt.ensureLoaded(ref),
        (e: Error) => e.message.includes(String(port)) && e.message.includes('既に使われて'),
      );
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  });
});
