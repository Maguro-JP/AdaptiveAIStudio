/**
 * 大きいモデルは要るときだけ使う（docs/NETWORK-MODEL.md の「大きいモデルは要るときだけ」）。
 *
 * 普段は小さいモデルで答え、確かめで押し戻された頼み（押し戻しが続いた・試験が通らなかった）だけを、ネットワークの送り口が
 * 大きいモデルに回す。置いて無い・計画で動かないなら回さず、1 行で言う。設定で切れる。
 * ここは、押し戻しの数え方・行き先の選び方・大きいモデルの選び方・本物の押し戻し（Agent）からの繋ぎ・設定の API を、偽のモデルで見る。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { open, readFile, writeFile } from 'node:fs/promises';
import { tempDir } from './tmp.ts';
import { ProviderRegistry } from '../src/core/registry.ts';
import { ChatOrchestrator, type ChatEvent } from '../src/core/orchestrator.ts';
import {
  NetworkProvider, NETWORK_MODEL_ID, pushedBack, ESCALATE_AFTER_NUDGES, type EscalateAnswer, type NetworkOptions,
} from '../src/core/network-provider.ts';
import { pickLargeModel } from '../src/runtime/large-model.ts';
import type { ProviderMessage as ChatMessage, ChatProvider, ProviderChunk } from '../src/providers/contract.ts';
import { OpenAiCompatibleProvider } from '../src/providers/openai-compatible.ts';
import { Agent, type AgentEvent } from '../src/agent/loop.ts';
import { readFileTool, writeFileTool } from '../src/agent/tools/fs.ts';
import { DONE_MARK } from '../src/agent/done.ts';

// 設定と覚えを、試験専用の場所へ移してから画面の本体を読み込む
const HOME = await tempDir('aas-escalate-home-');
process.env.AAS_STATE_DIR = HOME;
process.env.AAS_CONFIG = join(HOME, 'aas.config.json');
await writeFile(process.env.AAS_CONFIG, '{}');
const { UiServer } = await import('../src/ui/server.ts');

const user = (content: string): ChatMessage => ({ role: 'user', content });
const nudge = (content = '次の一手を。', more: Partial<ChatMessage> = {}): ChatMessage => ({ role: 'user', content, nudge: true, ...more });
const said = (content: string): ChatMessage => ({ role: 'assistant', content });

describe('押し戻しの数え方', () => {
  test(`最後の利用者の一言のあとの押し戻しを数える。${ESCALATE_AFTER_NUDGES} 回続いたら回す。1 回では回さない（対）`, () => {
    assert.deepEqual(pushedBack([user('直して')], {}), { nudges: 0, verifyFailed: false, escalate: false });
    assert.equal(pushedBack([user('直して'), said('直します'), nudge()], {}).escalate, false);
    const twice = pushedBack([user('直して'), said('直します'), nudge(), said('通りました'), nudge()], {});
    assert.deepEqual(twice, { nudges: 2, verifyFailed: false, escalate: true });
  });

  test('前の頼みの押し戻しは数えない（新しい一言が来たら、また普段のモデルから）', () => {
    const next = pushedBack([user('直して'), nudge(), nudge(), said('直しました'), user('ありがとう。次はこれ')], {});
    assert.deepEqual(next, { nudges: 0, verifyFailed: false, escalate: false });
  });

  test('確かめ（試験）が通らなかった差し戻しは、1 回でも回す', () => {
    const got = pushedBack([user('直して'), said('直しました'), nudge('試験が 1 件落ちています', { verifyFailed: true })], {});
    assert.deepEqual(got, { nudges: 1, verifyFailed: true, escalate: true });
  });

  test('試験の口（AAS_TEST_PUSHBACKS）は、その回数の押し戻しがあったものとして扱う。立てなければ何も変わらない（対）', () => {
    assert.equal(pushedBack([user('直して')], { AAS_TEST_PUSHBACKS: '2' }).escalate, true);
    assert.equal(pushedBack([user('直して')], { AAS_TEST_PUSHBACKS: '1' }).escalate, false);
    assert.equal(pushedBack([user('直して')], { AAS_TEST_PUSHBACKS: '' }).escalate, false);
  });
});

/** 中のモデルの代わり。どのモデルの名前で頼まれたかを覚える。`failFor` の名前で頼まれたら落ちる。 */
function fakeInner(failFor?: string): ChatProvider & { asked: string[] } {
  const asked: string[] = [];
  return {
    id: 'p', locality: 'local', asked,
    async health() { return { ok: true }; },
    async listModels() { return [{ id: 'p:small', providerId: 'p', model: 'small', displayName: 'small', locality: 'local' }]; },
    async *chat(req): AsyncIterable<ProviderChunk> {
      asked.push(req.model);
      if (req.model === failFor) throw new Error('読めませんでした');
      yield { type: 'text', delta: `${req.model} の答え` };
      yield { type: 'done', finishReason: 'stop' };
    },
  };
}

