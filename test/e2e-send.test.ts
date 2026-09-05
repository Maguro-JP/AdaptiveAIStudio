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
  // 読みかけの約束は捨てない。時計に負けた read() を捨てると、その後に届いた
  // 塊がそちらに吸われて失われる。機械が重いときだけ起きて「終わりが来ない」に見えた。
  let pending: Promise<{ done: boolean; value?: Uint8Array }> | undefined;
  try {
    while (Date.now() < deadline) {
      pending ??= reader.read();
      const got = await Promise.race([
        pending.then((r) => ({ ...r, fromRead: true as const })),
        new Promise<{ done: false; value: undefined; fromRead: false }>((r) => setTimeout(() => r({ done: false, value: undefined, fromRead: false }), 500)),
      ]);
      if (got.fromRead) pending = undefined;
      const { done, value } = got;
      if (value) buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n\n')) !== -1) {
        const chunk = buf.slice(0, nl); buf = buf.slice(nl + 2);
        for (const line of chunk.split('\n')) {
          if (line.startsWith('data: ')) { try { events.push(JSON.parse(line.slice(6))); } catch { /* 注釈 */ } }
        }
      }
      if (until(events)) break;
      if (done) break;
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

describe('会話は残る', () => {
  /**
   * ここまで、やりとりはメモリの中だけだった。窓を閉じれば消え、
   * 横の板の「会話」は枠だけで中身が無かった。
   * **立ち上げ直しても続きから話せる**ところまでを、ここで留める。
   */
  test('一往復すると一覧に出て、立ち上げ直しても残っている', async () => {
    // 前の検査の続きに混ざらないよう、新しい会話から始める。
    assert.equal((await fetch(`${base}/api/conversations`, { method: 'POST' })).status, 200);

    const done = (evs: unknown[]) => evs.some((e) => (e as { type?: string; busy?: boolean }).type === 'busy' && (e as { busy?: boolean }).busy === false);
    const collecting = collect(done);
    await new Promise((r) => setTimeout(r, 200));
    const r = await fetch(`${base}/api/send`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '残ってほしい依頼' }),
    });
    assert.equal(r.status, 202, await r.text());
    await collecting;

    const listed = await (await fetch(`${base}/api/conversations`)).json() as {
      current: string | null; list: Array<{ id: string; title: string; messages: number }>;
    };
    assert.equal(listed.list.length >= 1, true, '一覧に出ていない');
    const head = listed.list.find((h) => h.id === listed.current);
    assert.ok(head, 'いま話している会話が一覧に無い');
    assert.equal(head.title, '残ってほしい依頼', '見出しが最初の依頼になっていない');
    assert.ok(head.messages >= 2, `人の依頼と返事が数えられていない: ${head.messages}`);

    // 中身。人が書いたものと、返ってきたものの両方が残っていること。
    const back = await (await fetch(`${base}/api/conversations/messages?id=${head.id}`)).json() as {
      messages: Array<{ role: string; content: string }>;
    };
    assert.ok(back.messages.some((m) => m.role === 'user' && m.content.includes('残ってほしい依頼')));
    assert.ok(back.messages.some((m) => m.role === 'assistant' && m.content.includes('こんにちは')),
      `返事が残っていない: ${JSON.stringify(back.messages).slice(0, 300)}`);

    // **立ち上げ直す。**同じ記録の置き場を見る別の本体から、同じものが見えること。
    const again = new UiServer({ port: 0, config: server.config });
    const url2 = (await again.start()).replace(/\/$/, '');
    try {
      const seen = await (await fetch(`${url2}/api/conversations`)).json() as {
        current: string | null; list: Array<{ id: string; title: string }>;
      };
      assert.ok(seen.list.some((h) => h.id === head.id), '立ち上げ直したら消えている');
      // **続きとして開いている。**まっさらから始まると、閉じただけで
      // 話が消えたように見える。
      assert.equal(seen.current, head.id, '続きの会話を開いていない');
    } finally { await again.stop(); }
  });
});

