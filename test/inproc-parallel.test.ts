/**
 * 会話ごとに口（sequence）を分けて、**本当に並列に答える**。
 *
 * ここまで sequence は 1 本だけで、同時に来た依頼は順番待ちにしていた。
 * 一人が長く考えている間、もう一人は待たされた（それが直したかった形）。
 *
 * 本数を増やすと、同時に走る。**速くはならない。止まらなくなるだけ**
 * （CPU は分け合う）。ここで確かめるのは「二本あれば二つ同時に走る」ことと、
 * 「一本ずつは混ざらない（同じ口を二重に使わない）」ことと、
 * 「本数を超えた分は、超えた分だけ待つ」こと。
 *
 * 本数は #windowFor で決まる。読めない GGUF だと KV を数えられず 1 本に
 * 落ちるので（安全側）、ここではコンテキストウィンドウを設定で渡して（contextSize）、狙った
 * 本数をそのまま持たせる。
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { tempDir } from './tmp.ts';
import { InProcRuntime } from '../src/runtime/inproc.ts';
import { until } from './until.ts';

const running: InProcRuntime[] = [];
afterEach(async () => { for (const r of running.splice(0)) await r.shutdown(); });

async function withModel(): Promise<{ dir: string; ref: string }> {
  const dir = await tempDir('aas-par-');
  const ref = 'a.gguf';
  await writeFile(join(dir, ref), 'x');
  return { dir, ref };
}

/**
 * 一本ずつ別に持つ本物に似せた代わり。
 *
 * **口ごとに busy を持つ**（本物の LlamaChatSession も履歴を持つので、一本を
 * 二人で使えば混ざる）。同時に走った最大本数と、同じ口を二重に使ったかを記録する。
 */
function countingLib(ms: number) {
  const state = { active: 0, maxConcurrent: 0, laneOverlap: false, started: 0 };
  const load = async () => ({
    getLlama: async () => ({
      loadModel: async () => ({
        createContext: async () => ({ getSequence: () => ({}), dispose: async () => {} }),
      }),
    }),
    LlamaChatSession: class {
      #busy = false;
      setChatHistory() { if (this.#busy) state.laneOverlap = true; }
      async prompt(text: string, o: { onTextChunk?: (t: string) => void; signal?: AbortSignal } = {}) {
        if (this.#busy) state.laneOverlap = true;
        this.#busy = true;
        state.started += 1;
        state.active += 1;
        state.maxConcurrent = Math.max(state.maxConcurrent, state.active);
        try {
          for (const part of [...text]) {
            await new Promise((r) => setTimeout(r, ms));
            o.onTextChunk?.(part);
          }
          return text;
        } finally { this.#busy = false; state.active -= 1; }
      }
    },
  });
  return { load, state };
}

function ask(url: string, ref: string, text: string): Promise<string> {
  return fetch(`${url}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: ref, messages: [{ role: 'user', content: text }] }),
  }).then((r) => r.text());
}

describe('会話ごとに口を分けて並列に答える', () => {
  test('二本あれば、二つ同時に走る', async () => {
    const { dir, ref } = await withModel();
    const { load, state } = countingLib(10);
    // コンテキストウィンドウを渡すと、そのコンテキストウィンドウで狙った本数をそのまま持つ（読めない GGUF でも）。
    const rt = new InProcRuntime({ modelsDir: dir, port: 0, load, sequences: 2, contextSize: 4096 });
    running.push(rt);
    const { baseUrl } = await rt.ensureLoaded(ref);

    const both = Promise.all([
      ask(baseUrl, ref, 'あいうえおかきくけこ'),
      ask(baseUrl, ref, 'さしすせそたちつてと'),
    ]);
    // **二つが同時に走ったこと**を、時間ではなく「起きるまで見る」で確かめる。
    await until(() => state.maxConcurrent >= 2, '二本が同時に走る');
    const [a, b] = await both;
    assert.equal(state.maxConcurrent, 2, '二本同時に走っていない');
    assert.equal(state.laneOverlap, false, '同じ口を二重に使った（履歴が混ざる）');
    assert.match(a, /data: \[DONE\]/);
    assert.match(b, /data: \[DONE\]/);
  });

  test('一本なら、順に走る（対）', async () => {
    // 上の試験が「本数を増やせば並列」を言うには、増やさなければ直列、が対で要る。
    const { dir, ref } = await withModel();
    const { load, state } = countingLib(10);
    const rt = new InProcRuntime({ modelsDir: dir, port: 0, load, sequences: 1, contextSize: 4096 });
    running.push(rt);
    const { baseUrl } = await rt.ensureLoaded(ref);

    const [a, b] = await Promise.all([
      ask(baseUrl, ref, 'あいうえお'),
      ask(baseUrl, ref, 'かきくけこ'),
    ]);
    assert.equal(state.maxConcurrent, 1, '一本なのに二つ同時に走った');
    assert.equal(state.started, 2, '二つとも答えていない');
    assert.match(a, /data: \[DONE\]/);
    assert.match(b, /data: \[DONE\]/);
  });

  test('本数を超えた分は、空くのを待つ（断らない）', async () => {
    const { dir, ref } = await withModel();
    const { load, state } = countingLib(8);
    const rt = new InProcRuntime({ modelsDir: dir, port: 0, load, sequences: 2, contextSize: 4096 });
    running.push(rt);
    const { baseUrl } = await rt.ensureLoaded(ref);

    const all = Promise.all([
      ask(baseUrl, ref, 'あいうえおかき'),
      ask(baseUrl, ref, 'くけこさしすせ'),
      ask(baseUrl, ref, 'たちつてとなに'),
    ]);
    const texts = await all;
    // 三つとも答える（断らない）。同時に走ったのは、多くても本数まで。
    assert.equal(state.started, 3, '三つとも答えていない');
    assert.ok(state.maxConcurrent <= 2, `本数を超えて走った: ${state.maxConcurrent}`);
    assert.equal(state.maxConcurrent, 2, '二本を使い切っていない（三つ目が一本目の隣で走っていない）');
    for (const t of texts) assert.match(t, /data: \[DONE\]/);
  });
});
