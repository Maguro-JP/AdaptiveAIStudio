/**
 * 補助の呼び出しが、会話の続き（答える呼び出しの KV の続き）を壊さないこと。
 *
 * 1 回の頼みで、本体は中のモデルを何度か呼ぶ（要る事実を挙げる・答える・指摘かどうかを判じる）。
 * 口（sequence）が 1 本だと、補助の呼び出しが前の頼みの続きを毎回上書きし、続けて頼んだ会話を頭から
 * 読み直していた（本物の小さいモデルで、2 回目の頼みが 1 回目と同じだけ読んでいた）。
 *
 * ここで見るのは、受ける側と送る側の両方:
 * - `x-aas-aux: 1` の呼び出しは、会話とは別の小さな context の口で回る。会話の口の履歴は上書きされず、
 *   続きの頼みが読み直すのは新しい分だけ
 * - 補助の口を切る（`auxWindow: 0`）と、同じ流れで会話の口が上書きされる（対。直す前の形）
 * - 補助の口に入り切らない長さ・ツール付きの呼び出しは、会話の口で回る（切り詰めて答えを変えない）
 * - 補助の口は最初の補助の呼び出しで開く（補助を使わない間は、context を増やさない）
 * - 補助の口を開けなくても、補助の呼び出しは会話の口で答える（開き直しを毎回は試さない）
 * - 降ろすと、補助の context も解く
 * - provider は `aux` があるときだけヘッダを付け、orchestrator はそのまま渡し、要る事実を挙げる段は合図を付けて呼ぶ
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { tempDir } from './tmp.ts';
import { AUX_WINDOW, InProcRuntime, fitsAux } from '../src/runtime/inproc.ts';
import { OpenAiCompatibleProvider } from '../src/providers/openai-compatible.ts';
import { ProviderRegistry } from '../src/core/registry.ts';
import { ChatOrchestrator } from '../src/core/orchestrator.ts';
import { InnerNeedLister } from '../src/core/network-provider.ts';
import {
  AUX_HEADER, isAux, type ChatProvider, type ProviderChunk, type ProviderRequest,
} from '../src/providers/contract.ts';

const running: InProcRuntime[] = [];
afterEach(async () => { for (const r of running.splice(0)) await r.shutdown(); });

async function withModel(): Promise<{ dir: string; ref: string }> {
  const dir = await tempDir('aas-aux-');
  const ref = 'a.gguf';
  await writeFile(join(dir, ref), 'x');
  return { dir, ref };
}

interface Opened { contextSize?: number; sequences?: number; disposed: boolean }

/**
 * 口ごとに「いま読んである列」を持つ代わり。本物の sequence と同じで、次の入力のうち、
 * 読んである列と頭から一致する分は読み直さず、違う所から先だけを読む。読んだ数を口ごとに記録する。
 */