describe('会話が続く', () => {
  /**
   * **二回目に、一回目のやりとりが渡っているか。**
   * ここが繋がっていないと、毎回はじめましてになる。それは会話ではない。
   * 相手に何を渡したか（届いた本文）で見る。
   */
  test('二回目の依頼に、一回目のやりとりが載っている', async () => {
    assert.equal((await fetch(`${base}/api/conversations`, { method: 'POST' })).status, 200);
    const send = async (text: string) => {
      const done = (evs: unknown[]) => evs.some((e) => (e as { type?: string; busy?: boolean }).type === 'busy' && (e as { busy?: boolean }).busy === false);
      const collecting = collect(done);
      await new Promise((r) => setTimeout(r, 200));
      const r = await fetch(`${base}/api/send`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      assert.equal(r.status, 202, await r.text());
      await collecting;
    };

    fake.bodies.length = 0;
    await send('わたしの名前はマグロです');
    await send('わたしの名前は？');

    // **作業の呼び出しを見る。**判じる呼び出し（別口）が後ろに来るので、
    // いちばん後ろを見ると、そちらを掴む。
    const work = (fake.bodies as Array<{ messages?: Array<{ role: string; content: string }> }>)
      .filter((b) => !(b.messages ?? []).some((m) => m.content.includes('指摘・不満・注意かどうか')));
    const last = work.at(-1)!;
    const texts = (last.messages ?? []).map((m) => `${m.role}:${m.content}`);
    assert.ok(texts.some((t) => t.includes('わたしの名前はマグロです')),
      `一回目の依頼が渡っていない: ${JSON.stringify(texts).slice(0, 300)}`);
    assert.ok(texts.some((t) => t.startsWith('assistant:') && t.includes('こんにちは')),
      `一回目の返事が渡っていない: ${JSON.stringify(texts).slice(0, 300)}`);
    assert.ok(texts.some((t) => t.includes('わたしの名前は？')), '二回目の依頼が渡っていない');
  });
});

describe('動いている間に書いても、断らない', () => {
  /**
   * 突き返されるのがいちばん不快で、しかも書き直させることになる。
   * 「終わったらこれをやって」と思って書いているので、預かって順に流す。
   */
  test('二つ目は順番待ちに積まれ、あとで流れる', async () => {
    // 二往復ぶん（busy が false になるのを2回）待つ。
    const twice = (evs: unknown[]) =>
      evs.filter((e) => (e as { type?: string; busy?: boolean }).type === 'busy'
        && (e as { busy?: boolean }).busy === false).length >= 2;
    const collecting = collect(twice);
    await new Promise((r) => setTimeout(r, 200));

    const send = (text: string) => fetch(`${base}/api/send`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });

    const before = fake.requests;
    // 続けて二つ投げる。二つ目は、一つ目が動いている間に着く。
    const [a, b] = await Promise.all([send('ひとつめ'), send('ふたつめ')]);
    // 中身は一度しか読めない。先に読んでから、状態と一緒に見る。
    const bodies = await Promise.all([a.json(), b.json()]) as Array<{ accepted?: boolean; queued?: number }>;
    assert.equal(a.status, 202, JSON.stringify(bodies[0]));
    assert.equal(b.status, 202, JSON.stringify(bodies[1]));
    assert.ok(bodies.some((x) => x.queued === 1), `順番待ちに積まれていない: ${JSON.stringify(bodies)}`);

    const events = await collecting;
    assert.ok(twice(events), '二つ目が流れていない');
    // 空になったことを、画面へ伝えている。
    const queueEvents = events.filter((e) => (e as { type?: string }).type === 'queue') as Array<{ waiting: number }>;
    assert.ok(queueEvents.some((e) => e.waiting === 1), '積んだことを言っていない');
    assert.ok(queueEvents.some((e) => e.waiting === 0), '空になったことを言っていない');
    assert.ok(fake.requests >= before + 2, `二回とも相手に届いていない: ${fake.requests - before}`);
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
    await writeFile(join(models, 'a.gguf'), 'GGUF');
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
      let pending: Promise<{ done: boolean; value?: Uint8Array }> | undefined;
      while (Date.now() < deadline && !finished) {
        pending ??= reader.read();
        const got = await Promise.race([
          pending.then((r) => ({ value: r.value, fromRead: true as const })),
          new Promise<{ value: undefined; fromRead: false }>((r2) => setTimeout(() => r2({ value: undefined, fromRead: false }), 500)),
        ]);
        if (got.fromRead) pending = undefined;
        const { value } = got;
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
      // 決めていなくても、情報には「いま読んでいるもの」が出る。
      const info = await (await fetch(`${b2}/api/info`)).json() as { model?: string };
      assert.equal(info.model, 'a.gguf');
    } finally { await s2.stop(); }
  });
});

