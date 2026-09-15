/**
 * 繋ぐ・外すが、**いま動いているセッションにも効くこと。**
 *
 * `connect_service` は「次の依頼から使えます」、`disconnect_service` は
 * 「次の依頼からは出てきません」と言っていた。どちらも**設定ファイルを
 * 書き換えるだけ**で、動いている相手の一覧は `Session.create` のときに作った
 * きり作り直さない。外してもツールは呼べたまま、繋いでも次の依頼では使えない。
 * 一度も繋いでいない id でも「外しました」と返っていた。
 *
 * ここは口（tool）を**実際に呼ぶ**。下の層（`disconnectService`）だけを見ても、
 * 動いている側に効いていないことには気づけない。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './tmp.ts';
import { createConnectServiceTool, createDisconnectServiceTool } from '../src/agent/tools/services.ts';
import type { ToolContext } from '../src/agent/tools/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const DRIBBLE = join(here, 'fixtures', 'dribble-mcp.mjs');

function ctx(root: string): ToolContext {
  return { root, signal: new AbortController().signal, approve: async () => true };
}

/** 一時の場所を作って、設定の在り処を指す。**この試験の中だけ。** */
async function scratch(): Promise<string> {
  const home = await tempDir('aas-svc-');
  process.env.AAS_HOME = home;
  process.env.AAS_STATE_DIR = join(home, 'state');
  process.env.AAS_CONFIG = join(home, 'aas.config.json');
  await mkdir(join(home, 'work'), { recursive: true });
  await writeFile(process.env.AAS_CONFIG, JSON.stringify({
    runtime: { kind: 'inproc' },
    initiative: { enabled: false },
    mcp: { servers: { dribble: { command: process.execPath, args: [DRIBBLE] } } },
    agent: { root: join(home, 'work') },
  }, null, 2));
  return home;
}

/** 相手を起こしたところまで行ったセッション。 */
async function live(home: string) {
  const { loadConfig } = await import('../src/config.ts');
  const { Session } = await import('../src/core/session.ts');
  const { until } = await import('./until.ts');
  const session = await Session.create(loadConfig().config, { approve: () => Promise.resolve(true) });
  const names = () => session.toolPool.mcp.map((t) => t.schema.name);
  // **決め打ちで待たない。**出るまで見る（出なければ上限で諦める）。
  await until(() => names().includes('dribble__echo'), '相手のツールが出てくる', { timeoutMs: 15_000 });
  return { session, names };
}

describe('外すと、いま動いている分も止まる', () => {
  test('**外した相手のツールが、その場で消える**', async () => {
    const home = await scratch();
    const { session, names } = await live(home);
    try {
      const off = session.toolPool.mcp.find((t) => t.schema.name === 'disconnect_service');
      assert.ok(off, 'disconnect_service が居ない');
      const said = await off.run({ id: 'dribble' }, ctx(join(home, 'work')));
      assert.equal(said.isError, undefined, said.content);
      assert.ok(!names().includes('dribble__echo'),
        `外したのに呼べたまま: ${names().join(', ')}`);
    } finally { await session.close(); }
  });

  test('**一度も繋いでいない id は、「外しました」と言わない**', async () => {
    const home = await scratch();
    const { session } = await live(home);
    try {
      const off = session.toolPool.mcp.find((t) => t.schema.name === 'disconnect_service');
      const said = await off!.run({ id: 'いちども繋いでいない' }, ctx(join(home, 'work')));
      assert.equal(said.isError, true, `外したことにしている: ${said.content}`);
      assert.doesNotMatch(said.content, /外しました/, said.content);
    } finally { await session.close(); }
  });
});

describe('繋ぐと、いま動いているセッションへ足しにいく', () => {
  test('**書いた立ち上げ方が、そのまま渡る**', async () => {
    await scratch();
    const seen: { id: string; hasCommand: boolean }[] = [];
    const tool = createConnectServiceTool({
      onConnected: async (id, spec) => {
        seen.push({ id, hasCommand: Boolean(spec.command || spec.url) });
        return true;
      },
    });
    const root = await tempDir('aas-svc-root-');
    const said = await tool.run({ id: 'github-local' }, ctx(root));
    assert.equal(said.isError, undefined, said.content);
    assert.deepEqual(seen.map((s) => s.id), ['github-local'], '起こしにいっていない');
    assert.equal(seen[0]?.hasCommand, true, '立ち上げ方が渡っていない');
    assert.match(said.content, /次の依頼から使えます/, said.content);
  });

  test('**起こせなかったら、使えると言わない**', async () => {
    await scratch();
    const tool = createConnectServiceTool({ onConnected: async () => false });
    const root = await tempDir('aas-svc-root-');
    const said = await tool.run({ id: 'github-local' }, ctx(root));
    assert.doesNotMatch(said.content, /次の依頼から使えます/,
      `起こせていないのに使えると言っている: ${said.content}`);
    assert.match(said.content, /起こすことはできませんでした/, said.content);
  });

  test('セッションの無い所では、書いたところまでを言う（対）', async () => {
    // CLI から直に使う道。**嘘にならない言い方をする。**
    await scratch();
    const said = await createDisconnectServiceTool().run(
      { id: 'いない' }, ctx(await tempDir('aas-svc-root-')),
    );
    assert.equal(said.isError, true, said.content);
  });
});
