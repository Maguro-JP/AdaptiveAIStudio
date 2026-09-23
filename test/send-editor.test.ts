/**
 * 画面から送った依頼に、いま開いている所が乗るか。
 *
 * **形にする所（`editor-here.ts`）だけ試験しても、繋がっていなければ使えない。**
 * 送る口（`/api/send`）で受け取り、モデルへ渡る一言に入るところまで見る。
 *
 * ここは「在ること」ではなく「すること」で見る。偽のモデルへ届いた文を読む。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { until } from './until.ts';

process.env.AAS_STATE_DIR = await tempDir('aas-send-editor-');
const { UiServer } = await import('../src/ui/server.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');

/** 届いた「最後の一言」を控えて、短く答える相手。 */
async function fakeModel(seen: string[]) {
  const server = createServer((req, res) => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"data":[{"id":"m"}]}');
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const p = JSON.parse(body || '{}') as { messages: { role: string; content: string }[] };
      seen.push(p.messages.at(-1)?.content ?? '');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '見ました。\nTASK_DONE\n' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
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

async function serve(seen: string[]) {
  const root = await tempDir('aas-send-editor-root-');
  await writeFile(join(root, 'a.ts'), 'export const x = 1;\n');
  const fake = await fakeModel(seen);
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
  return { base, root, stop: async () => { await s.stop(); await fake.close(); } };
}

describe('送った依頼に、いま開いている所が乗る', () => {
  test('**名前と行と選んでいる字が、モデルへ渡る一言に入る**', async () => {
    const seen: string[] = [];
    const { base, stop } = await serve(seen);
    try {
      const r = await fetch(`${base}/api/send`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: 'これを直して',
          editor: { path: 'a.ts', line: 1, selection: 'export const x = 1;', selectionFrom: 1, selectionTo: 1 },
        }),
      });
      assert.equal(r.status, 202, await r.text());
      await until(() => seen.length > 0, 'モデルへ届く');
      const asked = seen[0]!;
      assert.match(asked, /【いま開いているファイル】a\.ts（1 行目）/, `開いている所が渡っていない: ${asked}`);
      assert.match(asked, /【選んでいる所】1〜1 行目/);
      assert.match(asked, /export const x = 1;/);
      // **依頼は末尾に置く。**前に中身を積むので、指示が埋もれないこと。
      assert.ok(asked.trimEnd().endsWith('これを直して'), `依頼が末尾に無い: ${asked}`);
    } finally { await stop(); }
  });

  /**
   * **差し込んだ塊を、利用者の言葉として判じない。**
   *
   * 指摘の判定（`displeasure`）は「利用者の言葉」を丸ごとモデルへ渡す。
   * 差し込んだ塊まで渡すと、**選んだコードを指摘として覚える**。
   * 画面で押して 1 ターン送ったときに、実際にそう渡っていた。
   */
  test('**指摘の判定には、打った分だけを渡す**', async () => {
    const seen: string[] = [];
    const { base, stop } = await serve(seen);
    try {
      await fetch(`${base}/api/send`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: 'これを直して',
          editor: { path: 'a.ts', line: 1, selection: 'export const x = 1;', selectionFrom: 1, selectionTo: 1 },
        }),
      });
      // 判定は依頼の後ろで走る。判定の問いが来るまで待つ。
      await until(() => seen.some((t) => t.includes('指摘・不満・注意')), '判定が走る', { timeoutMs: 20_000 });
      const judged = seen.find((t) => t.includes('指摘・不満・注意'))!;
      assert.match(judged, /利用者の言葉: これを直して/, `判定に渡す言葉が違う: ${judged.slice(0, 300)}`);
      assert.ok(!judged.includes('いま開いているファイル'), `差し込んだ塊まで判じている: ${judged.slice(0, 300)}`);
      assert.ok(!judged.includes('export const x = 1;'), `選んだコードまで判じている: ${judged.slice(0, 300)}`);
    } finally { await stop(); }
  });

  test('開いていなければ、何も足さない（対）', async () => {
    const seen: string[] = [];
    const { base, stop } = await serve(seen);
    try {
      await fetch(`${base}/api/send`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'ふつうの依頼' }),
      });
      await until(() => seen.length > 0, 'モデルへ届く');
      assert.equal(seen[0], 'ふつうの依頼', `余分なものが足されている: ${seen[0]}`);
    } finally { await stop(); }
  });

  test('よその道を渡されても、依頼そのものは通す', async () => {
    const seen: string[] = [];
    const { base, stop } = await serve(seen);
    try {
      const r = await fetch(`${base}/api/send`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '通るはず', editor: { path: '/etc/passwd', selection: 'root:x:0:0' } }),
      });
      assert.equal(r.status, 202, await r.text());
      await until(() => seen.length > 0, 'モデルへ届く');
      assert.equal(seen[0], '通るはず', `よその道が渡っている: ${seen[0]}`);
    } finally { await stop(); }
  });
});
