/**
 * 行区切りの JSON-RPC を、**1バイトずつ**返す相手。
 *
 * 日本語は1文字3バイトなので、こう出せば必ず文字の途中で塊が切れる。
 * 本物の相手でも長い返事のときには起きるが、狙って起こせないので、
 * ここでは必ず起きるようにしておく。
 */
import { createInterface } from 'node:readline';

const say = async (obj) => {
  const bytes = Buffer.from(`${JSON.stringify(obj)}\n`, 'utf8');
  for (const b of bytes) {
    process.stdout.write(Buffer.from([b]));
    await new Promise((r) => setImmediate(r));
  }
};

const LONG = 'あいうえおかきくけこ'.repeat(20);

createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    void say({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18' } });
  } else if (msg.method === 'tools/list') {
    void say({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'echo', description: '返す' }] } });
  } else if (msg.method === 'tools/call') {
    void say({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: LONG }] } });
  }
});
