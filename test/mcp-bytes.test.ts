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
  // 閉じた管へ書いたときの失敗の出方（EPIPE か、黙って溜まるか）は OS の管の作りによる。Windows では確かめていない
  test('相手が標準入力を閉じたまま生きているとき、呼び出しは失敗として返り、以後は待たずに断る', { skip: process.platform === 'win32' }, async () => {
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
          // 先に閉じてから返す。返事を受け取った時点で、入力は必ず閉じている（待つ時間に頼らない）
          rl.close(); process.stdin.destroy(); try { closeSync(0); } catch {}
          say({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'x' }] } });
        }
      });
    `]);
    assert.equal(await c.start(), true, `立ち上がらなかった: ${c.failure}`);
    const started = Date.now();
    const got = await c.call('x', {}, 30_000);
    assert.equal(got.isError, true);
    assert.match(got.text, /送れませんでした/);
    assert.ok(Date.now() - started < 10_000, `時間切れまで待った（${Date.now() - started}ms）`);
    const again = await c.call('x', {}, 30_000);
    assert.match(again.text, /動いていません/, `二度目も書きに行った: ${again.text}`);
  });
});

describe('止めた相手を残さない', () => {
  // Windows の kill は初めから強制終了なので、SIGTERM を無視する相手は作れない
  test('SIGTERM を無視する相手も、stop() の後しばらくで強制的に終わらせる', { skip: process.platform === 'win32' }, async () => {
    const c = client(['-e', `
      process.on('SIGTERM', () => {}); // 無視する
      const { createInterface } = require('node:readline');
      createInterface({ input: process.stdin }).on('line', (line) => {
        const msg = JSON.parse(line);
        const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
        if (msg.method === 'initialize') say({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18' } });
        else if (msg.method === 'tools/list') say({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'pid' }] } });
        else if (msg.method === 'tools/call') say({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: String(process.pid) }] } });
      });
      setInterval(() => {}, 1000); // 入力が閉じても生き続ける
    `]);
    assert.equal(await c.start(), true, `立ち上がらなかった: ${c.failure}`);
    const pid = Number((await c.call('pid', {}, 10_000)).text);
    assert.ok(pid > 0, `pid が取れない: ${pid}`);
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    try {
      c.stop();
      const deadline = Date.now() + 15_000;
      while (alive() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      assert.equal(alive(), false, 'stop() の後も相手が残っている');
    } finally {
      // 途中で落ちても、SIGTERM を無視する相手を試験の後に残さない
      if (alive()) process.kill(pid, 'SIGKILL');
    }
  });
});

describe('相手から来た問いを、こちらの問いの返事と取り違えない', () => {
  test('相手が同じ番号で ping を訊いてきても、こちらの呼び出しはその問いで済まず、ping には答え、持っていない力は断る', async () => {
    const c = client(['-e', `
      const { createInterface } = require('node:readline');
      let callId, pinged = false, refused = false, done = false;
      createInterface({ input: process.stdin }).on('line', (line) => {
        const msg = JSON.parse(line);
        const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
        if (msg.method === 'initialize') say({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18' } });
        else if (msg.method === 'tools/list') say({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'x' }] } });
        else if (msg.method === 'tools/call') {
          callId = msg.id;
          // こちらの問いと同じ番号で、相手から訊く（相手の番号は相手が振るので、重なることがある）
          say({ jsonrpc: '2.0', id: callId, method: 'ping' });
          say({ jsonrpc: '2.0', id: callId + 1000, method: 'roots/list' });
        } else if (msg.id === callId && 'result' in msg) {
          pinged = true;
        } else if (msg.id === callId + 1000 && msg.error && msg.error.code === -32601) {
          refused = true;
        }
        if (pinged && refused && !done) {
          done = true;
          say({ jsonrpc: '2.0', id: callId, result: { content: [{ type: 'text', text: 'ping に答え、roots/list は断った' }] } });
        }
      });
    `]);
    assert.equal(await c.start(), true, `立ち上がらなかった: ${c.failure}`);
    const got = await c.call('x', {}, 10_000);
    assert.equal(got.isError, false, got.text);
    assert.equal(got.text, 'ping に答え、roots/list は断った');
  });
});

describe('method を持つ返事も、返事として読む', () => {
  test('返事に method を付けて返す相手でも、こちらの呼び出しは済む', async () => {
    const c = client(['-e', `
      const { createInterface } = require('node:readline');
      createInterface({ input: process.stdin }).on('line', (line) => {
        const msg = JSON.parse(line);
        const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
        if (msg.method === 'initialize') say({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18' } });
        else if (msg.method === 'tools/list') say({ jsonrpc: '2.0', id: msg.id, method: 'tools/list', result: { tools: [{ name: 'x' }] } });
        else if (msg.method === 'tools/call') say({ jsonrpc: '2.0', id: msg.id, method: 'tools/call', result: { content: [{ type: 'text', text: '返しました' }] } });
      });
    `]);
    assert.equal(await c.start(), true, `立ち上がらなかった: ${c.failure}`);
    assert.equal((await c.call('x', {}, 10_000)).text, '返しました');
  });
});

describe('立ち上げ直したとき、前の相手の終わりを今の相手のことにしない', () => {
  test('止めた相手が遅れて終わっても、立ち上げ直した相手への呼び出しは落ちない', async () => {
    // SIGTERM を受けてから少し置いて終わる相手。止めてすぐ立ち上げ直すと、前の相手の終わりが後から届く
    const c = client(['-e', `
      process.on('SIGTERM', () => setTimeout(() => process.exit(0), 400));
      const { createInterface } = require('node:readline');
      createInterface({ input: process.stdin }).on('line', (line) => {
        const msg = JSON.parse(line);
        const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
        if (msg.method === 'initialize') say({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18' } });
        else if (msg.method === 'tools/list') say({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'slow' }] } });
        else if (msg.method === 'tools/call') setTimeout(() => say({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: '返しました' }] } }), 1200);
      });
      setInterval(() => {}, 1000);
    `]);
    assert.equal(await c.start(), true, `立ち上がらなかった: ${c.failure}`);
    c.stop();
    assert.equal(await c.start(), true, `立ち上げ直せなかった: ${c.failure}`);
    const got = await c.call('slow', {}, 10_000);
    assert.equal(got.isError, false, `前の相手の終わりで、今の呼び出しが落ちた: ${got.text}`);
    assert.equal(got.text, '返しました');
    assert.equal(c.running, true, '前の相手の終わりで、今の相手まで止まったことになった');
  });

  test('立ち上げている途中で止めて立ち上げ直しても、前の立ち上げの失敗で今の相手を止めない', async () => {
    // 名乗りに 0.5 秒かかる相手。名乗る前に止めて立ち上げ直す
    const c = client(['-e', `
      const { createInterface } = require('node:readline');
      createInterface({ input: process.stdin }).on('line', (line) => {
        const msg = JSON.parse(line);
        const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
        if (msg.method === 'initialize') setTimeout(() => say({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18' } }), 500);
        else if (msg.method === 'tools/list') say({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'x' }] } });
      });
      setInterval(() => {}, 1000);
    `]);
    const first = c.start();
    await new Promise((r) => setTimeout(r, 100));
    c.stop();
    const second = c.start();
    assert.equal(await first, false, '止めた立ち上げが済んだことになった');
    assert.equal(await second, true, `前の立ち上げの失敗で、立ち上げ直した相手が落ちた: ${c.failure}`);
    assert.equal(c.running, true);
  });
});
