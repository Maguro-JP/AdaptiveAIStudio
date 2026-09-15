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
import { until } from './until.ts';

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

/**
 * collect() の流れが繋がったところ。
 *
 * **決め打ちで 200ms 待っていた。**繋がる前に送ると出来事を取りこぼし、
 * 機械が混んでいるときだけ「終わりが来ない」になる。数を見て当てるのではなく、
 * **繋いだ当人に知らせてもらう**。collect() は待たずに呼ぶので、
 * この約束は呼んだ時点で作られている必要がある（最初の await より前）。
 */
let opened: Promise<void> = Promise.resolve();

/** 流れを読んで、条件を満たすまで出来事を溜める。 */
async function collect(until: (events: unknown[]) => boolean, ms = 20_000): Promise<unknown[]> {
  let ready!: () => void;
  opened = new Promise<void>((r) => { ready = r; });
  const events: unknown[] = [];
  const ac = new AbortController();
  const res = await fetch(`${base}/api/events`, { signal: ac.signal });
  // ここまで返っているなら、土台は既にこの相手を控えている。
  ready();
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
    await opened;
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
    await opened;
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
      // **開いた直後はトップ。**どれも開いていない。前は勝手にいちばん
      // 新しいものを開いていたので、話しかけると古い話の続きになった。
      // 続きから話したいときは、一覧から開く（消えてはいない）。
      assert.equal(seen.current, null, '開いた直後に会話を勝手に開いている');
      const back2 = await (await fetch(`${url2}/api/conversations/select`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: head.id }),
      })).json() as { current: string; messages: unknown[] };
      assert.equal(back2.current, head.id, '一覧から開けない');
      assert.ok(back2.messages.length >= 2, '開いても中身が戻らない');
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
      await opened;
      const r = await fetch(`${base}/api/send`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      assert.equal(r.status, 202, await r.text());
      await collecting;
    };

    fake.bodies.length = 0;
    await send('わたしの名前はテスト太郎です');
    await send('わたしの名前は？');

    // **作業の呼び出しを見る。**判じる呼び出し（別口）が後ろに来るので、
    // いちばん後ろを見ると、そちらを掴む。
    const work = (fake.bodies as Array<{ messages?: Array<{ role: string; content: string }> }>)
      .filter((b) => !(b.messages ?? []).some((m) => m.content.includes('指摘・不満・注意かどうか')));
    const last = work.at(-1)!;
    const texts = (last.messages ?? []).map((m) => `${m.role}:${m.content}`);
    assert.ok(texts.some((t) => t.includes('わたしの名前はテスト太郎です')),
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
    await opened;

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
      await opened;
      const r = await fetch(`${base}/api/send`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '黙る相手へ' }),
      });
      assert.equal(r.status, 202, await r.text());
      // 相手（黙る側）へ届いてから押す。決め打ちで待つと、届く前に押して
      // 「押さなくても戻ってきた」を見ていることがある。
      await until(() => fake.requests > 0, '黙る相手まで届く');
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
      // **決め打ちで待たない。**1.5 秒で待っていたら、試験を全部まとめて
      // 走らせたときだけ落ちた（機械が混んでいて間に合わない）。
      // 走らせる場所で結果が変わる検査になっていたので、届くまで見る。
      const until = Date.now() + 30_000;
      while (Date.now() < until && loadedPaths.length === 0) {
        await new Promise((r2) => setTimeout(r2, 25));
      }
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
      /*
       * **終わりは、この会話の終わりだけを見る。**
       *
       * ここは会話を問わず `busy: false` を見ていた。一度目の後片付け
       * （settled と busy: false）は、こちらが読み始めた直後に届くことが
       * ある。そうなると二度目を送る前に「終わった」と読んで、
       * 出来事を一つも拾わないまま抜ける。実際にそれで落ちた
       * （拾えたのは一度目の settled だけ・0.132 秒・3 トークン）。
       * 走らせる速さで結果が変わる形なので、会話の名前で分ける。
       */
      const forId = (evs: unknown[], id: string) => evs.filter((e) => (e as { conversationId?: string }).conversationId === id);
      const done = (evs: unknown[], id: string) => forId(evs, id).some((e) => (e as { type?: string; busy?: boolean }).type === 'busy' && (e as { busy?: boolean }).busy === false);
      // この検査の中だけで読む（上の collect は別の server を向いている）。
      /*
       * **一度呼びかけてから、繋がるのを待って、本番を送る。**
       *
       * 外の MCP サーバーは「頼まれるまで起こさない」（画面を開いただけでは何も
       * 起こさない。`test/no-work-unasked.test.ts`）。起こすのはセッションを
       * 作るときで、それは最初の送信のとき。しかも**待たずに**起こす。
       * だから最初の1ターンには、ツールがまだ無いことがある——そう決めてある。
       *
       * ここはそれを知らずに、一度目の送信でツールが呼ばれることにしていた。
       * 手元では立ち上がりが速いので通っていたが、**組んだものの中で回すと
       * 落ちた**。わざと 1.5 秒遅らせる相手にすると、手元でも同じように落ちる
       * （確かめた）。走らせる場所で結果が変わる形になっていた。
       *
       * 利用者も、二度目からはツールが在る状態で打つ。ここもそう書く。
       */
      await fetch(`${b4}/api/send`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'はじめまして' }),
      });
      await until(async () => {
        // `tools` は**数**（配列ではない）。ここを配列だと思って書いて、
        // いつまでも繋がらないことにしてしまった。
        const list = await fetch(`${b4}/api/mcp`).then((x) => x.json()) as
          { servers?: Array<{ name?: string; tools?: number }> };
        return (list.servers ?? []).some((sv) => sv.name === 'echo' && (sv.tools ?? 0) > 0);
      }, 'echo が繋がる', { timeoutMs: 40_000 });
      await until(async () => {
        const st = await fetch(`${b4}/api/state`).then((x) => x.json()) as { busy?: boolean };
        return st.busy !== true;
      }, '一度目が終わる', { timeoutMs: 40_000 });
      // 一度目のやりとりを、話に残さない。**残すと相手が「もうツールは
      // 呼んだ」と読む**（作りものの相手は role: tool の有無で切り替える）。
      await fetch(`${b4}/api/conversations`, { method: 'POST' });
      fake2.bodies.length = 0;
      // 出来事を読み始めるのは**ここから**。一度目のぶんを混ぜない。
      const events: unknown[] = [];
      const ac = new AbortController();
      const res = await fetch(`${b4}/api/events`, { signal: ac.signal });
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      const r = await fetch(`${b4}/api/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'echo を使って' }) });
      const sent = await r.json() as { conversationId?: string; error?: string };
      assert.equal(r.status, 202, JSON.stringify(sent));
      const mine = sent.conversationId;
      assert.ok(mine, '会話の名前が返っていない');
      const deadline = Date.now() + 40_000;
      let pending: Promise<{ done: boolean; value?: Uint8Array }> | undefined;
      while (Date.now() < deadline && !done(events, mine)) {
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
      const inner = forId(events, mine).filter((e) => (e as { type?: string }).type === 'session').map((e) => (e as { event: { type?: string; name?: string; ok?: boolean; delta?: string } }).event);
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

describe('同じ学びを、一往復に二度入れない', () => {
  /**
   * 決まり（system）と思い出しの両方に載せていたので、八件ずつ二重に入っていた。
   * 狭い窓のモデルほど効く（そのぶん、肝心の依頼が押し出される）。
   *
   * **届いた本文で数える。**こちらの積もりではなく、渡ったもので見る。
   */
  test('届いた本文の中で、同じ一行が二度出てこない', async () => {
    assert.equal((await fetch(`${base}/api/conversations`, { method: 'POST' })).status, 200);
    fake.bodies.length = 0;
    const done = (evs: unknown[]) => evs.some((e) => (e as { type?: string; busy?: boolean }).type === 'busy'
      && (e as { busy?: boolean }).busy === false);
    const collecting = collect(done);
    await opened;
    await fetch(`${base}/api/send`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '足し算を直して' }),
    });
    await collecting;

    const work = (fake.bodies as Array<{ messages?: Array<{ role: string; content: string }> }>)
      .filter((b) => !(b.messages ?? []).some((m) => m.content.includes('指摘・不満・注意かどうか')));
    assert.ok(work.length > 0, '作業の呼び出しが無い');
    const sent = (work.at(-1)!.messages ?? []).map((m) => m.content).join('\n');

    // **どれが載るかは決め打ちにしない。**決まりに載るのは新しい順に何件か。
    // 見るのは「載っているものが二度出ていないこと」と「一つは載っていること」。
    const state = await (await fetch(`${base}/api/state`)).json() as {
      memory: { kind: string; detail: string }[];
    };
    const lessons = state.memory.filter((m) => m.kind === 'displeasure' && m.detail.length > 24);
    assert.ok(lessons.length > 0, '学びが一つも無い');
    const counts = lessons.map((m) => sent.split(m.detail.slice(0, 24)).length - 1);
    assert.deepEqual(counts.filter((n) => n > 1), [],
      `同じ学びが二度入っている（一往復ぶんの本文 ${sent.length} 文字）`);
    assert.ok(counts.some((n) => n === 1),
      `学びが一つも届いていない（本文 ${sent.length} 文字）`);
  });
});

describe('窓は、開いた側の数字を使う', () => {
  /**
   * **開く側と、見積もる側が別の数字を持たない。**
   * 設定から見積もっていたので、機械に合わせて狭めたときは溢れ
   * （返事が来なくなる）、モデルに合わせて広げたときは刈りすぎていた。
   */
  test('中で読む道が開いた窓が、そのまま土台へ渡る', async () => {
    const { join } = await import('node:path');
    const { writeFile } = await import('node:fs/promises');
    const { createServer } = await import('node:http');
    const { ggufHead } = await import('./gguf-head.ts');
    const models = await tempDir('aas-win-');
    // **ファイル側と設定を食い違わせる。**一致させると、直したかどうかが
    // 見分けられない（設定のままでも通ってしまう）。
    // 諸元も揃えて置く。揃っていないと、記憶に載るかを数えられないので
    // 安全な側（SAFE_WINDOW）へ落ちる。ここで見たいのはそこではない。
    await writeFile(join(models, 'a.gguf'), ggufHead({
      'general.architecture': 'qwen3',
      'qwen3.context_length': 16384,
      'qwen3.block_count': 4,
      'qwen3.embedding_length': 512,
      'qwen3.attention.head_count': 8,
      'qwen3.attention.head_count_kv': 2,
    }));
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((r) => probe.close(() => r()));

    const load = async () => ({
      getLlama: async () => ({
        loadModel: async () => ({
          createContext: async () => ({ getSequence: () => ({}), dispose: async () => {} }),
        }),
      }),
      LlamaChatSession: class {
        setChatHistory() {}
        async prompt() { return 'はい'; }
      },
    });
    const s2 = new UiServer({
      port: 0,
      inprocLoad: load,
      config: {
        ...DEFAULT_CONFIG,
        providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1`, locality: 'local', models: ['a.gguf'] }],
        // 設定には窓を書かない。開く側がファイルから読む。
        runtime: { kind: 'inproc', modelsDir: models, basePort: port },
      } as typeof DEFAULT_CONFIG,
    });
    const b2 = (await s2.start()).replace(/\/$/, '');
    try {
      // 送ると、そこで初めてモデルが読み込まれる（読む前に窓は決まらない）。
      const r = await fetch(`${b2}/api/send`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'あいさつして' }),
      });
      assert.equal(r.status, 202, await r.text());
      await new Promise((res) => setTimeout(res, 1500));

      const live = await (s2 as unknown as { session(): Promise<{ contextTokens: number }> }).session();
      // 既定の 8192 ではなく、ファイルに書いてある 16384 が渡ること。
      assert.equal(live.contextTokens, 16384, '開いた窓が土台へ渡っていない');
    } finally { await s2.stop(); }
  });
});

