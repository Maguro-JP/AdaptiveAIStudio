/**
 * ファイルを書く・消す・読むだけ、の三つを持つ MCP の相手。
 *
 * 外のツールで作業場が変わった回と、変わらなかった回を作り分けるために使う。
 * 道は引数でそのまま受ける（絶対の道）。
 */
import { createInterface } from 'node:readline';
import { writeFileSync, rmSync } from 'node:fs';

const say = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

const TOOLS = [
  { name: 'write', description: 'ファイルを書く', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } } },
  { name: 'remove', description: 'ファイルを消す', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'look', description: '読むだけ', inputSchema: { type: 'object', properties: {} } },
];

createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    say({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18' } });
  } else if (msg.method === 'tools/list') {
    say({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
  } else if (msg.method === 'tools/call') {
    const { name, arguments: args = {} } = msg.params ?? {};
    if (name === 'write') writeFileSync(args.path, args.content ?? '');
    if (name === 'remove') rmSync(args.path, { force: true });
    say({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `${name}: ok` }] } });
  }
});
