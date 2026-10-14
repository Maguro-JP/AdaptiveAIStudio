import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';

const setup = async () => {
  const home = await tempDir('aas-svc136-');
  process.env.AAS_HOME = home;
  process.env.AAS_CONFIG = join(home, 'aas.config.json');
  return process.env.AAS_CONFIG;
};
const ctx = (approve: () => Promise<boolean>) => ({ root: '.', approve, signal: new AbortController().signal }) as never;

test('承認を待つ間に利用者が書いた設定を、繋ぐときに上書きしない', async () => {
  const cfg = await setup();
  const { createConnectServiceTool } = await import('../src/agent/tools/services.ts');
  await writeFile(cfg, JSON.stringify({ other: 1 }));
  const r = await createConnectServiceTool().run({ id: 'playwright' }, ctx(async () => {
    await writeFile(cfg, JSON.stringify({ other: 1, mcp: { servers: { playwright: { command: 'mylocal', args: ['x'], enabled: false } } } }));
    return true;
  }));
  assert.match(r.content, /止めてあります/);
  const saved = JSON.parse(await readFile(cfg, 'utf8'));
  assert.deepEqual(saved.mcp.servers.playwright, { command: 'mylocal', args: ['x'], enabled: false });
});

test('同じ相手を同時に二度繋いでも、起こすのは一度', async () => {
  const cfg = await setup();
  const { createConnectServiceTool } = await import('../src/agent/tools/services.ts');
  await writeFile(cfg, '{}');
  let started = 0;
  const tool = createConnectServiceTool({ onConnected: async () => { started += 1; return true; } });
  const rs = await Promise.all([tool.run({ id: 'playwright' }, ctx(async () => true)), tool.run({ id: 'playwright' }, ctx(async () => true))]);
  assert.equal(started, 1);
  assert.equal(rs.filter((r) => /もう設定に在ります/.test(r.content)).length, 1);
});

test('壊れた項目（null）は「在る」と言わず、繋ぎ直せる', async () => {
  const cfg = await setup();
  const { createConnectServiceTool } = await import('../src/agent/tools/services.ts');
  await writeFile(cfg, JSON.stringify({ mcp: { servers: { playwright: null } } }));
  const r = await createConnectServiceTool().run({ id: 'playwright' }, ctx(async () => true));
  assert.doesNotMatch(r.content, /もう設定に在ります/);
  const saved = JSON.parse(await readFile(cfg, 'utf8'));
  assert.equal(typeof saved.mcp.servers.playwright.command, 'string');
});
