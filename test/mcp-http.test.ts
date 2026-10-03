/**
 * 遠くの相手（Streamable HTTP）に繋ぐ。
 *
 * 手元で立ち上げる形（stdio）だけだと、`npx` の無い機械では一つも繋がらない。
 * いま主要なところは、ほとんど遠くに在る。ここが通らないと、
 * 「MCP に対応しています」は口だけになる。
 *
 * 模型ではなく、**本物の HTTP サーバ**を立てて繋ぐ。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { McpClient } from '../src/mcp/client.ts';
import { until } from './until.ts';

interface Seen { headers: Record<string, string | undefined>[]; deleted: boolean; deleteVersion?: string }

/**
 * 相手役。名乗り・道具の一覧・呼び出しに答える。
 * `sse` を立てると、流れ（text/event-stream）で返す。
 */
async function startServer(opts: { sse?: boolean; sseSplit?: boolean; fail?: number; batch?: boolean; version?: string } = {}) {
  const seen: Seen = { headers: [], deleted: false };
  const server: Server = createServer((req, res) => {
    if (req.method === 'DELETE') {
      seen.deleted = true;
      seen.deleteVersion = req.headers['mcp-protocol-version'] as string | undefined;
      res.writeHead(204); res.end(); return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.headers.push({
        authorization: req.headers.authorization as string | undefined,
        session: req.headers['mcp-session-id'] as string | undefined,
        accept: req.headers.accept as string | undefined,
        version: req.headers['mcp-protocol-version'] as string | undefined,
      });
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id?: number; method?: string };
      if (opts.fail) { res.writeHead(opts.fail, { 'content-type': 'text/plain' }); res.end('だめです'); return; }

      // 知らせ（id が無い）には、返す本文が無い。
      if (body.id === undefined) { res.writeHead(202); res.end(); return; }

      const result = body.method === 'initialize'
        ? { protocolVersion: opts.version ?? '2025-06-18', capabilities: {}, serverInfo: { name: 'つくりもの', version: '1' } }
        : body.method === 'tools/list'
          ? { tools: [{ name: 'echo', description: '返すだけ', inputSchema: { type: 'object' } }] }
          : { content: [{ type: 'text', text: 'こんにちは' }] };
      const message = { jsonrpc: '2.0', id: body.id, result };

      const sse = opts.sse || opts.sseSplit;
      const head: Record<string, string> = { 'content-type': sse ? 'text/event-stream' : 'application/json' };
      if (body.method === 'initialize') head['mcp-session-id'] = 'sess-1';
      res.writeHead(200, head);
      const payload = opts.batch ? JSON.stringify([message]) : JSON.stringify(message);
      // sseSplit: 一つの出来事を複数の data: 行に分ける（SSE の決まりで許されている。整形した JSON をそのまま流す相手）
      const split = JSON.stringify(opts.batch ? [message] : message, null, 2).split('\n').map((l) => `data: ${l}`).join('\n');
      res.end(opts.sseSplit ? `event: message\r\n${split}\n\n` : opts.sse ? `event: message\ndata: ${payload}\n\n` : payload);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    seen,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe('遠くの相手に繋ぐ', () => {
  test('名乗って、道具の一覧まで取れる', async () => {
    const s = await startServer();
    const c = new McpClient('remote', { url: s.url });
    try {
      assert.equal(await c.start(), true, c.failure);
      assert.equal(c.running, true);
      assert.equal(c.remote, true);
      assert.deepEqual(c.tools.map((t) => t.name), ['echo']);
    } finally { c.stop(); await s.close(); }
  });

  test('流れ（SSE）で返されても、同じように読める', async () => {
    const s = await startServer({ sse: true });
    const c = new McpClient('remote', { url: s.url });
    try {
      assert.equal(await c.start(), true, c.failure);
      const got = await c.call('echo', { text: 'やあ' });
      assert.equal(got.isError, false);
      assert.equal(got.text, 'こんにちは');
    } finally { c.stop(); await s.close(); }
  });

  test('一つの返事を複数の data: 行に分けて流されても、読める（時間切れまで待たない）', async () => {
    const s = await startServer({ sseSplit: true });
    const c = new McpClient('remote', { url: s.url });
    try {
      assert.equal(await c.start(), true, c.failure);
      const got = await c.call('echo', { text: 'やあ' }, 5_000);
      assert.equal(got.isError, false, got.text);
      assert.equal(got.text, 'こんにちは');
    } finally { c.stop(); await s.close(); }
  });

  test('流れ（SSE）でまとめて（配列で）返されても、落とさない', async () => {
    const s = await startServer({ sse: true, batch: true });
    const c = new McpClient('remote', { url: s.url });
    try {
      assert.equal(await c.start(), true, c.failure);
      const got = await c.call('echo', { text: 'やあ' }, 5_000);
      assert.equal(got.text, 'こんにちは');
    } finally { c.stop(); await s.close(); }
  });

  test('まとめて返されても、落とさない', async () => {
    const s = await startServer({ batch: true });
    const c = new McpClient('remote', { url: s.url });
    try {
      assert.equal(await c.start(), true, c.failure);
      assert.deepEqual(c.tools.map((t) => t.name), ['echo']);
    } finally { c.stop(); await s.close(); }
  });

  test('合言葉は名前で渡し、Bearer が無ければ付ける', async () => {
    const s = await startServer();
    process.env.AAS_TEST_TOKEN = 'abc123';
    const c = new McpClient('remote', { url: s.url, headersFrom: { Authorization: 'AAS_TEST_TOKEN' } });
    try {
      await c.start();
      assert.equal(s.seen.headers[0]?.authorization, 'Bearer abc123');
    } finally { c.stop(); await s.close(); delete process.env.AAS_TEST_TOKEN; }
  });

  test('付いているものは、二重に付けない', async () => {
    const s = await startServer();
    process.env.AAS_TEST_TOKEN = 'Bearer zzz';
    const c = new McpClient('remote', { url: s.url, headersFrom: { Authorization: 'AAS_TEST_TOKEN' } });
    try {
      await c.start();
      assert.equal(s.seen.headers[0]?.authorization, 'Bearer zzz');
    } finally { c.stop(); await s.close(); delete process.env.AAS_TEST_TOKEN; }
  });

  test('繋ぎの名前をもらったら、次からは付けて出す', async () => {
    const s = await startServer();
    const c = new McpClient('remote', { url: s.url });
    try {
      await c.start();
      await c.call('echo', {});
      const last = s.seen.headers[s.seen.headers.length - 1];
      assert.equal(last?.session, 'sess-1');
    } finally { c.stop(); await s.close(); }
  });

  test('切るときは、相手の控えも落としてもらう', async () => {
    const s = await startServer();
    try {
      const c = new McpClient('remote', { url: s.url });
      await c.start();
      c.stop();
      assert.equal(c.running, false);
      // **決め打ちで待たない。**落ちるまで見る。
      // 落ちなかったときも、必ず相手を閉じてから抜ける（開いたままだと
      // 試験の走り自体が終わらなくなる）。
      await until(() => s.seen.deleted, '相手の控えが落ちる', { timeoutMs: 10_000 });
    } finally { await s.close(); }
  });

  test('断られたら、理由をそのまま持つ（黙って繋がらない、を作らない）', async () => {
    const s = await startServer({ fail: 401 });
    const c = new McpClient('remote', { url: s.url });
    try {
      assert.equal(await c.start(), false);
      assert.match(c.failure ?? '', /401|だめです/);
      assert.equal(c.running, false);
    } finally { c.stop(); await s.close(); }
  });

  test('繋ぎ先も立ち上げるものも無ければ、そう言う', async () => {
    const c = new McpClient('empty', {});
    assert.equal(await c.start(), false);
    assert.match(c.failure ?? '', /繋ぎ先/);
  });
});

describe('取り消しの知らせが断られても、ほかの呼び出しを巻き込まない', () => {
  test('notifications/cancelled が 500 でも、同じ相手に出している別の呼び出しは返事を受け取れる', async () => {
    const held: import('node:http').ServerResponse[] = [];
    let cancelRefused: (() => void) | undefined;
    const refused = new Promise<void>((ok) => { cancelRefused = ok; });
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id?: number; method?: string; params?: { name?: string } };
        if (body.method === 'notifications/cancelled') { res.writeHead(500); res.end('だめです'); cancelRefused?.(); return; }
        if (body.id === undefined) { res.writeHead(202); res.end(); return; }
        const say = (result: unknown) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
        };
        if (body.method === 'initialize') say({ protocolVersion: '2025-06-18', capabilities: {} });
        else if (body.method === 'tools/list') say({ tools: [{ name: 'hang' }, { name: 'slow' }] });
        else if (body.params?.name === 'hang') held.push(res); // 返さない
        // 取り消しを 500 で断った後に返す（決め打ちの時間の並びに頼らない）
        else void refused.then(() => say({ content: [{ type: 'text', text: 'おそく返した' }] }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const c = new McpClient('remote', { url: `http://127.0.0.1:${port}/mcp` });
    try {
      assert.equal(await c.start(), true, c.failure);
      const slow = c.call('slow', {}, 10_000);
      const ac = new AbortController();
      const asked = c.call('hang', {}, 10_000, ac.signal);
      await until(() => held.length > 0, '相手が hang を受け取る', { timeoutMs: 5_000 });
      ac.abort();
      assert.match((await asked).text, /止めました/);
      const got = await slow;
      assert.equal(got.isError, false, `取り消しの失敗に巻き込まれた: ${got.text}`);
      assert.equal(got.text, 'おそく返した');
      assert.equal(c.failure, undefined);
    } finally {
      c.stop();
      for (const res of held) res.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

/** 流れ（SSE）の頭だけ返して黙る相手。`closed()` で、その繋ぎが閉じたかを見る。 */
async function startSilentStream() {
  let closed = false;
  const held: import('node:http').ServerResponse[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id?: number; method?: string };
      if (body.id === undefined) { res.writeHead(202); res.end(); return; }
      const say = (result: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
      };
      if (body.method === 'initialize') say({ protocolVersion: '2025-06-18', capabilities: {} });
      else if (body.method === 'tools/list') say({ tools: [{ name: 'hang' }] });
      else {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(': started\n\n');
        res.on('close', () => { closed = true; });
        held.push(res);
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    /** 相手が hang の問いを受け取って、流れを開いた */
    started: () => held.length > 0,
    closed: () => closed,
    close: async () => {
      for (const res of held) res.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

describe('止めた呼び出しの返事の流れを、開いたままにしない', () => {
  test('流れ（SSE）で返し始めて黙る相手でも、止めたらその繋ぎを閉じる', async () => {
    const s = await startSilentStream();
    const c = new McpClient('remote', { url: s.url });
    try {
      assert.equal(await c.start(), true, c.failure);
      const ac = new AbortController();
      const asked = c.call('hang', {}, 10_000, ac.signal);
      await until(s.started, '相手が問いを受け取る', { timeoutMs: 5_000 }); // 決め打ちの時間で待たない
      ac.abort();
      assert.match((await asked).text, /止めました/);
      await until(s.closed, '止めた呼び出しの流れが閉じる', { timeoutMs: 5_000 }).catch(() => undefined);
      assert.equal(s.closed(), true, '止めた呼び出しの流れが開いたまま');
      assert.equal(c.failure, undefined, `止めただけで失敗扱いになった: ${c.failure}`);
      assert.equal(c.running, true);
    } finally {
      c.stop();
      await s.close();
    }
  });

  test('stop() でも、返事を待っている流れを閉じ、待っている呼び出しは時間切れを待たずに返る', async () => {
    const s = await startSilentStream();
    const c = new McpClient('remote', { url: s.url });
    try {
      assert.equal(await c.start(), true, c.failure);
      const pending = c.call('hang', {}, 30_000);
      await until(s.started, '相手が問いを受け取る', { timeoutMs: 5_000 });
      const stoppedAt = Date.now();
      c.stop();
      await until(s.closed, 'stop() で流れが閉じる', { timeoutMs: 5_000 }).catch(() => undefined);
      assert.equal(s.closed(), true, 'stop() の後も流れが開いたまま');
      const got = await pending;
      assert.equal(got.isError, true);
      assert.ok(Date.now() - stoppedAt < 10_000, `stop() の後、時間切れまで待った（${Date.now() - stoppedAt}ms）`);
    } finally {
      c.stop();
      await s.close();
    }
  });
});

describe('立ち上げの途中で切っても、start() は投げない', () => {
  test('名乗りに答えない相手へ繋いでいる途中で stop() しても、false で返る', async () => {
    const held: import('node:http').ServerResponse[] = [];
    const server: Server = createServer((req, res) => {
      req.resume();
      req.on('end', () => { held.push(res); }); // 名乗りにも答えない
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const c = new McpClient('remote', { url: `http://127.0.0.1:${port}/mcp`, startupTimeoutMs: 30_000 });
    try {
      const starting = c.start();
      await until(() => held.length > 0, '相手が名乗りを受け取る', { timeoutMs: 5_000 });
      c.stop();
      assert.equal(await starting, false);
      assert.equal(c.running, false);
    } finally {
      c.stop();
      for (const res of held) res.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('取り決めた版を、名乗りの後の問いに付ける', () => {
  test('名乗りには付けず、その後の問いには相手が返した版を MCP-Protocol-Version に付ける', async () => {
    const s = await startServer();
    const c = new McpClient('remote', { url: s.url });
    try {
      assert.equal(await c.start(), true, c.failure);
      await c.call('echo', {});
      const [init, ...rest] = s.seen.headers;
      assert.equal(init?.version, undefined, '名乗りに版を付けた（まだ取り決めていない）');
      assert.ok(rest.length >= 2, `名乗りの後の問いが届いていない: ${rest.length}`);
      for (const h of rest) assert.equal(h.version, '2025-06-18', `名乗りの後の問いに版が無い: ${JSON.stringify(s.seen.headers)}`);
    } finally { c.stop(); await s.close(); }
  });

  test('付けるのは相手が返した版（こちらが送った版ではない）。切るときの DELETE にも付ける', async () => {
    const s = await startServer({ version: '2025-03-26' });
    const c = new McpClient('remote', { url: s.url });
    try {
      assert.equal(await c.start(), true, c.failure);
      await c.call('echo', {});
      const rest = s.seen.headers.slice(1);
      for (const h of rest) assert.equal(h.version, '2025-03-26', `相手が返した版ではない: ${JSON.stringify(s.seen.headers)}`);
      c.stop();
      await until(() => s.seen.deleted, '切るときの DELETE が届く', { timeoutMs: 5_000 });
      assert.equal(s.seen.deleteVersion, '2025-03-26', 'DELETE に版が無い');
    } finally { c.stop(); await s.close(); }
  });
});

describe('相手が返した版が見出しに使えない形でも、問いは止めない', () => {
  test('改行を含む版を返されたら見出しは付けず、呼び出しは通る', async () => {
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id?: number; method?: string };
        if (body.id === undefined) { res.writeHead(202); res.end(); return; }
        const result = body.method === 'initialize'
          ? { protocolVersion: '2025-06-18\r\nX-Evil: 1', capabilities: {} }
          : body.method === 'tools/list' ? { tools: [{ name: 'echo' }] } : { content: [{ type: 'text', text: '通った' }] };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const c = new McpClient('remote', { url: `http://127.0.0.1:${port}/mcp` });
    try {
      assert.equal(await c.start(), true, c.failure);
      assert.equal((await c.call('echo', {}, 5_000)).text, '通った');
    } finally {
      c.stop();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('ツールの一覧を頁に分けて返す相手', () => {
  /** `pages` の順に返す。最後の頁の後も栞を返し続ける相手（`loop`）も作れる。 */
  async function paged(pages: string[][], loop = false) {
    const asked: Array<string | undefined> = [];
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id?: number; method?: string; params?: { cursor?: string } };
        if (body.id === undefined) { res.writeHead(202); res.end(); return; }
        const say = (result: unknown) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
        };
        if (body.method === 'initialize') return say({ protocolVersion: '2025-06-18', capabilities: {} });
        asked.push(body.params?.cursor);
        const at = body.params?.cursor ? Number(body.params.cursor) : 0;
        const next = at + 1 < pages.length ? String(at + 1) : loop ? '0' : undefined;
        say({ tools: (pages[at] ?? []).map((name) => ({ name })), ...(next !== undefined ? { nextCursor: next } : {}) });
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    return { url: `http://127.0.0.1:${port}/mcp`, asked, close: () => new Promise<void>((r) => server.close(() => r())) };
  }

  test('2 頁目以降のツールも受け取る', async () => {
    // 一度しか訊いていなかったので、頁を分けて返す相手では 2 頁目以降のツールが黙って出てこなかった
    const s = await paged([['a', 'b'], ['c'], ['d']]);
    const c = new McpClient('paged', { url: s.url });
    try {
      assert.equal(await c.start(), true, c.failure);
      assert.deepEqual(c.tools.map((t) => t.name), ['a', 'b', 'c', 'd']);
      assert.deepEqual(s.asked, [undefined, '1', '2']);
    } finally { c.stop(); await s.close(); }
  });

  test('同じ栞を返し続ける相手で、回り続けない', async () => {
    const s = await paged([['a'], ['b']], true);
    const c = new McpClient('looping', { url: s.url });
    try {
      assert.equal(await c.start(), true, c.failure);
      assert.ok(s.asked.length <= 3, `訊きすぎている: ${s.asked.length} 回`);
      // 同じ頁をもう一度返されても、同じ名前を二つ入れない（名前の重なりを受け付けない相手への依頼ごと落ちる）
      const names = c.tools.map((t) => t.name);
      assert.deepEqual(names, [...new Set(names)], `同じ名前が二つある: ${names.join(', ')}`);
    } finally { c.stop(); await s.close(); }
  });
});
