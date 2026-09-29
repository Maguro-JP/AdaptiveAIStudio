/**
 * 届いた塊を、文字に直すところ。
 *
 * **塊ごとに toString() すると、日本語は塊の切れ目で化ける。**
 * 1文字3バイトなので、切れ目が文字の途中に来ると壊れる。
 * 長い返事のときだけ起きるので、短い試しでは気づけない。
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpClient } from '../src/mcp/client.ts';

const here = dirname(fileURLToPath(import.meta.url));
const open: McpClient[] = [];
afterEach(() => { for (const c of open.splice(0)) c.stop(); });

function client(args: string[], startupTimeoutMs = 20_000): McpClient {
  const c = new McpClient('試し', {
    command: process.execPath,
    args: ['--experimental-strip-types', ...args],
    startupTimeoutMs,
  });
  open.push(c);
  return c;
}

describe('文字の途中で切れても化けさせない', () => {
  test('1バイトずつ返す相手でも、日本語がそのまま返る', async () => {
    const c = client([join(here, 'fixtures/dribble-mcp.mjs')]);
    assert.equal(await c.start(), true, `立ち上がらなかった: ${c.failure}`);
    const got = await c.call('echo', {});
    assert.equal(got.isError, false, got.text);
    assert.equal(got.text, 'あいうえおかきくけこ'.repeat(20));
    // 化けたときに出る文字が、一つも混ざっていないこと。
    assert.doesNotMatch(got.text, /�/, '置換文字が混ざっている（塊の切れ目で壊れた）');
  });
});

describe('行区切りを守らない相手を、道連れにしない', () => {
  test('改行なしで出し続ける相手は、こちらが切る', async () => {
    const c = client(['-e', `
      const chunk = Buffer.alloc(1024 * 1024, 0x61);
      process.stdin.on('data', () => {
        const push = () => { process.stdout.write(chunk); setImmediate(push); };
        push();
      });
    `], 15_000);
    // 立ち上げ（initialize）の返事は来ないので、失敗して返る。
    // **返ってくること**が要点。溜め込み続けて落ちるのが元の姿。
    assert.equal(await c.start(), false);
    assert.ok(c.failure, '理由が残っていない');
  });
});

describe('返事をしない相手の呼び出しを、止めたら待たない', () => {
  test('■（signal）で止めたら、時間切れを待たずに返す', async () => {
    const c = client(['-e', `
      const { createInterface } = require('node:readline');
      createInterface({ input: process.stdin }).on('line', (line) => {
        const msg = JSON.parse(line);
        const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
        if (msg.method === 'initialize') say({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18' } });
        else if (msg.method === 'tools/list') say({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'hang', description: '返さない' }] } });
        // tools/call には返さない
      });
    `]);
    assert.equal(await c.start(), true, `立ち上がらなかった: ${c.failure}`);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300).unref();
    const started = Date.now();
    const got = await c.call('hang', {}, 30_000, ac.signal);
    assert.equal(got.isError, true);
    assert.match(got.text, /止めました/);
    assert.ok(Date.now() - started < 10_000, `止めたのに時間切れまで待った（${Date.now() - started}ms）`);
  });

  test('止めたら、相手にも取り消しを知らせる（notifications/cancelled に、止めた呼び出しの id を載せる）', async () => {
    const c = client(['-e', `
      const { createInterface } = require('node:readline');
      let hung;
      const cancelled = [];
      createInterface({ input: process.stdin }).on('line', (line) => {
        const msg = JSON.parse(line);
        const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
        if (msg.method === 'initialize') say({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18' } });
        else if (msg.method === 'tools/list') say({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'hang' }, { name: 'seen' }] } });
        else if (msg.method === 'notifications/cancelled') cancelled.push(msg.params.requestId);
        else if (msg.method === 'tools/call' && msg.params.name === 'hang') hung = msg.id;
        else if (msg.method === 'tools/call' && msg.params.name === 'seen') {
          say({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify({ hung, cancelled }) }] } });
        }
      });
    `]);
    assert.equal(await c.start(), true, `立ち上がらなかった: ${c.failure}`);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300).unref();
    const got = await c.call('hang', {}, 30_000, ac.signal);
    assert.match(got.text, /止めました/);
    const seen = JSON.parse((await c.call('seen', {}, 10_000)).text) as { hung: number; cancelled: number[] };
    assert.equal(typeof seen.hung, 'number', '相手に hang が届いていない');
    assert.deepEqual(seen.cancelled, [seen.hung], `取り消しが届いていない、または違う id: ${JSON.stringify(seen)}`);
  });
});

describe('相手の入力が閉じていても、こちらは落ちない', () => {
  test('相手が標準入力を閉じたまま生きているとき、呼び出しは失敗として返る（EPIPE を受け手の無い失敗にしない）', async () => {
    const c = client(['-e', `
      const { createInterface } = require('node:readline');
      const { closeSync } = require('node:fs');
      setInterval(() => {}, 1000); // 生き続ける（exit の知らせで片づく道を通らせない）
      const rl = createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        const msg = JSON.parse(line);
        const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
        if (msg.method === 'initialize') say({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18' } });
        else if (msg.method === 'tools/list') {
          say({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'x' }] } });
          rl.close(); process.stdin.destroy(); try { closeSync(0); } catch {}
        }
      });
    `]);
    assert.equal(await c.start(), true, `立ち上がらなかった: ${c.failure}`);
    await new Promise((r) => setTimeout(r, 300));
    const got = await c.call('x', {}, 5_000);
    assert.equal(got.isError, true);
    assert.match(got.text, /送れませんでした.*EPIPE/);
  });
});