describe('黙って選ばない', () => {
  /**
   * 何のモデルを選んだかと、**なぜそれなのか**は既に手元にあった
   * （`resolveCandidates` の note）のに、**モデルが無いときのエラー文にしか
   * 使っていなかった**。選べたときは捨てていたので、利用者から見ると
   * 「いつのまにか、この名前で動いている」。速い方へ勝手に乗り換える作りなので、
   * なおさら理由が要る。
   *
   * 「黙って切らない・黙って落とさない」と同じことで、**選ぶのも黙らない**。
   * AIOS の Router が、どの経路を選んでも必ず一言で理由を返しているのを見て取り込んだ。
   */
  test('**なぜそのモデルなのかが、画面から引ける**', async () => {
    const info = await (await fetch(`${base}/api/info`)).json() as { why?: string; model: string };
    assert.ok(info.why, `理由を返していない: ${JSON.stringify(info)}`);
    assert.match(info.why, /固定|速|秒|自動/, `理由になっていない: ${info.why}`);
  });

  test('**選んだことを、流れにも出す**', async () => {
    // 立ち上げ直して、最初に出る一行を見る。
    const fake2 = await startFakeServer({ kind: 'stream', text: 'はい' });
    const said: string[] = [];
    const s2 = new UiServer({
      port: 0,
      config: {
        ...DEFAULT_CONFIG,
        providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: fake2.baseUrl, locality: 'local', models: ['m'] }],
        candidates: ['local:m'],
        runtime: { kind: 'ollama' },
      } as typeof DEFAULT_CONFIG,
    });
    const b2 = (await s2.start()).replace(/\/$/, '');
    try {
      const ac2 = new AbortController();
      void (async () => {
        const ev = await fetch(`${b2}/api/events`, { signal: ac2.signal });
        const rd = ev.body!.getReader(); const dc = new TextDecoder();
        for (;;) { const { done, value } = await rd.read(); if (done) break; if (value) said.push(dc.decode(value, { stream: true })); }
      })().catch(() => undefined);
      await fetch(`${b2}/api/send`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'こんにちは' }),
      });
      await until(() => said.join('').includes('モデルを'), 'モデルを選んだことを言う', { timeoutMs: 40_000 });
      assert.match(said.join(''), /モデルを local:m にしました/, said.join('').slice(-300));
      ac2.abort();
    } finally { await s2.stop(); await fake2.close(); }
  });
});