describe('設定で決めた GGUF を読む', () => {
  test('runtime.model が置き場に在れば、最初の一つではなくそれを読む', async () => {
    const { join } = await import('node:path');
    const { writeFile } = await import('node:fs/promises');
    const { createServer } = await import('node:http');
    const models = await tempDir('aas-e2e-pick-');
    await writeFile(join(models, 'a.gguf'), 'GGUF');
    await writeFile(join(models, 'b.gguf'), 'GGUF');
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const loadedPaths: string[] = [];
    const load = async () => ({
      getLlama: async () => ({
        loadModel: async (o: { modelPath: string }) => {
          loadedPaths.push(o.modelPath);
          return { createContext: async () => ({ getSequence: () => ({}), dispose: async () => {} }) };
        },
      }),
      LlamaChatSession: class { setChatHistory() {} async prompt() { return 'x'; } },
    });
    const s3 = new UiServer({
      port: 0, inprocLoad: load,
      config: {
        ...DEFAULT_CONFIG,
        providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1`, locality: 'local', models: ['b.gguf'] }],
        candidates: ['local:b.gguf'],
        runtime: { kind: 'inproc', modelsDir: models, basePort: port, model: 'b.gguf' },
      } as typeof DEFAULT_CONFIG,
    });
    const b3 = (await s3.start()).replace(/\/$/, '');
    try {
      const r = await fetch(`${b3}/api/send`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'x' }),
      });
      assert.equal(r.status, 202, await r.text());
      await new Promise((r2) => setTimeout(r2, 1500));
      assert.ok(loadedPaths.some((p) => p.endsWith('b.gguf')), `b を読んでいない: ${loadedPaths.join(',')}`);
      assert.ok(!loadedPaths.some((p) => p.endsWith('a.gguf')), `最初の一つを読んでしまった: ${loadedPaths.join(',')}`);
    } finally { await s3.stop(); }
  });
});

describe('外の道具（MCP）を、会話の中から実際に呼ぶ', () => {
  test('模型が道具を呼び、結果が模型へ戻り、返事が流れる', async () => {
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = dirname(fileURLToPath(import.meta.url));
    const fixture = join(here, 'fixtures', 'dribble-mcp.mjs');
    const fake2 = await startFakeServer({ kind: 'toolcall', name: 'echo__echo', args: { q: 'x' }, then: '道具から聞きました' });
    const s4 = new UiServer({
      port: 0,
      config: {
        ...DEFAULT_CONFIG,
        providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: fake2.baseUrl, locality: 'local', models: ['m'] }],
        candidates: ['local:m'],
        runtime: { kind: 'ollama' },
        agent: { ...(DEFAULT_CONFIG as { agent?: object }).agent, approval: 'auto' },
        mcp: { servers: { echo: { command: process.execPath, args: ['--experimental-strip-types', fixture], startupTimeoutMs: 30_000 } } },
      } as typeof DEFAULT_CONFIG,
    });
    const b4 = (await s4.start()).replace(/\/$/, '');
    try {
      const done = (evs: unknown[]) => evs.some((e) => (e as { type?: string; busy?: boolean }).type === 'busy' && (e as { busy?: boolean }).busy === false);
      // この検査の中だけで読む（上の collect は別の server を向いている）。
      const events: unknown[] = [];
      const ac = new AbortController();
      const res = await fetch(`${b4}/api/events`, { signal: ac.signal });
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      const r = await fetch(`${b4}/api/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'echo を使って' }) });
      assert.equal(r.status, 202, await r.text());
      const deadline = Date.now() + 40_000;
      let pending: Promise<{ done: boolean; value?: Uint8Array }> | undefined;
      while (Date.now() < deadline && !done(events)) {
        pending ??= reader.read();
        const got = await Promise.race([
          pending.then((x) => ({ value: x.value, fromRead: true as const })),
          new Promise<{ value: undefined; fromRead: false }>((r2) => setTimeout(() => r2({ value: undefined, fromRead: false }), 500)),
        ]);
        if (got.fromRead) pending = undefined;
        if (got.value) buf += dec.decode(got.value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, nl); buf = buf.slice(nl + 2);
          for (const line of chunk.split('\n')) if (line.startsWith('data: ')) { try { events.push(JSON.parse(line.slice(6))); } catch { /* 注釈 */ } }
        }
      }
      ac.abort();
      const inner = events.filter((e) => (e as { type?: string }).type === 'session').map((e) => (e as { event: { type?: string; name?: string; ok?: boolean; delta?: string } }).event);
      assert.ok(inner.some((ev) => ev.type === 'toolEnd' && ev.name === 'echo__echo' && ev.ok === true), `道具が呼ばれていない: ${JSON.stringify(inner).slice(0, 500)}`);
      const text = inner.filter((ev) => ev.type === 'text').map((ev) => ev.delta ?? '').join('');
      assert.ok(text.includes('道具から聞きました'), `道具の後の返事が無い: ${text}`);
      // 道具の結果（fixture が返す「あいうえお…」）が、模型へ戻っていること。
      // 二つ目の本文は検問所（二段目の検査官）の問い合わせのことがある。
      // どの本文でもよいので、道具の結果が role: tool で戻っていること。
      const second = { messages: fake2.bodies.flatMap((b) => (b as { messages?: { role?: string; content?: string }[] })?.messages ?? []) };
      const shape = JSON.stringify(fake2.bodies.map((b) => ((b as { messages?: { role?: string; content?: unknown }[] })?.messages ?? []).map((m) => [m.role, String(m.content).slice(0, 60)])));
      assert.ok(second?.messages?.some((m) => m.role === 'tool' && String(m.content).includes('あいうえお')), `道具の結果が模型へ戻っていない: ${shape}`);
    } finally { await s4.stop(); await fake2.close(); }
  });
});
