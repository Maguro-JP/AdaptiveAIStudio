/**
 * 画面の口から送って、模型の返事が流れとして戻るまでを、通しで見る。
 *
 * 今日足した関門（よその頁を断る・本文の上限・支度中の塞ぎ）が、
 * **ふつうの一往復を壊していない**ことを、ここでだけ確かめられる。
 * 本物のモデルは要らない。決まった返事をする相手を立てる。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './tmp.ts';
import { startFakeServer, type FakeServer } from './fake-server.ts';

process.env.AAS_STATE_DIR = await tempDir('aas-e2e-');
const { UiServer } = await import('../src/ui/server.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');

let fake: FakeServer;
let server: InstanceType<typeof UiServer>;
let base = '';

before(async () => {
  fake = await startFakeServer({ kind: 'stream', text: 'こんにちは、世界' });
  server = new UiServer({
    port: 0,
    config: {
      ...DEFAULT_CONFIG,
      providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: fake.baseUrl, locality: 'local', models: ['m'] }],
      candidates: ['local:m'],
      runtime: { kind: 'ollama' },
    } as typeof DEFAULT_CONFIG,
  });
  base = (await server.start()).replace(/\/$/, '');
});
after(async () => { await server.stop(); await fake.close(); });

/** 流れを読んで、条件を満たすまで出来事を溜める。 */
async function collect(until: (events: unknown[]) => boolean, ms = 20_000): Promise<unknown[]> {
  const events: unknown[] = [];
  const ac = new AbortController();
  const res = await fetch(`${base}/api/events`, { signal: ac.signal });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const deadline = Date.now() + ms;
  try {
    while (Date.now() < deadline) {
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((r) => setTimeout(() => r({ done: true, value: undefined }), 500)),
      ]);
      if (value) buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n\n')) !== -1) {
        const chunk = buf.slice(0, nl); buf = buf.slice(nl + 2);
        for (const line of chunk.split('\n')) {
          if (line.startsWith('data: ')) { try { events.push(JSON.parse(line.slice(6))); } catch { /* 注釈 */ } }
        }
      }
      if (until(events)) break;
      if (done && !value) continue;
    }
  } finally { ac.abort(); }
  return events;
}

describe('送って、返事が戻る', () => {
  test('一往復が通る', async () => {
    const done = (evs: unknown[]) => evs.some((e) => (e as { type?: string; busy?: boolean }).type === 'busy' && (e as { busy?: boolean }).busy === false);
    const collecting = collect(done);
    await new Promise((r) => setTimeout(r, 200));
    const r = await fetch(`${base}/api/send`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'あいさつして' }),
    });
    assert.equal(r.status, 202, await r.text());
    const events = await collecting;
    assert.ok(done(events), '終わりが流れてこない');
    const text = events
      .filter((e) => (e as { type?: string }).type === 'session')
      .map((e) => (e as { event: { type?: string; delta?: string } }).event)
      .filter((ev) => ev.type === 'text')
      .map((ev) => ev.delta ?? '')
      .join('');
    assert.ok(text.includes('こんにちは'), `返事が流れていない: ${JSON.stringify(events).slice(0, 400)}`);
    assert.ok(fake.requests >= 1, '相手に届いていない');
  });
});

describe('途中でやめる', () => {
  test('相手が黙っていても、やめれば戻ってくる', async () => {
    // 相手が返さない（hang）。やめる を押したら、待たされずに終わりが来ること。
    fake.setBehavior({ kind: 'hang' });
    try {
      const done = (evs: unknown[]) => evs.some((e) => (e as { type?: string; busy?: boolean }).type === 'busy' && (e as { busy?: boolean }).busy === false);
      const collecting = collect(done, 20_000);
      await new Promise((r) => setTimeout(r, 200));
      const r = await fetch(`${base}/api/send`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '黙る相手へ' }),
      });
      assert.equal(r.status, 202, await r.text());
      await new Promise((r2) => setTimeout(r2, 800));
      const began = Date.now();
      assert.equal((await fetch(`${base}/api/abort`, { method: 'POST' })).status, 200);
      const events = await collecting;
      assert.ok(done(events), 'やめたのに終わりが来ない');
      assert.ok(Date.now() - began < 10_000, `やめてから戻るまでが長い: ${Date.now() - began}ms`);
    } finally {
      fake.setBehavior({ kind: 'stream', text: 'こんにちは、世界' });
    }
  });
});

describe('この中で読む道でも、一往復が通る', () => {
  test('GGUF を置いた場所から読み、返事が流れる', async () => {
    const { join } = await import('node:path');
    const { writeFile } = await import('node:fs/promises');
    const { createServer } = await import('node:http');
    const models = await tempDir('aas-e2e-gguf-');
    await writeFile(join(models, 'a.gguf'), 'x');
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((r) => probe.close(() => r()));

    const said = 'この中から、こんにちは';
    const load = async () => ({
      getLlama: async () => ({
        loadModel: async () => ({ createContext: async () => ({ getSequence: () => ({}), dispose: async () => {} }) }),
      }),
      LlamaChatSession: class {
        setChatHistory() {}
        async prompt(_t: string, o: { onTextChunk?: (t: string) => void } = {}) {
          for (const ch of [...said]) o.onTextChunk?.(ch);
          return said;
        }
      },
    });
    const s2 = new UiServer({
      port: 0,
      inprocLoad: load,
      config: {
        ...DEFAULT_CONFIG,
        providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1`, locality: 'local', models: ['a.gguf'] }],
        candidates: ['local:a.gguf'],
        runtime: { kind: 'inproc', modelsDir: models, basePort: port },
      } as typeof DEFAULT_CONFIG,
    });
    const b2 = (await s2.start()).replace(/\/$/, '');
    try {
      const events: unknown[] = [];
      const ac = new AbortController();
      const res = await fetch(`${b2}/api/events`, { signal: ac.signal });
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      const r = await fetch(`${b2}/api/send`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'あいさつして' }),
      });
      assert.equal(r.status, 202, await r.text());
      const deadline = Date.now() + 20_000;
      let finished = false;
      while (Date.now() < deadline && !finished) {
        const { value } = await Promise.race([
          reader.read(),
          new Promise<{ value: undefined }>((r2) => setTimeout(() => r2({ value: undefined }), 500)),
        ]);
        if (value) buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, nl); buf = buf.slice(nl + 2);
          for (const line of chunk.split('\n')) if (line.startsWith('data: ')) { try { events.push(JSON.parse(line.slice(6))); } catch { /* 注釈 */ } }
        }
        finished = events.some((e) => (e as { type?: string; busy?: boolean }).type === 'busy' && (e as { busy?: boolean }).busy === false);
      }
      ac.abort();
      const text = events
        .filter((e) => (e as { type?: string }).type === 'session')
        .map((e) => (e as { event: { type?: string; delta?: string } }).event)
        .filter((ev) => ev.type === 'text').map((ev) => ev.delta ?? '').join('');
      assert.ok(text.includes('この中から'), `返事が流れていない: ${JSON.stringify(events).slice(0, 600)}`);
    } finally { await s2.stop(); }
  });
});