async function drain(gen: AsyncGenerator<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

async function relay(messages: ChatMessage[], opts: NetworkOptions, failFor?: string) {
  const registry = new ProviderRegistry();
  const inner = fakeInner(failFor);
  registry.register(inner);
  const logs: string[] = [];
  const network = new NetworkProvider(registry, () => ['p:small'], { log: (_l, m) => logs.push(m), ...opts });
  registry.register(network);
  const ask = (m: ChatMessage[]) => drain(new ChatOrchestrator(registry).run({ candidates: [NETWORK_MODEL_ID, 'p:small'], messages: m }, new AbortController().signal));
  const events = await ask(messages);
  return { events, inner, logs, ask };
}

const READY = async (): Promise<EscalateAnswer> => ({ state: 'ready', candidate: 'p:big', label: 'big.gguf' });
const PUSHED = [user('直して'), said('直します'), nudge(), said('通りました'), nudge()];

describe('行き先を、ネットワークの送り口が選ぶ', () => {
  test('押し戻しが続いた頼みは、大きいモデルが答える。切り替えの出来事と記録が出て、同じ頼みの中では繰り返さない', async () => {
    const r = await relay(PUSHED, { escalate: READY });
    assert.deepEqual(r.inner.asked, ['big']);
    const done = r.events.find((e) => e.type === 'done');
    assert.equal(done?.type === 'done' ? done.modelId : undefined, 'p:big');
    assert.deepEqual(r.events.filter((e) => e.type === 'fallback'), [{ type: 'fallback', from: 'p:small', to: 'p:big', reason: '押し戻しが 2 回続いたので、大きいモデルに回します' }]);
    assert.deepEqual(r.logs.filter((l) => l.includes('大きいモデル')), ['ネットワーク: 押し戻しが 2 回続いたので、大きいモデル（big.gguf）に回します']);
    // 同じ頼みの続き（ツールの結果のあと）も大きいモデルへ。同じ一行は繰り返さない
    const more = await r.ask([...PUSHED, said('書きました')]);
    assert.deepEqual(r.inner.asked, ['big', 'big']);
    assert.equal(more.filter((e) => e.type === 'fallback').length, 0);
    assert.equal(r.logs.filter((l) => l.includes('に回します')).length, 1);
  });

  test('押し戻されていない頼み・1 回だけ押し戻された頼みは、普段のモデルが答える（対）', async () => {
    for (const messages of [[user('こんにちは')], [user('直して'), said('直します'), nudge()]]) {
      const r = await relay(messages, { escalate: READY });
      assert.deepEqual(r.inner.asked, ['small']);
      assert.equal(r.events.some((e) => e.type === 'fallback' || e.type === 'notice'), false);
      assert.equal(r.logs.some((l) => l.includes('大きいモデル')), false);
    }
  });

  test('確かめ（試験）が通らなかった頼みは、1 回の差し戻しで回す。理由もそう言う', async () => {
    const r = await relay([user('直して'), said('直しました'), nudge('試験が落ちています', { verifyFailed: true })], { escalate: READY });
    assert.deepEqual(r.inner.asked, ['big']);
    const ev = r.events.find((e) => e.type === 'fallback');
    assert.equal(ev?.type === 'fallback' ? ev.reason : '', '確かめ（試験）が通らなかったので、大きいモデルに回します');
  });

  test('大きいモデルが置いて無い・計画で動かないなら、回さずに 1 行で言う（頼みごとに一度だけ）', async () => {
    const none = async (): Promise<EscalateAnswer> => ({ state: 'none', why: '今のモデルより大きいモデルが置いてありません' });
    const r = await relay(PUSHED, { escalate: none });
    assert.deepEqual(r.inner.asked, ['small']);
    assert.deepEqual(r.events.filter((e) => e.type === 'notice'), [{ type: 'notice', text: '大きいモデルに回しませんでした（今のモデルより大きいモデルが置いてありません）。今のモデルで続けます' }]);
    assert.deepEqual(r.logs.filter((l) => l.includes('大きいモデル')), ['ネットワーク: 押し戻しが 2 回続いた頼みですが、大きいモデルに回しませんでした（今のモデルより大きいモデルが置いてありません）。今のモデルで続けます']);
    const more = await r.ask([...PUSHED, said('書きました')]);
    assert.equal(more.some((e) => e.type === 'notice'), false);
    assert.equal(r.logs.filter((l) => l.includes('回しませんでした')).length, 1);
  });

  test('設定で切ってあれば、回さず、何も言わない。渡さなければ、訊きもしない（今までどおり）', async () => {
    const off = await relay(PUSHED, { escalate: async () => ({ state: 'off' }) });
    assert.deepEqual(off.inner.asked, ['small']);
    assert.equal(off.events.some((e) => e.type === 'fallback' || e.type === 'notice'), false);
    assert.equal(off.logs.some((l) => l.includes('大きいモデル')), false);
    const plain = await relay(PUSHED, {});
    assert.deepEqual(plain.inner.asked, ['small']);
  });

  test('押し戻されていない間は、回す先を訊かない（毎回の頼みで、モデルの一覧と計画を調べない）', async () => {
    let askedTimes = 0;
    const counting = async (): Promise<EscalateAnswer> => { askedTimes += 1; return READY(); };
    await relay([user('こんにちは')], { escalate: counting });
    assert.equal(askedTimes, 0);
    await relay(PUSHED, { escalate: counting });
    assert.equal(askedTimes, 1);
  });

  test('大きいモデルが落ちたら、普段のモデルに戻って答える（専用の別経路ではなく、候補の並びで回している）', async () => {
    const r = await relay(PUSHED, { escalate: READY }, 'big');
    assert.deepEqual([...new Set(r.inner.asked)], ['big', 'small']);
    assert.equal(r.inner.asked.at(-1), 'small');
    const done = r.events.find((e) => e.type === 'done');
    assert.equal(done?.type === 'done' ? done.modelId : undefined, 'p:small');
  });

  test('回す先を調べられなかったら、回さずにそう言う（頼みは止めない）', async () => {
    const r = await relay(PUSHED, { escalate: async () => { throw new Error('一覧を読めません'); } });
    assert.deepEqual(r.inner.asked, ['small']);
    assert.match(r.logs.join('\n'), /大きいモデルに回しませんでした（回す先を調べられませんでした（一覧を読めません））/);
  });
});

describe('どのモデルを「大きい」とするか', () => {
  const models = [{ ref: 'small.gguf', sizeBytes: 1 }, { ref: 'mid.gguf', sizeBytes: 5 }, { ref: 'big.gguf', sizeBytes: 9 }];
  const all = async () => true;

  test('既定は、取ってある中で、今のモデルより大きく動くもののうち、いちばん大きいもの', async () => {
    assert.deepEqual(await pickLargeModel({ models, current: 'small.gguf', canRun: all }), { ref: 'big.gguf' });
    // いちばん大きいものが計画で動かなければ、動く中でいちばん大きいもの
    assert.deepEqual(await pickLargeModel({ models, current: 'small.gguf', canRun: async (m) => m.ref !== 'big.gguf' }), { ref: 'mid.gguf' });
  });

  test('今のモデルより大きいものが無ければ、置いて無いと言う。在っても動かなければ、動かないと言う', async () => {
    assert.deepEqual(await pickLargeModel({ models, current: 'big.gguf', canRun: all }), { why: '今のモデルより大きいモデルが置いてありません' });
    assert.deepEqual(await pickLargeModel({ models: [models[0]!], current: 'small.gguf', canRun: all }), { why: '今のモデルより大きいモデルが置いてありません' });
    assert.deepEqual(await pickLargeModel({ models, current: 'small.gguf', canRun: async () => false }), { why: '大きいモデル（big.gguf）は、この PC の計画では動きません' });
  });

  test('設定で名前を決めてあれば、それ。置いて無い・動かないなら、そう言う（別のものに黙って替えない）', async () => {
    assert.deepEqual(await pickLargeModel({ models, current: 'small.gguf', wanted: 'mid.gguf', canRun: all }), { ref: 'mid.gguf' });
    assert.deepEqual(await pickLargeModel({ models, current: 'small.gguf', wanted: 'x.gguf', canRun: all }), { why: '設定で決めた大きいモデル（x.gguf）が置いてありません' });
    assert.deepEqual(await pickLargeModel({ models, current: 'small.gguf', wanted: 'big.gguf', canRun: async () => false }), { why: '設定で決めた大きいモデル（big.gguf）は、この PC の計画では動きません' });
    assert.deepEqual(await pickLargeModel({ models, current: 'mid.gguf', wanted: 'mid.gguf', canRun: all }), { why: '設定で決めた大きいモデル（mid.gguf）は、今のモデルです' });
  });
});

type Step = { text: string } | { tool: string; args: unknown };

/** 台本どおりに返す偽モデル。最後の手は繰り返す。 */
async function scripted(script: Step[]) {
  let turn = 0;
  const server = createServer((req, res) => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"data":[{"id":"m"}]}');
    }
    req.on('data', () => {});
    req.on('end', () => {
      const step = script[Math.min(turn, script.length - 1)]!;
      turn += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if ('text' in step) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: step.text } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `c${turn}`, function: { name: step.tool, arguments: JSON.stringify(step.args) } }] } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    turns: () => turn,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

