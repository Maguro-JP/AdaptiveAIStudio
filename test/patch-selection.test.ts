/**
 * AI が、画面で選んでいる所を書き換える道（`replace_selection`）。
 *
 * ここまで AI がファイルを直す道は「ディスクへ書く」だけだった。画面で直している
 * 最中に書かれるとファイルと欄が二つに割れ、**選んだ所だけ直してほしいのに、
 * それ以外の書きかけも道連れ**になる。ここは欄の中だけを書き換える。
 *
 * 見るのは三つ。範囲は**利用者が選んだ所**であること（AI は文だけを出す）、
 * 選んでいないときは使えないこと、そして画面まで本当に届くこと。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tempDir } from './tmp.ts';
import { until } from './until.ts';
import { createReplaceSelectionTool, type EditorSelection } from '../src/agent/tools/patch.ts';

process.env.AAS_STATE_DIR = await tempDir('aas-patch-state-');
const { UiServer } = await import('../src/ui/server.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');

async function place() {
  const root = await tempDir('aas-patch-');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'), 'const x = 1;\nconst y = 2;\n');
  return root;
}

const ctxFor = (root: string) => ({ root, approve: async () => true as never }) as never;
const picked = (path = 'src/a.ts'): EditorSelection => ({ path, from: 1, to: 1, text: 'const x = 1;' });

describe('選んでいる所を書き換える（replace_selection）', () => {
  test('**呼ばれたら、選んでいる所と入れ替える文が画面へ渡る**', async () => {
    const root = await place();
    const seen: unknown[] = [];
    const tool = createReplaceSelectionTool(() => picked(), (at) => seen.push(at));
    const got = await tool.run({ text: 'const x = 42;' }, ctxFor(root));
    assert.notEqual(got.isError, true, `失敗している: ${got.content}`);
    assert.deepEqual(seen, [{ path: 'src/a.ts', from: 1, to: 1, text: 'const x = 1;', replacement: 'const x = 42;' }]);
    // **保存していないことを、はっきり言う。**書けたと思われると、確かめない。
    assert.match(got.content, /保存はしていません/);
  });

  test('**範囲は、利用者が選んだ所。モデルには決めさせない**', async () => {
    const root = await place();
    const seen: Array<{ from: number; to: number }> = [];
    const tool = createReplaceSelectionTool(() => picked(), (at) => seen.push(at));
    // モデルが行を渡してきても、渡した範囲は使わない。
    await tool.run({ text: 'x', from: 99, to: 120, path: 'src/other.ts' } as never, ctxFor(root));
    assert.deepEqual(seen, [{ path: 'src/a.ts', from: 1, to: 1, text: 'const x = 1;', replacement: 'x' } as never]);
  });

  test('選んでいる所が無ければ、断って、何もしない', async () => {
    const root = await place();
    const seen: unknown[] = [];
    const tool = createReplaceSelectionTool(() => undefined, (at) => seen.push(at));
    const got = await tool.run({ text: 'x' }, ctxFor(root));
    assert.equal(got.isError, true);
    assert.match(got.content, /選んでいる所がありません/);
    // **代わりの道を言う。**断るだけだと、そこで止まる。
    assert.match(got.content, /edit_file/);
    assert.deepEqual(seen, []);
  });

  test('**受け手が無ければ、書き換えたことにしない**', async () => {
    // 端末の入口には画面が無い。「書き換えました」と言うと、嘘になる。
    const root = await place();
    const tool = createReplaceSelectionTool();
    const got = await tool.run({ text: 'x' }, ctxFor(root));
    assert.equal(got.isError, true);
    assert.match(got.content, /書き換える先がありません/);
  });

  test('**作業場の外は書き換えない**', async () => {
    const root = await place();
    const seen: unknown[] = [];
    const tool = createReplaceSelectionTool(() => picked('../よそ.ts'), (at) => seen.push(at));
    const got = await tool.run({ text: 'x' }, ctxFor(root));
    assert.equal(got.isError, true);
    assert.deepEqual(seen, []);
  });

  test('空の文は通す（選んだ所を消す、も指示）', async () => {
    const root = await place();
    const seen: Array<{ replacement: string }> = [];
    const tool = createReplaceSelectionTool(() => picked(), (at) => seen.push(at));
    const got = await tool.run({ text: '' }, ctxFor(root));
    assert.notEqual(got.isError, true, got.content);
    assert.equal(seen[0]?.replacement, '');
  });

  test('文字でなければ断る（対）', async () => {
    const root = await place();
    const tool = createReplaceSelectionTool(() => picked(), () => undefined);
    const got = await tool.run({ text: 42 } as never, ctxFor(root));
    assert.equal(got.isError, true);
  });
});

/** 一度だけ `replace_selection` を呼んで、そのあと終わる相手。 */
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
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'replace_selection', arguments: '{"text":"const x = 42;"}' } }] } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '直しました。\nTASK_DONE\n' } }] })}\n\n`);
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

describe('呼ばれた書き換えが、画面まで届く', () => {
  test('**選んで送ると、画面へ patch が流れる**', async () => {
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
        body: JSON.stringify({
          text: 'ここを 42 にして',
          editor: { path: 'src/a.ts', line: 1, selection: 'const x = 1;', selectionFrom: 1, selectionTo: 1 },
        }),
      });
      await until(() => events.some((e) => e.type === 'patch'), '画面へ patch が流れる', { timeoutMs: 30_000 });
      const got = events.find((e) => e.type === 'patch')!;
      assert.equal(got.path, 'src/a.ts');
      assert.equal(got.from, 1);
      assert.equal(got.to, 1);
      assert.equal(got.text, 'const x = 1;');
      assert.equal(got.replacement, 'const x = 42;');
    } finally {
      ac.abort();
      await s.stop();
      await fake.close();
    }
  });
});
