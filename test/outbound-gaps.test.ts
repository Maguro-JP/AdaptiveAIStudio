/**
 * 外へ出る口と外のツールを繋ぐ口の不具合（51 回目の調査）。
 *
 * - `connect_service` が、利用者が置いた設定（手元で動かす形・止めてある）を、カタログの形と「入」で丸ごと上書きしていた。
 *   `list_services` は、設定に在るか・止めてあるかを言わなかった
 * - `fetch_url` が上限でバイトを切ると、字の途中で切れて CP932 と取り違えた。`charset=utf-8` と言われても推し量っていた
 *
 * 会話から繋いだ・外したツールが組み直しで戻る件（`#configForSession`）・`.env` の書き方・端末の合議のチェックは、試験を書いていない。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { createConnectServiceTool, createListServicesTool } from '../src/agent/tools/services.ts';
import { saveMcpServer } from '../src/ui/settings.ts';
import { readBounded } from '../src/agent/tools/network.ts';
import { trimPartialUtf8 } from '../src/core/text.ts';
import type { ToolContext } from '../src/agent/tools/types.ts';

async function withConfig<T>(run: (path: string) => Promise<T>): Promise<T> {
  const dir = await tempDir('aas-outbound-cfg-');
  const path = join(dir, 'aas.config.json');
  const before = process.env.AAS_CONFIG;
  process.env.AAS_CONFIG = path;
  try { return await run(path); } finally {
    if (before === undefined) delete process.env.AAS_CONFIG; else process.env.AAS_CONFIG = before;
  }
}

const ctx = (root: string): ToolContext => ({ root, signal: new AbortController().signal, approve: async () => true });

describe('外のツールを繋ぐ', () => {
  test('**設定に在る相手は、繋ぎ直して上書きしない**（手元で動かす形・止めてある形を残す）', async () => {
    await withConfig(async (path) => {
      await saveMcpServer('notion', { command: 'npx', args: ['@notionhq/notion-mcp-server'], enabled: false });
      const tool = createConnectServiceTool();
      const r = await tool.run({ id: 'notion' }, ctx(await tempDir('aas-outbound-root-')));
      assert.notEqual(r.isError, true, r.content);
      assert.match(r.content, /止めてあります/);
      const saved = JSON.parse(await readFile(path, 'utf8')) as { mcp: { servers: Record<string, Record<string, unknown>> } };
      assert.equal(saved.mcp.servers.notion!.command, 'npx', `利用者の形を上書きした: ${JSON.stringify(saved.mcp.servers.notion)}`);
      assert.equal(saved.mcp.servers.notion!.enabled, false, '止めてあったものを入れた');
    });
  });

  test('**一覧に、設定に在るもの・止めてあるもの・動いているものを出す**', async () => {
    await withConfig(async () => {
      await saveMcpServer('notion', { command: 'npx', args: ['x'], enabled: false });
      await saveMcpServer('github', { url: 'https://example.invalid/mcp' });
      const tool = createListServicesTool({ running: () => ['github'] });
      const r = await tool.run({}, ctx(await tempDir('aas-outbound-root-')));
      assert.match(r.content, /notion: 止めてある（手元で動かす）/);
      assert.match(r.content, /github: 動いている（遠くの口）/);
    });
  });
});

describe('取ってきた頁の読み方', () => {
  test('**上限で切っても、字の途中で切れた UTF-8 を CP932 と取り違えない**', async () => {
    const page = Buffer.from('あ'.repeat(1000), 'utf8');
    // 1000 バイトずつ届く（3 バイトの字の途中で区切れる）。一つ目の塊で上限に当たる
    const body = new ReadableStream<Uint8Array>({
      start(c) { for (let i = 0; i < page.length; i += 1000) c.enqueue(page.subarray(i, i + 1000)); c.close(); },
    });
    const text = await readBounded(new Response(body), 1000, 'text/plain');
    assert.match(text, /^あ+$/, `取り違えた: ${text.slice(0, 20)}`);
  });

  test('**相手が utf-8 と言っていれば、そのとおりに読む**', async () => {
    const res = new Response(Buffer.from('日本語の頁', 'utf8'));
    assert.equal(await readBounded(res, 10_000, 'text/plain; charset=utf-8'), '日本語の頁');
  });

  test('途中で切れた字だけを落とす', () => {
    const a = Buffer.from('aあ', 'utf8');
    assert.deepEqual([...trimPartialUtf8(a.subarray(0, 3))], [...Buffer.from('a')]);
    assert.deepEqual([...trimPartialUtf8(a)], [...a], '切れていない字を落とした');
  });
});