/**
 * 訊かれただけのときに、作業者の服を着せない。
 *
 * 実機で「明日の天気を教えて」と打つと、`あなたはソフトウェア開発の作業者です。
 * …まず read_file / list_files / search_text で現状を確認する` が載った状態で
 * 2B へ渡り、「明日の天気を調べたいようです」「URL を使用します」と言って
 * 62 秒後に落ちた。**問いに、作業の決まりとツールを渡していた。**
 */
describe('訊かれただけのとき', () => {
  /**
   * その依頼で模型へ渡したものを覗く。
   *
   * **いちばん後ろを見ない。**指摘かどうかを判じる別口が後ろに来るので、
   * そちらを掴む（掴んで落ちた）。訊いた本文が載っているものを探す。
   */
  const sentFor = (asked: string): { messages: { role: string; content: string }[]; tools?: unknown[] } => {
    const bodies = fake.bodies as { messages?: { role: string; content: string }[]; tools?: unknown[] }[];
    const hit = bodies.filter((b) => (b.messages ?? []).some((m) => m.role === 'user' && m.content.includes(asked)))
      .filter((b) => !(b.messages ?? []).some((m) => m.content.includes('指摘・不満・注意かどうか'))).at(-1);
    assert.ok(hit?.messages, `その依頼を送っていない: ${asked}`);
    return hit as { messages: { role: string; content: string }[]; tools?: unknown[] };
  };

  test('**作業者の決まりもツールも渡さない**', async () => {
    const before = fake.bodies.length;
    const done = (evs: unknown[]) => evs.some((e) => (e as { type?: string; busy?: boolean }).type === 'busy' && (e as { busy?: boolean }).busy === false);
    const collecting = collect(done);
    await opened;
    await fetch(`${base}/api/send`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '明日の天気を教えて' }),
    });
    await collecting;
    await until(() => fake.bodies.length > before, '模型へ届く', { timeoutMs: 20_000 });

    const sent = sentFor('明日の天気を教えて');
    const system = sent.messages.find((m) => m.role === 'system')?.content ?? '';
    assert.doesNotMatch(system, /ソフトウェア開発の作業者/, `作業者の決まりが載っている:\n${system.slice(0, 300)}`);
    assert.doesNotMatch(system, /read_file|write_file|run_command/, `ツールの使い方を教えている:\n${system.slice(0, 300)}`);
    assert.match(system, /分かりません/, `知らないと言わせていない:\n${system.slice(0, 300)}`);
    assert.ok(!sent.tools || sent.tools.length === 0, `ツールを渡している: ${JSON.stringify(sent.tools)?.slice(0, 200)}`);
    // 訊いたことが、そのまま届いている（覚えを継ぎ足していない）。
    const user = sent.messages.filter((m) => m.role === 'user').pop()?.content ?? '';
    assert.equal(user, '明日の天気を教えて', `依頼に何か足している: ${JSON.stringify(user)}`);
  });

  test('**作業を頼んだときは、今までどおり作業者（対）**', async () => {
    const before = fake.bodies.length;
    const done = (evs: unknown[]) => evs.some((e) => (e as { type?: string; busy?: boolean }).type === 'busy' && (e as { busy?: boolean }).busy === false);
    const collecting = collect(done);
    await opened;
    await fetch(`${base}/api/send`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'src/a.ts を直して' }),
    });
    await collecting;
    await until(() => fake.bodies.length > before, '模型へ届く', { timeoutMs: 20_000 });

    const sent = sentFor('src/a.ts を直して');
    const system = sent.messages.find((m) => m.role === 'system')?.content ?? '';
    // 相棒の決まりに差し替わっていないこと（決まり本体は設定で替えられるので、
    // 「作業者」の語では見ない。**リポジトリの決まりが載っているか**で見る）。
    assert.doesNotMatch(system, /相棒|天気、ニュース、株価/, `問いの決まりになっている:\n${system.slice(0, 300)}`);
    assert.ok((sent.tools?.length ?? 0) > 0, '作業なのにツールを渡していない');
  });

  /**
   * 問いに答えただけの回に「完了（検証していません）」と出していた（実機の画面）。
   * 何も完了していないし、確かめるものも無い。画面が言い分けられるように、
   * 結末の出来事（settled）に「訊かれただけの回か」を載せる。
   */
  test('**結末に、訊かれただけの回かが載る**', async () => {
    // 結末は `session` の中に包まれて流れてくる。
    const isSettled = (e: unknown): boolean =>
      (e as { type?: string; event?: { type?: string } }).type === 'session'
      && (e as { event?: { type?: string } }).event?.type === 'settled';
    const done = (evs: unknown[]) => evs.some(isSettled);
    const collecting = collect(done);
    await opened;
    await fetch(`${base}/api/send`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '1+1=' }),
    });
    const evs = await collecting;
    const settled = evs.filter(isSettled).at(-1) as
      { event?: { chat?: boolean; reason?: string } } | undefined;
    assert.ok(settled, `結末が出ていない: ${JSON.stringify(evs).slice(0, 300)}`);
    assert.equal(settled.event?.chat, true, `訊かれた回だと言っていない: ${JSON.stringify(settled)}`);
  });

  test('**作業の回には載せない（対）**', async () => {
    // ここが一緒になると、確かめていない作業まで「答えました」で流れる。
    // 結末は `session` の中に包まれて流れてくる。
    const isSettled = (e: unknown): boolean =>
      (e as { type?: string; event?: { type?: string } }).type === 'session'
      && (e as { event?: { type?: string } }).event?.type === 'settled';
    const done = (evs: unknown[]) => evs.some(isSettled);
    const collecting = collect(done);
    await opened;
    await fetch(`${base}/api/send`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'src/a.ts を直して' }),
    });
    const evs = await collecting;
    const settled = evs.filter(isSettled).at(-1) as { event?: { chat?: boolean } } | undefined;
    assert.ok(settled, '結末が出ていない');
    assert.notEqual(settled.event?.chat, true, `作業なのに訊かれた回だと言っている: ${JSON.stringify(settled)}`);
  });
});
