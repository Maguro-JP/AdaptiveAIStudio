/**
 * 外のツール（MCP）の口の不具合（18 回目の調査）。
 *
 * - 立ち上げのときに繋がらなかった相手は、繋ぎ直すと立ち上げ直す（名前が在るだけで「繋ぎました」と言わない）
 * - 遠くの相手への問いが一つ断られても、同じ相手へのほかの呼び出しは落とさない
 * - 繋ぎの名前を付けた問いに 404 が返ったら、動いていない扱いにする
 * - 大きすぎる返事は溜め込まずに断る
 * - 渡した API キーを、失敗の文に出さない
 * - 時間切れも相手へ取り消しを知らせる
 * - 配れない名前・object でない引数の形は配らない／直す。返りは長さで切る
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpClient } from '../src/mcp/client.ts';
import { collectTools, deliverableName, wrapTool, MCP_RESULT_MAX, blockedTools } from '../src/mcp/tools.ts';
import { connectInto } from '../src/core/mcp-setup.ts';
import type { ToolContext } from '../src/agent/tools/types.ts';
import { until } from './until.ts';

const here = dirname(fileURLToPath(import.meta.url));
const DRIBBLE = join(here, 'fixtures', 'dribble-mcp.mjs');

interface Behave {
  /** tools/call の名前ごとの振る舞い */
  call?: (name: string) => { status?: number; delayMs?: number; text?: string; body?: string } | undefined;
  /** 繋ぎの名前付きの問いに 404 を返す */
  expire?: boolean;
}

