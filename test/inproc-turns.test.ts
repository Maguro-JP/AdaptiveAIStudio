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
import { until } from './until.ts';

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
    // 切ったことが生成まで届くのに、少し要る。**決め打ちで待たない。**
    await until(() => state.aborted >= 1, '切ったことが生成まで届く');
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

describe('同じものを二度読まない', () => {
  test('読み込みの最中に二人目が来ても、読むのは一度', async () => {
    const { dir, ref } = await withModel();
    let loads = 0;
    const load = async () => ({
      getLlama: async () => ({
        loadModel: async () => {
          loads++;
          // 本物は数GBを10〜60秒かけて読む。二人目はその間に来る。
          await new Promise((r) => setTimeout(r, 60));
          return { createContext: async () => ({ getSequence: () => ({}), dispose: async () => {} }) };
        },
      }),
      LlamaChatSession: class { setChatHistory() {} async prompt() { return ''; } },
    });
    const rt = new InProcRuntime({ modelsDir: dir, port: 0, load });
    running.push(rt);
    await Promise.all([rt.ensureLoaded(ref), rt.ensureLoaded(ref), rt.ensureLoaded(ref)]);
    assert.equal(loads, 1, '同じものを何度も読んでいる（数GBが二重に載る）');
    assert.deepEqual(rt.loaded(), [ref]);
  });

  test('読み込みに失敗したら、失敗を覚え込まない', async () => {
    const { dir, ref } = await withModel();
    let tries = 0;
    const load = async () => ({
      getLlama: async () => ({
        loadModel: async () => {
          tries++;
          if (tries === 1) throw new Error('壊れています');
          return { createContext: async () => ({ getSequence: () => ({}), dispose: async () => {} }) };
        },
      }),
      LlamaChatSession: class { setChatHistory() {} async prompt() { return ''; } },
    });
    const rt = new InProcRuntime({ modelsDir: dir, port: 0, load });
    running.push(rt);
    await assert.rejects(() => rt.ensureLoaded(ref));
    // 済んだ失敗を返し続けると、置き直しても直らなくなる。
    await rt.ensureLoaded(ref);
    assert.equal(tries, 2);
  });
});

describe('モデルの口も、よそから叩かせない', () => {
  test('Origin がよそなら断る', async () => {
    const { dir, ref } = await withModel();
    const { load } = slowLib(1);
    const rt = new InProcRuntime({ modelsDir: dir, port: 0, load });
    running.push(rt);
    const { baseUrl } = await rt.ensureLoaded(ref);
    const r = await ask(baseUrl, ref, 'x', { headers: { 'content-type': 'text/plain', origin: 'https://evil.example' } });
    assert.equal(r.status, 403);
  });

  test('何も付いていなければ通る（対）', async () => {
    const { dir, ref } = await withModel();
    const { load } = slowLib(1);
    const rt = new InProcRuntime({ modelsDir: dir, port: 0, load });
    running.push(rt);
    const { baseUrl } = await rt.ensureLoaded(ref);
    assert.equal((await ask(baseUrl, ref, 'x')).status, 200);
  });
});

describe('本文を際限なく抱えない', () => {
  test('大きすぎる本文は 413', async () => {
    const { dir, ref } = await withModel();
    const { load } = slowLib(1);
    const rt = new InProcRuntime({ modelsDir: dir, port: 0, load });
    running.push(rt);
    const { baseUrl } = await rt.ensureLoaded(ref);
    const r = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: ref, messages: [{ role: 'user', content: 'a'.repeat(17 * 1024 * 1024) }] }),
    }).catch(() => undefined);
    if (r) assert.equal(r.status, 413);
  });
});

describe('並んでいる間も、繋がったことは先に返す', () => {
  test('前の返事が長くても、二人目のヘッダはすぐ来る', async () => {
    const { dir, ref } = await withModel();
    // 一人目の返事に 30 文字 × 40ms = 1.2 秒。二人目はその後ろに並ぶ。
    const { load } = slowLib(40);
    const rt = new InProcRuntime({ modelsDir: dir, port: 0, load });
    running.push(rt);
    const { baseUrl } = await rt.ensureLoaded(ref);

    const first = ask(baseUrl, ref, 'あ'.repeat(30));
    await new Promise((r) => setTimeout(r, 50));
    const t0 = Date.now();
    const second = await ask(baseUrl, ref, 'い');
    const waited = Date.now() - t0;
    assert.equal(second.status, 200);
    // 上の層はヘッダを 10 秒で見切る。並ぶ時間（1 秒超）より前に返っていること。
    assert.ok(waited < 800, `ヘッダが並び終わるまで返っていない（${waited}ms）`);
    const [a, b] = await Promise.all([first.then((r) => r.text()), second.text()]);
    assert.match(a, /data: \[DONE\]/);
    assert.match(b, /data: \[DONE\]/);
  });

  test('並んでいる間に切られた依頼は、始めない', async () => {
    const { dir, ref } = await withModel();
    const { load, state } = slowLib(20);
    const rt = new InProcRuntime({ modelsDir: dir, port: 0, load });
    running.push(rt);
    const { baseUrl } = await rt.ensureLoaded(ref);

    const first = ask(baseUrl, ref, 'あ'.repeat(20));
    await new Promise((r) => setTimeout(r, 30));
    const stop = new AbortController();
    const second = ask(baseUrl, ref, 'い', { signal: stop.signal });
    await second; // ヘッダは来る
    stop.abort();
    await first.then((r) => r.text());
    // 一人目が終わったあと、二人目が始まっていないこと。
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(state.started, 1, '切られた依頼を始めている（誰も読まない答えを作る）');
  });
});

describe('降ろしたあとに、口を立て直さない', () => {
  test('読み込みの途中で降ろしたら、読み終えても口を開かない', async () => {
    const { dir, ref } = await withModel();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const load = async () => ({
      getLlama: async () => ({
        loadModel: async () => {
          await gate; // 降ろされるまで読み終えない
          return { createContext: async () => ({ getSequence: () => ({}), dispose: async () => {} }) };
        },
      }),
      LlamaChatSession: class { setChatHistory() {} async prompt() { return ''; } },
    });
    const rt = new InProcRuntime({ modelsDir: dir, port: 0, load });
    const servers = () => process.getActiveResourcesInfo().filter((x) => x === 'TCPServerWrap').length;
    const before = servers();
    const loading = rt.ensureLoaded(ref);
    await rt.shutdown();
    release();
    try {
      await assert.rejects(loading, /止めています/);
      assert.equal(rt.loaded().length, 0, '降ろしたのに載っている');
      assert.equal(servers(), before, '降ろしたあとに口が開いている（プロセスが終わらない）');
    } finally {
      // 壊れていたら口が開いている。閉じてから抜ける（閉じないと走りが終わらない）。
      await rt.shutdown();
    }
  });
});