function trackingLib(opts: { failSecondContext?: boolean } = {}) {
  const contexts: Opened[] = [];
  const turns: Array<{ context: number; fresh: number; total: number }> = [];
  const load = async () => ({
    getLlama: async () => ({
      loadModel: async () => ({
        createContext: async (o: { contextSize?: number; sequences?: number } = {}) => {
          if (opts.failSecondContext && contexts.length >= 1) throw new Error('メモリが足りません（試験）');
          const opened: Opened = { ...o, disposed: false };
          contexts.push(opened);
          const at = contexts.length - 1;
          return { getSequence: () => ({ at }), dispose: async () => { opened.disposed = true; } };
        },
      }),
    }),
    LlamaChatSession: class {
      readonly #at: number;
      #held: string[] = [];
      #next: string[] = [];
      constructor(o: { contextSequence: { at: number } }) { this.#at = o.contextSequence.at; }
      setChatHistory(history: Array<{ type: string; text?: unknown; response?: unknown }>) {
        this.#next = history.map((h) => `${h.type}:${JSON.stringify(h.text ?? h.response ?? '')}`);
      }
      async prompt(text: string, o: { onTextChunk?: (t: string) => void } = {}) {
        const want = [...this.#next, `user:${JSON.stringify(text)}`];
        let same = 0;
        while (same < want.length && same < this.#held.length && want[same] === this.#held[same]) same += 1;
        turns.push({ context: this.#at, fresh: want.length - same, total: want.length });
        const answer = `答え(${text})`;
        this.#held = [...want, `model:${JSON.stringify([answer])}`];
        o.onTextChunk?.(answer);
        return answer;
      }
    },
  });
  return { load, contexts, turns };
}

type Msg = { role: 'system' | 'user' | 'assistant'; content: string };

async function send(url: string, ref: string, messages: Msg[], opts: { aux?: boolean; tools?: boolean } = {}): Promise<string> {
  const res = await fetch(`${url}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-aas-priority': '0', ...(opts.aux ? { [AUX_HEADER]: '1' } : {}) },
    body: JSON.stringify({
      model: ref, messages, stream: false,
      ...(opts.tools ? { tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }] } : {}),
    }),
  });
  const body = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  return body.choices?.[0]?.message?.content ?? '';
}

/** 2 回の頼み。どちらも「要る事実を挙げる（補助）→ 答える（会話）→ 指摘かどうかを判じる（補助）」の順に呼ぶ。 */
async function twoTurns(url: string, ref: string): Promise<void> {
  const SYSTEM: Msg = { role: 'system', content: '決まり' };
  const NEEDS: Msg = { role: 'system', content: '要る事実を挙げる係' };
  const JUDGE: Msg = { role: 'system', content: '指摘かどうかを判じる係' };
  await send(url, ref, [NEEDS, { role: 'user', content: '問い 1' }], { aux: true });
  const first = await send(url, ref, [SYSTEM, { role: 'user', content: '問い 1' }]);
  await send(url, ref, [JUDGE, { role: 'user', content: '問い 1 への答え' }], { aux: true });
  await send(url, ref, [NEEDS, { role: 'user', content: '問い 2' }], { aux: true });
  await send(url, ref, [SYSTEM, { role: 'user', content: '問い 1' }, { role: 'assistant', content: first }, { role: 'user', content: '問い 2' }]);
  await send(url, ref, [JUDGE, { role: 'user', content: '問い 2 への答え' }], { aux: true });
}

describe('補助の呼び出しは、会話の続きを壊さない', () => {
  test('補助の口が在ると、続きの頼みが読むのは新しい分だけ', async () => {
    const { dir, ref } = await withModel();
    const { load, contexts, turns } = trackingLib();
    const logs: string[] = [];
    const rt = new InProcRuntime({ modelsDir: dir, port: 0, load, sequences: 1, contextSize: 4096, onLog: (l) => logs.push(l) });
    running.push(rt);
    const { baseUrl } = await rt.ensureLoaded(ref);
    assert.equal(contexts.length, 1, '読み込んだだけでは、補助の context を開かない');
    await send(baseUrl, ref, [{ role: 'user', content: '会話だけ' }]);
    assert.equal(contexts.length, 1, '補助を使わない間は、補助の context を開かない');
    turns.length = 0;

    await twoTurns(baseUrl, ref);
    assert.equal(contexts.length, 2, '会話の context と補助の context の 2 つ（補助は 1 度だけ開く）');
    assert.deepEqual({ contextSize: contexts[1]!.contextSize, sequences: contexts[1]!.sequences }, { contextSize: AUX_WINDOW, sequences: 1 });
    assert.equal(logs.filter((l) => l.includes('補助の口を開きました')).length, 1, '開いたことが記録に 1 度出る');
    assert.deepEqual(turns.map((t) => t.context), [1, 0, 1, 1, 0, 1], '補助は補助の口、会話は会話の口');
    const [answer1, answer2] = turns.filter((t) => t.context === 0);
    assert.deepEqual(answer1, { context: 0, fresh: 2, total: 2 });
    // 2 回目の会話は 4 つ（決まり・問い 1・答え 1・問い 2）。前の 3 つは読んであり、読むのは問い 2 だけ
    assert.deepEqual(answer2, { context: 0, fresh: 1, total: 4 });
  });

  test('補助の口を切ると、同じ流れで会話の口が上書きされ、頭から読み直す（対）', async () => {
    const { dir, ref } = await withModel();
    const { load, contexts, turns } = trackingLib();
    const rt = new InProcRuntime({ modelsDir: dir, port: 0, load, sequences: 1, contextSize: 4096, auxWindow: 0 });
    running.push(rt);
    const { baseUrl } = await rt.ensureLoaded(ref);
    await twoTurns(baseUrl, ref);
    assert.equal(contexts.length, 1);
    assert.deepEqual(turns.map((t) => t.context), [0, 0, 0, 0, 0, 0]);
    assert.deepEqual(turns[4], { context: 0, fresh: 4, total: 4 }, '補助が上書きしたので、2 回目の会話は全部を読み直す');
  });

  test('補助の口は、会話のコンテキストウィンドウより広くしない', async () => {
    const { dir, ref } = await withModel();
    const { load, contexts } = trackingLib();
    const rt = new InProcRuntime({ modelsDir: dir, port: 0, load, sequences: 1, contextSize: 1024 });
    running.push(rt);
    const { baseUrl } = await rt.ensureLoaded(ref);
    await send(baseUrl, ref, [{ role: 'user', content: '問い' }], { aux: true });
    assert.equal(contexts[1]!.contextSize, 1024);
  });

  test('入り切らない長さ・ツール付きの補助の呼び出しは、会話の口で回る', async () => {
    const { dir, ref } = await withModel();
    const { load, turns } = trackingLib();
    const rt = new InProcRuntime({ modelsDir: dir, port: 0, load, sequences: 1, contextSize: 4096, auxWindow: 100 });
    running.push(rt);
    const { baseUrl } = await rt.ensureLoaded(ref);
    await send(baseUrl, ref, [{ role: 'user', content: 'あ'.repeat(50) }], { aux: true });
    await send(baseUrl, ref, [{ role: 'user', content: 'あ'.repeat(51) }], { aux: true });
    await send(baseUrl, ref, [{ role: 'user', content: '短い' }], { aux: true, tools: true });
    assert.deepEqual(turns.map((t) => t.context), [1, 0, 0]);
    assert.equal(fitsAux(50, 100), true);
    assert.equal(fitsAux(51, 100), false);
    assert.equal(fitsAux(0, 0), false);
  });

  test('補助の口を開けなくても、補助の呼び出しは会話の口で答える（開き直しは 1 度だけ試す）', async () => {
    const { dir, ref } = await withModel();
    const { load, contexts, turns } = trackingLib({ failSecondContext: true });
    const logs: string[] = [];
    const rt = new InProcRuntime({ modelsDir: dir, port: 0, load, sequences: 1, contextSize: 4096, onLog: (l) => logs.push(l) });
    running.push(rt);
    const { baseUrl } = await rt.ensureLoaded(ref);
    assert.equal(await send(baseUrl, ref, [{ role: 'user', content: '問い' }], { aux: true }), '答え(問い)');
    assert.equal(await send(baseUrl, ref, [{ role: 'user', content: '問い 2' }], { aux: true }), '答え(問い 2)');
    assert.equal(contexts.length, 1);
    assert.equal(logs.filter((l) => l.includes('補助の口を開けませんでした（メモリが足りません（試験））')).length, 1, logs.join('\n'));
    assert.deepEqual(turns.map((t) => t.context), [0, 0]);
  });

  test('降ろすと、補助の context も解く', async () => {
    const { dir, ref } = await withModel();
    const { load, contexts } = trackingLib();
    const rt = new InProcRuntime({ modelsDir: dir, port: 0, load, sequences: 1, contextSize: 4096 });
    running.push(rt);
    const { baseUrl } = await rt.ensureLoaded(ref);
    await send(baseUrl, ref, [{ role: 'user', content: '問い' }], { aux: true });
    await rt.unload(ref);
    assert.deepEqual(contexts.map((c) => c.disposed), [true, true]);
  });
});

describe('補助の合図の配線: 送る側', () => {
  test('合図は `1` だけ', () => {
    assert.equal(isAux('1'), true);
    assert.equal(isAux(['1']), true);
    for (const v of [undefined, '', '0', 'true', 'yes', 1]) assert.equal(isAux(v), false, String(v));
  });

  test('provider は aux があるときだけヘッダを付ける', async () => {
    const seen: Array<string | undefined> = [];
    const server = createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        const h = req.headers[AUX_HEADER];
        seen.push(Array.isArray(h) ? h[0] : h);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
        res.end('data: [DONE]\n\n');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const port = (server.address() as { port: number }).port;
      const provider = new OpenAiCompatibleProvider({ id: 'p', baseUrl: `http://127.0.0.1:${port}/v1`, locality: 'local' });
      const req: ProviderRequest = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
      for await (const _ of provider.chat({ ...req, aux: true }, new AbortController().signal)) { /* 読み切る */ }
      for await (const _ of provider.chat(req, new AbortController().signal)) { /* 読み切る */ }
      assert.deepEqual(seen, ['1', undefined]);
    } finally { await new Promise<void>((r) => server.close(() => r())); }
  });

  test('orchestrator は aux をそのまま渡し、要る事実を挙げる段は合図を付けて呼ぶ', async () => {
    const got: Array<boolean | 'absent'> = [];
    const fake: ChatProvider = {
      id: 'fake', locality: 'local',
      health: async () => ({ ok: true }),
      listModels: async () => [{ id: 'fake:m', providerId: 'fake', model: 'm', displayName: 'm', locality: 'local' }],
      async *chat(req: ProviderRequest): AsyncIterable<ProviderChunk> {
        got.push('aux' in req ? Boolean(req.aux) : 'absent');
        yield { type: 'text', delta: '[]' };
        yield { type: 'done', finishReason: 'stop' };
      },
    };
    const registry = new ProviderRegistry();
    registry.register(fake);
    const orch = new ChatOrchestrator(registry);
    const messages = [{ role: 'user' as const, content: 'hi' }];
    for await (const _ of orch.run({ candidates: ['fake:m'], messages }, new AbortController().signal)) { /* 読み切る */ }
    await new InnerNeedLister(orch).list({ candidates: ['fake:m'], messages }, new AbortController().signal);
    assert.deepEqual(got, ['absent', true]);
  });
});
