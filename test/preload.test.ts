/**
 * 起動したら裏でモデルを読んでおく（常時ロード）。
 *
 * 送るときに読み始めると、最初の送信で数分待つ。先に読んでおけば、
 * 送った瞬間から答えに入れる。読んでいる最中に送っても二重には読まず、
 * 読めたら答える。`runtime.warm.enabled: false` なら読まない。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tempDir } from './tmp.ts';
import { until } from './until.ts';

const dir = await tempDir('aas-preload-');
process.env.AAS_HOME = dir;
process.env.AAS_STATE_DIR = join(dir, 'state');
const { UiServer } = await import('../src/ui/server.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

function mockLib(gate: Promise<void>, counter: { loads: number }) {
  return async () => ({
    getLlama: async () => ({
      loadModel: async () => {
        counter.loads++;
        await gate;
        return { createContext: async () => ({ getSequence: () => ({}), dispose: async () => {} }) };
      },
    }),
    LlamaChatSession: class {
      setChatHistory() {}
      async prompt(_t: string, o: { onTextChunk?: (t: string) => void } = {}) {
        for (const ch of [...'先に読んでおいた']) o.onTextChunk?.(ch);
        return '先に読んでおいた';
      }
    },
  });
}

async function build(opts: { gate: Promise<void>; counter: { loads: number }; warm?: { enabled: boolean } }) {
  const models = await tempDir('aas-preload-models-');
  await writeFile(join(models, 'a.gguf'), 'GGUF');
  const port = await freePort();
  const s = new UiServer({
    port: 0, inprocLoad: mockLib(opts.gate, opts.counter),
    config: {
      ...DEFAULT_CONFIG,
      providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1`, locality: 'local', models: ['a.gguf'] }],
      candidates: ['local:a.gguf'],
      runtime: { kind: 'inproc', modelsDir: models, basePort: port, ...(opts.warm ? { warm: opts.warm } : {}) },
      initiative: { enabled: false },
    } as typeof DEFAULT_CONFIG,
  });
  const base = (await s.start()).replace(/\/$/, '');
  return { s, base };
}

async function sendHi(base: string): Promise<{ status: number; body: { loading?: boolean; conversationId?: string } }> {
  const r = await fetch(`${base}/api/send`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'こんにちは' }),
  });
  return { status: r.status, body: await r.json() as { loading?: boolean; conversationId?: string } };
}

async function answered(base: string, id: string): Promise<boolean> {
  const m = await (await fetch(`${base}/api/conversations/messages?id=${id}`)).json() as { messages: { role: string }[] };
  return m.messages.some((x) => x.role === 'assistant');
}

describe('起動したら裏で読んでおく', () => {
  test('送っていなくても読む。読めたあとの送りは、読み込みを待たない', async () => {
    const counter = { loads: 0 };
    const { s, base } = await build({ gate: Promise.resolve(), counter });
    try {
      await s.preload();
      assert.equal(counter.loads, 1, '起動時に読んでいない');
      const r = await sendHi(base);
      assert.equal(r.status, 202);
      assert.equal(r.body.loading, false, '読めているのに、読み込みからやり直している');
      await until(() => answered(base, r.body.conversationId!), '答えが返る');
      assert.equal(counter.loads, 1, '二度読んでいる');
    } finally {
      await s.stop();
    }
  });

  test('読んでいる最中に送っても、二重には読まず、読めたら答える', async () => {
    const counter = { loads: 0 };
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const { s, base } = await build({ gate, counter });
    // 記録は、このファイルのテストで共有している。前のテストが言った分を引く。
    const log = join(dir, 'state', 'logs', 'ui.log');
    const said = async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter((l) => l.includes('モデルを読み込んでいます: a.gguf')).length;
    const before = await said();
    try {
      const warming = s.preload();
      await until(() => counter.loads === 1, '読み始める');
      const r = await sendHi(base);
      assert.equal(r.status, 202, '読んでいる最中の送りを断っている');
      release();
      await warming;
      await until(() => answered(base, r.body.conversationId!), '読めたら答える');
      assert.equal(counter.loads, 1, '送りが、起動時の読み込みと別にもう一度読んでいる');
      // 読む側（runtime）が同じ読み込みをまとめるので、数は 1 のまま。
      // 画面側が二度「読み込んでいます」と言っていないかは、記録で見る。
      // 二度言うと、二つ目の「まだ読み込んでいます」が 10 秒ごとに流れ続ける。
      await until(async () => (await said()) - before >= 1, '記録に残る');
      assert.equal((await said()) - before, 1, '読み込んでいます、と二度言っている（送りが起動時の読み込みを待っていない）');
    } finally {
      await s.stop();
    }
  });

  test('warm.enabled: false なら、頼まれるまで読まない（対）', async () => {
    const counter = { loads: 0 };
    const { s, base } = await build({ gate: Promise.resolve(), counter, warm: { enabled: false } });
    try {
      await s.preload();
      assert.equal(counter.loads, 0, '切っているのに読んでいる');
      const r = await sendHi(base);
      assert.equal(r.status, 202);
      assert.equal(r.body.loading, true);
      await until(() => answered(base, r.body.conversationId!), '頼まれてから読んで答える');
      assert.equal(counter.loads, 1);
    } finally {
      await s.stop();
    }
  });
});

describe('読んでいる最中だと、状態の口が言う', () => {
  test('読んでいる間は loading が付き、読めたら消える', async () => {
    const counter = { loads: 0 };
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const { s, base } = await build({ gate, counter });
    try {
      const warming = s.preload();
      await until(() => counter.loads === 1, '読み始める');
      const mid = await (await fetch(`${base}/api/info`)).json() as { loading?: { ref: string; seconds: number } };
      assert.equal(mid.loading?.ref, 'a.gguf', '読んでいるのに言わない');
      release();
      await warming;
      const after = await (await fetch(`${base}/api/info`)).json() as { loading?: unknown };
      assert.equal(after.loading, undefined, '読めたのに、まだ読んでいると言う');
    } finally {
      await s.stop();
    }
  });
});
