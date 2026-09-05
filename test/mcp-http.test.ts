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
    const c = new McpClient('remote', { url: s.url });
    await c.start();
    c.stop();
    assert.equal(c.running, false);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(s.seen.deleted, true);
    await s.close();
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
