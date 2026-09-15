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
