/**
 * AI から画面へ向かう道。
 *
 * 画面から AI へは渡るようになった（いま開いているファイル・選んだ所）。
 * **逆が無かった。**答えに `a.ts:120` と書かれても、人が横の一覧から探し直す。
 *
 * ここで見るのは三つ。作業場の外は開かせないこと、受け手が無い入口（端末）では
 * 「開く先がありません」と言うこと、そして画面のある入口では**本当に伝わる**こと。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, symlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { until } from './until.ts';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createShowFileTool } from '../src/agent/tools/show.ts';

process.env.AAS_STATE_DIR = await tempDir('aas-show-state-');
const { UiServer } = await import('../src/ui/server.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');

async function place() {
  const root = await tempDir('aas-show-');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'), 'export const x = 1;\n');
  return root;
}

const ctxFor = (root: string) => ({ root, approve: async () => true as never }) as never;

describe('画面で開かせる（show_file）', () => {
  test('**呼ばれたら、道と行が画面へ伝わる**', async () => {
    const root = await place();
    const seen: Array<{ path: string; line?: number }> = [];
    const tool = createShowFileTool((at) => seen.push(at));
    const got = await tool.run({ path: 'src/a.ts', line: 1 }, ctxFor(root));
    assert.notEqual(got.isError, true, `失敗している: ${got.content}`);
    assert.deepEqual(seen, [{ path: 'src/a.ts', line: 1 }]);
    assert.match(got.content, /src\/a\.ts/);
    assert.match(got.content, /1 行目/);
  });

  test('行を言わなければ、行なしで伝える', async () => {
    const root = await place();
    const seen: Array<{ path: string; line?: number }> = [];
    const tool = createShowFileTool((at) => seen.push(at));
    await tool.run({ path: 'src/a.ts' }, ctxFor(root));
    assert.deepEqual(seen, [{ path: 'src/a.ts' }]);
  });

  test('**作業場の外は開かせない**', async () => {
    const root = await place();
    const outside = await tempDir('aas-show-out-');
    await writeFile(join(outside, 'secret.txt'), 'ひみつ\n');
    // リンクを辿った先まで見る（中のリンク一つで外を開かせられる）。
    await symlink(join(outside, 'secret.txt'), join(root, 'link.txt')).catch(() => undefined);
    const seen: unknown[] = [];
    const tool = createShowFileTool((at) => seen.push(at));
    for (const path of ['../secret.txt', outside, 'link.txt']) {
      const got = await tool.run({ path }, ctxFor(root));
      assert.equal(got.isError, true, `外を開かせている: ${path}`);
    }
    assert.deepEqual(seen, [], `外の道が画面へ伝わっている: ${JSON.stringify(seen)}`);
  });

  test('**受け手が無ければ、開いたことにしない**', async () => {
    // 端末の入口には画面が無い。「開きました」と言うと、嘘になる。
    const root = await place();
    const tool = createShowFileTool();
    const got = await tool.run({ path: 'src/a.ts' }, ctxFor(root));
    assert.equal(got.isError, true);
    assert.match(got.content, /開く先がありません/);
  });
});

/** 一度だけ `show_file` を呼んで、そのあと終わる相手。 */
async function fakeModel() {
  let asked = 0;
  const server = createServer((req, res) => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"data":[{"id":"m"}]}');
    }
    req.on('data', () => undefined);
    req.on('end', () => {
      asked += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (asked === 1) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'show_file', arguments: '{"path":"src/a.ts","line":1}' } }] } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'そこです。\nTASK_DONE\n' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

describe('呼ばれた「開いて」が、画面まで届く', () => {
  test('**`show_file` を呼ぶと、画面へ show が流れる**', async () => {
    const root = await place();
    const fake = await fakeModel();
    const s = new UiServer({
      port: 0,
      config: {
        ...DEFAULT_CONFIG,
        providers: [{ id: 'p', kind: 'openai-compatible', baseUrl: fake.baseUrl, locality: 'local', models: ['m'] }],
        candidates: ['p:m'],
        runtime: { kind: 'ollama' },
        agent: { root, approval: 'auto' },
        initiative: { enabled: false },
      } as typeof DEFAULT_CONFIG,
    });
    const base = (await s.start()).replace(/\/$/, '');
    const events: Array<Record<string, unknown>> = [];
    const ac = new AbortController();
    try {
      // 出来事を読み始めてから送る（`show` は依頼の途中で流れる）。
      const res = await fetch(`${base}/api/events`, { signal: ac.signal });
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      void (async () => {
        let buf = '';
        try {
          for (;;) {
            const got = await reader.read();
            if (got.done) break;
            buf += dec.decode(got.value, { stream: true });
            let nl: number;
            while ((nl = buf.indexOf('\n\n')) !== -1) {
              const chunk = buf.slice(0, nl); buf = buf.slice(nl + 2);
              for (const line of chunk.split('\n')) {
                if (!line.startsWith('data: ')) continue;
                try { events.push(JSON.parse(line.slice(6)) as Record<string, unknown>); } catch { /* 注釈 */ }
              }
            }
          }
        } catch { /* 読むのをやめた */ }
      })();
      await fetch(`${base}/api/send`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'どこを直したか見せて' }),
      });
      await until(() => events.some((e) => e.type === 'show'), '画面へ show が流れる', { timeoutMs: 30_000 });
      const shown = events.find((e) => e.type === 'show')!;
      assert.equal(shown.path, 'src/a.ts');
      assert.equal(shown.line, 1);
    } finally {
      ac.abort();
      await s.stop();
      await fake.close();
    }
  });
});