describe('本物の押し戻し（Agent）から、大きいモデルへ', () => {
  /** 小さいモデルは「読んで、書き換えますと言うだけ」を繰り返す。大きいモデルは書いて、済んだと言う。 */
  async function work(escalate: NetworkOptions['escalate']) {
    const root = await tempDir('aas-escalate-work-');
    await writeFile(join(root, 'a.txt'), 'もとの中身\n');
    const small = await scripted([{ tool: 'read_file', args: { path: 'a.txt' } }, { text: 'では書き換えます。' }]);
    const big = await scripted([{ tool: 'write_file', args: { path: 'a.txt', content: '大きいモデルが書きました\n' } }, { text: `${DONE_MARK}\n` }]);
    const registry = new ProviderRegistry();
    registry.register(new OpenAiCompatibleProvider({ id: 'small', baseUrl: small.baseUrl, locality: 'local', fallbackModels: ['m'] }));
    registry.register(new OpenAiCompatibleProvider({ id: 'big', baseUrl: big.baseUrl, locality: 'local', fallbackModels: ['m'] }));
    const logs: string[] = [];
    registry.register(new NetworkProvider(registry, () => ['small:m'], { log: (_l, m) => logs.push(m), ...(escalate ? { escalate } : {}) }));
    const agent = new Agent(new ChatOrchestrator(registry), {
      candidates: [NETWORK_MODEL_ID, 'small:m'], system: 'テスト', tools: [readFileTool, writeFileTool], root, approve: () => Promise.resolve(true),
    });
    const events: AgentEvent[] = [];
    try {
      for await (const ev of agent.run([{ role: 'user', content: 'a.txt を書き換えて' }], new AbortController().signal)) events.push(ev);
    } finally { await small.close(); await big.close(); }
    return { events, logs, bigTurns: big.turns(), file: await readFile(join(root, 'a.txt'), 'utf8') };
  }

  test('小さいモデルが 2 回押し戻されたら、その頼みの続きを大きいモデルが引き取り、書いて終える。画面に出る出来事も届く', async () => {
    const r = await work(async () => ({ state: 'ready', candidate: 'big:m', label: 'big.gguf' }));
    assert.equal(r.events.filter((e) => e.type === 'nudged').length, 2);
    assert.deepEqual(r.events.filter((e) => e.type === 'fallback'), [{ type: 'fallback', from: 'small:m', to: 'big:m', reason: '押し戻しが 2 回続いたので、大きいモデルに回します' }]);
    assert.equal(r.file, '大きいモデルが書きました\n');
    const last = r.events.at(-1);
    assert.equal(last?.type, 'finished');
    assert.equal(last?.type === 'finished' ? last.reason : '', 'completed');
    assert.equal(r.logs.filter((l) => l.includes('に回します')).length, 1);
  });

  test('回す先を渡さなければ、今までどおり小さいモデルのまま進めず、動かないと言う（対）', async () => {
    const r = await work(undefined);
    assert.equal(r.bigTurns, 0, '渡していないのに、大きいモデルを呼んでいる');
    assert.equal(r.file, 'もとの中身\n');
    const last = r.events.at(-1);
    assert.equal(last?.type === 'finished' ? last.reason : '', 'noProgress');
  });

  test('回す先が無ければ、その頼みで一度だけ知らせて、小さいモデルで続ける', async () => {
    const r = await work(async () => ({ state: 'none', why: '今のモデルより大きいモデルが置いてありません' }));
    assert.equal(r.bigTurns, 0);
    assert.deepEqual(r.events.filter((e) => e.type === 'notice'), [{ type: 'notice', text: '大きいモデルに回しませんでした（今のモデルより大きいモデルが置いてありません）。今のモデルで続けます' }]);
  });
});

