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

interface Seen { headers: Record<string, string | undefined>[]; deleted: boolean }

/**
 * 相手役。名乗り・道具の一覧・呼び出しに答える。
 * `sse` を立てると、流れ（text/event-stream）で返す。
 */
async function startServer(opts: { sse?: boolean; fail?: number; batch?: boolean } = {}) {
  const seen: Seen = { headers: [], deleted: false };
  const server: Server = createServer((req, res) => {
    if (req.method === 'DELETE') { seen.deleted = true; res.writeHead(204); res.end(); return; }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.headers.push({
        authorization: req.headers.authorization as string | undefined,
        session: req.headers['mcp-session-id'] as string | undefined,
        accept: req.headers.accept as string | undefined,
      });
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id?: number; method?: string };
      if (opts.fail) { res.writeHead(opts.fail, { 'content-type': 'text/plain' }); res.end('だめです'); return; }

      // 知らせ（id が無い）には、返す本文が無い。
      if (body.id === undefined) { res.writeHead(202); res.end(); return; }

      const result = body.method === 'initialize'
        ? { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'つくりもの', version: '1' } }
        : body.method === 'tools/list'
          ? { tools: [{ name: 'echo', description: '返すだけ', inputSchema: { type: 'object' } }] }
          : { content: [{ type: 'text', text: 'こんにちは' }] };
      const message = { jsonrpc: '2.0', id: body.id, result };

      const head: Record<string, string> = { 'content-type': opts.sse ? 'text/event-stream' : 'application/json' };
      if (body.method === 'initialize') head['mcp-session-id'] = 'sess-1';
      res.writeHead(200, head);
      const payload = opts.batch ? JSON.stringify([message]) : JSON.stringify(message);
      res.end(opts.sse ? `event: message\ndata: ${payload}\n\n` : payload);
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
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id?: number; method?: string; params?: { name?: string } };
        if (body.method === 'notifications/cancelled') { res.writeHead(500); res.end('だめです'); return; }
        if (body.id === undefined) { res.writeHead(202); res.end(); return; }
        const say = (result: unknown) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
        };
        if (body.method === 'initialize') say({ protocolVersion: '2025-06-18', capabilities: {} });
        else if (body.method === 'tools/list') say({ tools: [{ name: 'hang' }, { name: 'slow' }] });
        else if (body.params?.name === 'hang') held.push(res); // 返さない
        else setTimeout(() => say({ content: [{ type: 'text', text: 'おそく返した' }] }), 800);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const c = new McpClient('remote', { url: `http://127.0.0.1:${port}/mcp` });
    try {
      assert.equal(await c.start(), true, c.failure);
      const slow = c.call('slow', {}, 10_000);
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 200).unref();
      assert.match((await c.call('hang', {}, 10_000, ac.signal)).text, /止めました/);
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
      setTimeout(() => ac.abort(), 200).unref();
      assert.match((await c.call('hang', {}, 10_000, ac.signal)).text, /止めました/);
      await until(s.closed, '止めた呼び出しの流れが閉じる', { timeoutMs: 5_000 }).catch(() => undefined);
      assert.equal(s.closed(), true, '止めた呼び出しの流れが開いたまま');
      assert.equal(c.failure, undefined, `止めただけで失敗扱いになった: ${c.failure}`);
      assert.equal(c.running, true);
    } finally {
      c.stop();
      await s.close();
    }
  });

  test('stop() でも、返事を待っている流れを閉じる', async () => {
    const s = await startSilentStream();
    const c = new McpClient('remote', { url: s.url });
    try {
      assert.equal(await c.start(), true, c.failure);
      const pending = c.call('hang', {}, 10_000);
      await new Promise((r) => setTimeout(r, 200));
      c.stop();
      await until(s.closed, 'stop() で流れが閉じる', { timeoutMs: 5_000 }).catch(() => undefined);
      assert.equal(s.closed(), true, 'stop() の後も流れが開いたまま');
      await pending;
    } finally {
      c.stop();
      await s.close();
    }
  });
});
