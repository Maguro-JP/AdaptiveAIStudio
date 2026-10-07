/**
 * やり残しの続きの不具合（64 回目の調査）。
 *
 * - 二度目の再開で段に割っている間（モデルへの問い合わせ）に取り消すと、段取りを立てずに抜けたのを「割れなかった」と読み、
 *   取り消した依頼を丸ごと走らせた
 *
 * 段取りの記録を書けないときの後始末・読み込み中のモデルの切り替え・降ろす間の手の押さえは、書けない記録・遅い読み込み・遅い降ろしの
 * モックが要るので、試験を書いていない（確かめていない）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tempDir } from './tmp.ts';

const { UiServer } = await import('../src/ui/server.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');
const { UnfinishedWork } = await import('../src/core/unfinished.ts');

/** 段に割る問い合わせだけ、合図があるまで返事を待たせる偽のモデル。ほかの問い合わせは数える */
async function slowSplitModel() {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let splitAsked = false;
  const others: string[] = [];
  const server = createServer((req, res) => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"data":[{"id":"m"}]}');
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      const p = JSON.parse(body || '{}') as { messages: { role: string; content: string }[] };
      const system = p.messages.find((m) => m.role === 'system')?.content ?? '';
      const say = (t: string) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      };
      if (system.includes('一歩ずつ実行できる段')) {
        splitAsked = true;
        await gate;
        return say('src/a.ts を読む\n型を string に直す');
      }
      others.push(p.messages.at(-1)?.content ?? '');
      say('はい。');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    release, others, splitAsked: () => splitAsked,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

test('**段に割っている間に取り消したやり残しは、丸ごとにも走らせない**', { timeout: 60_000 }, async () => {
  const state = await tempDir('aas-resume-cancel-state-');
  process.env.AAS_STATE_DIR = state;
  const root = await tempDir('aas-resume-cancel-root-');
  const fake = await slowSplitModel();
  const s = new UiServer({
    config: {
      ...DEFAULT_CONFIG,
      providers: [{ id: 'p', kind: 'openai-compatible', baseUrl: fake.baseUrl, locality: 'local', models: ['m'] }],
      runtime: { kind: 'ollama' },
      candidates: ['p:m'],
      agent: { root, approval: 'auto' },
      initiative: { enabled: false },
    } as typeof DEFAULT_CONFIG,
    port: 0,
  });
  const base = (await s.start()).replace(/\/$/, '');
  try {
    // 一度落ちた（attempts=1）やり残しを置き、時が来たことにする
    const store = new UnfinishedWork(join(state, 'unfinished.jsonl'));
    const { resolve: resolvePath } = await import('node:path');
    await store.add({ request: '取り消す依頼', why: 'maxTurns', note: '', root: resolvePath(root) });
    const item = (await store.list()).find((u) => u.request === '取り消す依頼')!;
    await store.bump(item.id, Date.now() - 60 * 60_000);
    assert.equal((await store.list()).find((u) => u.id === item.id)?.attempts, 1, '前提: 二度目の再開になる');

    const session = await s.session();
    const tick = s.idleTick(session);
    for (let i = 0; i < 200 && !fake.splitAsked(); i++) await new Promise((r) => setTimeout(r, 25));
    assert.ok(fake.splitAsked(), '前提: 段に割る問い合わせが来ていない');
    // 割っている間に取り消す
    const r = await fetch(`${base}/api/unfinished?id=${encodeURIComponent(item.id)}`, { method: 'DELETE' });
    assert.ok(r.ok);
    fake.release();
    await tick;
    await new Promise((r2) => setTimeout(r2, 500));
    assert.deepEqual(fake.others.filter((t) => t.includes('取り消す依頼')), [], '取り消した依頼を走らせた');
  } finally {
    await s.stop();
    await fake.close();
  }
});