/** 中身の無い（疎な）.gguf。大きさだけが本物。 */
async function sparse(dir: string, name: string, bytes: number): Promise<void> {
  const fh = await open(join(dir, name), 'w');
  try { await fh.write('GGUF'); await fh.truncate(bytes); } finally { await fh.close(); }
}

function fakeLib() {
  return async () => ({
    getLlama: async () => ({
      loadModel: async (o: { onLoadProgress?: (d: number) => void }) => {
        o.onLoadProgress?.(1);
        return { dispose: async () => {}, createContext: async () => ({ getSequence: () => ({}), dispose: async () => {} }) };
      },
    }),
    LlamaChatSession: class { setChatHistory() {} async prompt() { return ''; } },
  });
}

describe('設定の API', () => {
  const MB = 1024 ** 2;
  interface Answer { enabled: boolean; target: { ready: boolean; label?: string; why?: string } }
  async function withServer<T>(models: string, model: string, body: (base: string) => Promise<T>): Promise<T> {
    const server = new UiServer({
      config: {
        providers: [], candidates: [], runtime: { kind: 'inproc', modelsDir: models, model },
        agent: { root: await tempDir('aas-escalate-root-'), approval: 'auto', verify: { enabled: false } }, initiative: { enabled: false },
      } as never,
      port: 0, inprocLoad: fakeLib() as never,
    });
    try { return await body((await server.start()).replace(/\/$/, '')); } finally { await server.stop(); }
  }
  const put = (base: string, enabled: unknown) => fetch(`${base}/api/escalate`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }),
  });

  test('既定は入り。回す先（今のモデルより大きい、動くもののうち一番大きいもの）が見える。切ると設定に書かれ、入れ直すと消える', async () => {
    const models = await tempDir('aas-escalate-models-');
    await sparse(models, 'small.gguf', 1 * MB);
    await sparse(models, 'mid.gguf', 2 * MB);
    await sparse(models, 'big.gguf', 3 * MB);
    await withServer(models, 'small.gguf', async (base) => {
      const first = await (await fetch(`${base}/api/escalate`)).json() as Answer;
      assert.deepEqual(first, { enabled: true, target: { ready: true, label: 'big.gguf' } });

      const off = await (await put(base, false)).json() as Answer;
      assert.equal(off.enabled, false);
      assert.equal(off.target.label, 'big.gguf', '切ってあるときも、入れたらどこへ回るかを見せる');
      assert.deepEqual(JSON.parse(await readFile(process.env.AAS_CONFIG!, 'utf8')).escalate, { enabled: false });

      const on = await (await put(base, true)).json() as Answer;
      assert.equal(on.enabled, true);
      assert.equal(JSON.parse(await readFile(process.env.AAS_CONFIG!, 'utf8')).escalate, undefined, '既定に戻したのに、切り替えが設定に残っている');
      assert.equal((await put(base, 'yes')).status, 400);
    });
  });

  test('今のモデルが一番大きいとき・一つしか無いときは、回せない理由が見える（対）', async () => {
    const models = await tempDir('aas-escalate-models-one-');
    await sparse(models, 'small.gguf', 1 * MB);
    await sparse(models, 'big.gguf', 3 * MB);
    await withServer(models, 'big.gguf', async (base) => {
      const got = await (await fetch(`${base}/api/escalate`)).json() as Answer;
      assert.deepEqual(got, { enabled: true, target: { ready: false, why: '今のモデルより大きいモデルが置いてありません' } });
    });
  });

  test('大きいモデルが、この PC の計画で動かないときは、そう見える（メモリ 1MB・ページングなしに見せる）', async () => {
    const models = await tempDir('aas-escalate-models-no-');
    await sparse(models, 'small.gguf', 1 * MB);
    await sparse(models, 'big.gguf', 3 * MB);
    const before = { ram: process.env.AAS_TEST_RAM_BYTES, paging: process.env.AAS_TEST_PAGING_BYTES };
    process.env.AAS_TEST_RAM_BYTES = String(1 * MB);
    process.env.AAS_TEST_PAGING_BYTES = '0';
    try {
      await withServer(models, 'small.gguf', async (base) => {
        const got = await (await fetch(`${base}/api/escalate`)).json() as Answer;
        assert.deepEqual(got, { enabled: true, target: { ready: false, why: '大きいモデル（big.gguf）は、この PC の計画では動きません' } });
      });
    } finally {
      if (before.ram === undefined) delete process.env.AAS_TEST_RAM_BYTES; else process.env.AAS_TEST_RAM_BYTES = before.ram;
      if (before.paging === undefined) delete process.env.AAS_TEST_PAGING_BYTES; else process.env.AAS_TEST_PAGING_BYTES = before.paging;
    }
  });
});