async function startServer(behave: Behave = {}) {
  const notes: string[] = [];
  const server: Server = createServer((req, res) => {
    if (req.method === 'DELETE') { res.writeHead(204); res.end(); return; }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id?: number; method?: string; params?: { name?: string } };
      if (body.id === undefined) { notes.push(body.method ?? ''); res.writeHead(202); res.end(); return; }
      if (behave.expire && body.method === 'tools/call' && req.headers['mcp-session-id']) { res.writeHead(404); res.end('no session'); return; }
      const reply = (result: unknown) => {
        const head: Record<string, string> = { 'content-type': 'application/json' };
        if (body.method === 'initialize') head['mcp-session-id'] = 'sess-1';
        res.writeHead(200, head);
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
      };
      if (body.method === 'initialize') { reply({ protocolVersion: '2025-06-18', capabilities: {} }); return; }
      if (body.method === 'tools/list') { reply({ tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }); return; }
      const how = behave.call?.(body.params?.name ?? '') ?? {};
      setTimeout(() => {
        if (res.destroyed) return;
        if (how.status) { res.writeHead(how.status, { 'content-type': 'text/plain' }); res.end('だめです'); return; }
        if (how.body !== undefined) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(how.body); return; }
        reply({ content: [{ type: 'text', text: how.text ?? 'こんにちは' }] });
      }, how.delayMs ?? 0);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/mcp`, notes, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

const ctx: ToolContext = { root: process.cwd(), signal: new AbortController().signal, approve: async () => true };

describe('繋ぎ直す', () => {
  test('**立ち上げのときに繋がらなかった相手は、繋ぎ直すと立ち上げ直してツールが出る**', async () => {
    const failed = new McpClient('dribble', { command: process.execPath, args: [join(here, 'fixtures', 'no-such-server.mjs')], startupTimeoutMs: 5_000 });
    assert.equal(await failed.start(), false);
    const clients = [failed];
    const logs: string[] = [];
    let refreshed = 0;
    try {
      const up = await connectInto(clients, 'dribble', { command: process.execPath, args: [DRIBBLE] }, (_l, t) => logs.push(t), () => { refreshed++; });
      assert.equal(up, true, logs.join('\n'));
      assert.equal(clients.length, 1, '古い相手が一覧に残っている');
      assert.notEqual(clients[0], failed);
      assert.equal(clients[0]!.running, true);
      assert.ok(clients[0]!.tools.length > 0, 'ツールが 0 件のまま');
      assert.ok(refreshed >= 1);
    } finally { for (const c of clients) c.stop(); failed.stop(); }
  });
});

describe('遠くの相手', () => {
  test('**問いが一つ断られても、同じ相手へのほかの呼び出しは落とさない**', async () => {
    const s = await startServer({ call: (name) => (name === 'bad' ? { status: 500 } : { delayMs: 300, text: 'ゆっくり' }) });
    const c = new McpClient('remote', { url: s.url });
    try {
      assert.equal(await c.start(), true, c.failure);
      const [slow, bad] = await Promise.all([c.call('slow', {}, 5_000), c.call('bad', {}, 5_000)]);
      assert.equal(bad.isError, true);
      assert.equal(slow.isError, false, slow.text);
      assert.match(slow.text, /ゆっくり/);
      assert.equal(c.running, true);
    } finally { c.stop(); await s.close(); }
  });

  test('**繋ぎの名前付きの問いに 404 が返ったら、動いていない扱いにする**', async () => {
    const s = await startServer({ expire: true });
    const c = new McpClient('remote', { url: s.url });
    try {
      assert.equal(await c.start(), true, c.failure);
      const r = await c.call('echo', {}, 5_000);
      assert.equal(r.isError, true);
      assert.equal(c.running, false, '毎回 404 になるのに動いていると言う');
      assert.match(c.failure ?? '', /繋ぎ直して/);
    } finally { c.stop(); await s.close(); }
  });

  test('**大きすぎる返事は溜め込まずに断る**', async () => {
    const huge = JSON.stringify({ jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: 'x'.repeat(9 * 1024 * 1024) }] } });
    const s = await startServer({ call: () => ({ body: huge }) });
    const c = new McpClient('remote', { url: s.url });
    try {
      assert.equal(await c.start(), true, c.failure);
      const r = await c.call('echo', {}, 10_000);
      assert.equal(r.isError, true);
      assert.match(r.text, /大きすぎます/);
    } finally { c.stop(); await s.close(); }
  });

  test('**時間切れも、相手へ取り消しを知らせる**（知らせないと相手は仕事を続ける）', async () => {
    const s = await startServer({ call: () => ({ delayMs: 2_000 }) });
    const c = new McpClient('remote', { url: s.url });
    try {
      assert.equal(await c.start(), true, c.failure);
      const r = await c.call('echo', {}, 200);
      assert.equal(r.isError, true);
      assert.match(r.text, /実行されたかもしれません/);
      await until(() => s.notes.includes('notifications/cancelled'), '取り消しが届く', { timeoutMs: 5_000 });
    } finally { c.stop(); await s.close(); }
  });
});

describe('渡した API キーを出さない', () => {
  test('**相手が標準エラーに書いたキーを、失敗の文で伏せる**', async () => {
    process.env.AAS_TEST_MCP_KEY = 'sk-test-supersecret-123456';
    const leaky = new McpClient('leaky', {
      command: process.execPath,
      args: ['-e', 'console.error("Invalid API key: " + process.env.KEY); process.exit(1)'],
      envFrom: { KEY: 'AAS_TEST_MCP_KEY' },
      startupTimeoutMs: 5_000,
    });
    try {
      assert.equal(await leaky.start(), false);
      assert.doesNotMatch(leaky.failure ?? '', /supersecret/, leaky.failure);
      assert.match(leaky.failure ?? '', /伏せ字/, leaky.failure);
      const r = await leaky.call('echo', {});
      assert.doesNotMatch(r.text, /supersecret/, r.text);
    } finally { leaky.stop(); delete process.env.AAS_TEST_MCP_KEY; }
  });
});

describe('配る形', () => {
  test('**雲側の API が受け付けない名前は配らず、そう言う**', () => {
    assert.equal(deliverableName('github', 'create_issue'), true);
    assert.equal(deliverableName('github', 'repo.list'), false);
    assert.equal(deliverableName('ギットハブ', 'x'), false);
    assert.equal(deliverableName('s', 'x'.repeat(70)), false);
    const fake = { name: 'srv', running: true, tools: [{ name: 'ok_tool' }, { name: 'bad.name' }] } as unknown as McpClient;
    assert.deepEqual(collectTools([fake]).map((t) => t.schema.name), ['srv__ok_tool']);
    assert.deepEqual(blockedTools(fake).map((b) => b.name), ['bad.name']);
  });

  test('**object でない引数の形は、既定の形に置き換える**', () => {
    const fake = { name: 'srv' } as unknown as McpClient;
    const t = wrapTool(fake, { name: 'x', inputSchema: { type: 'string' } });
    assert.equal((t.schema.parameters as { type?: string }).type, 'object');
    const keep = wrapTool(fake, { name: 'y', inputSchema: { type: 'object', properties: { a: { type: 'string' } } } });
    assert.deepEqual(Object.keys((keep.schema.parameters as { properties: object }).properties), ['a']);
  });

  test('**長い返りは切って、省いた長さを言う**', async () => {
    const fake = { name: 'srv', call: async () => ({ text: 'あ'.repeat(MCP_RESULT_MAX + 500), isError: false }) } as unknown as McpClient;
    const r = await wrapTool(fake, { name: 'x' }).run({}, ctx);
    assert.ok(r.content.length < MCP_RESULT_MAX + 200);
    assert.match(r.content, /以降 500 字は長いので省きました/);
  });
});
