/**
 * 78 回目の不具合調査（人が押さずに動く所）の分。
 *
 * - 見回り以外の考えごとでも、出力の上限で切れた PROPOSAL を提案にしない
 * - やり残しの再開の時刻が、進んでいた時計で先すぎる時刻になっていても、今として見る
 *
 * UPKEEP を ■ で止めた回の数え方・読めないやり残しの後回し・端末の `/think` の断り・端末の idleSeconds の下限は、
 * ここでは確かめていない（差し込む口が無い・端末の出力を拾う形が要る）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { tempDir } from './tmp.ts';
import { UnfinishedWork, BACKOFF_MS } from '../src/core/unfinished.ts';

const home = await tempDir('aas-autonomy-gaps-');
process.env.AAS_HOME = home;
process.env.AAS_STATE_DIR = join(home, 'state');
const { Session } = await import('../src/core/session.ts');
type ThinkEvent = import('../src/core/session.ts').ThinkEvent;
const { DEFAULT_CONFIG } = await import('../src/config.ts');

/** いつも出力の上限（length）で切れた返事を返す相手。切れ目は action の行の途中。 */
async function cutServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const text = 'PROPOSAL\ntitle: 設定の読み込みを直す\nrationale: 壊れた設定で黙って動く\naction: src/config.ts の loadConfig を';
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (b) => { body += b; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return { baseUrl: `http://127.0.0.1:${port}/v1`, close: () => new Promise((r) => server.close(() => r())) };
}

describe('考えごと', () => {
  test('**見回り以外でも、出力の上限で切れた PROPOSAL は提案にしない**', async () => {
    const fake = await cutServer();
    const work = join(home, 'cut');
    await mkdir(work, { recursive: true });
    const session = await Session.create({
      ...DEFAULT_CONFIG,
      providers: [{ id: 'p', kind: 'openai-compatible', baseUrl: fake.baseUrl, locality: 'local', models: ['m'] }],
      candidates: ['p:m'],
      runtime: { kind: 'ollama' },
      agent: { root: work, approval: 'auto' },
    } as typeof DEFAULT_CONFIG, { approve: () => Promise.resolve(true) });
    try {
      const seen: ThinkEvent[] = [];
      for await (const e of session.think()) seen.push(e);
      const chose = seen.find((e) => e.type === 'chose') as { codename?: string; modeId?: string } | undefined;
      assert.ok(chose, `考えごとを選んでいない（この試験の前提が崩れた）: ${JSON.stringify(seen)}`);
      assert.ok(!seen.some((e) => e.type === 'proposal'), `切れた PROPOSAL を提案にした: ${JSON.stringify(seen.filter((e) => e.type === 'proposal'))}`);
      assert.ok(seen.some((e) => e.type === 'failed' && /上限/.test(e.reason)), JSON.stringify(seen));
    } finally {
      await session.close();
      await fake.close();
    }
  });
});

describe('やり残しの再開', () => {
  test('**進んでいた時計で書いた先すぎる時刻は、今として見る**', async () => {
    const dir = await tempDir('aas-unfinished-clock-');
    const w = new UnfinishedWork(join(dir, 'unfinished.jsonl'));
    const T = Date.UTC(2026, 9, 7, 0, 0, 0);
    // 1 日進んだ時計で足した
    await w.add({ request: 'x', why: 'failed', note: '' }, T + 86_400_000);
    // 時計が戻った後、待ちの上限を過ぎた
    const got = await w.due(T + BACKOFF_MS.at(-1)! + 60_000);
    assert.ok(got, '戻った時計の分だけ再開が遅れている');
  });

  test('待ちの間は、これまでどおり返さない（対）', async () => {
    const dir = await tempDir('aas-unfinished-clock-');
    const w = new UnfinishedWork(join(dir, 'unfinished.jsonl'));
    const T = Date.UTC(2026, 9, 7, 0, 0, 0);
    await w.add({ request: 'x', why: 'failed', note: '' }, T);
    assert.equal(await w.due(T + 1_000), undefined);
  });
});
