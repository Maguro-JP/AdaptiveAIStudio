/**
 * ■ で止めたら、順番待ちの依頼も取り消す（DECISIONS 10-10、98 回目の調査）。
 *
 * 止めるのは動いている依頼と承認待ちだけだったので、止めた依頼の終わりで順番待ちの次が「続けます」で走り出していた。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { until } from './until.ts';
import { startFakeServer } from './fake-server.ts';

const dir = await tempDir('aas-abort-queue-');
process.env.AAS_HOME = dir;
process.env.AAS_STATE_DIR = join(dir, 'state');
const { UiServer } = await import('../src/ui/server.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');

test('止めたら、順番待ちの依頼は走らない', async () => {
  const fake = await startFakeServer({ kind: 'echo', delayFor: () => 1500 });
  const server = new UiServer({
    port: 0,
    config: {
      ...DEFAULT_CONFIG,
      providers: [{ id: 'local', kind: 'openai-compatible', baseUrl: fake.baseUrl, locality: 'local', models: ['m'] }],
      candidates: ['local:m'],
      runtime: { kind: 'ollama' },
      agent: { root: dir, approval: 'auto' },
      initiative: { enabled: false },
    } as typeof DEFAULT_CONFIG,
  });
  const base = (await server.start()).replace(/\/$/, '');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = async (r: Response): Promise<any> => r.json();
  const post = (p: string, body?: unknown) => fetch(base + p, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
  });
  try {
    const a = await json(await post('/api/send', { text: 'A の依頼' }));
    assert.equal(a.accepted, true, JSON.stringify(a));
    const b = await json(await post('/api/send', { text: 'B の依頼' }));
    assert.equal(typeof b.queued, 'number', `B が積まれない（この試験の前提が崩れた）: ${JSON.stringify(b)}`);
    await post('/api/abort');
    await until(async () => {
      const c = await json(await fetch(`${base}/api/conversations`));
      return (c.runningAll as string[]).length === 0;
    }, 'A が止まる', { timeoutMs: 10_000, everyMs: 50 });
    await new Promise((r) => setTimeout(r, 800));
    const m = await json(await fetch(`${base}/api/conversations/messages?id=${a.conversationId}`));
    const asked = (m.messages as { role: string; content: string }[]).filter((x) => x.role === 'user').map((x) => x.content);
    assert.ok(!asked.some((t) => t.includes('B の依頼')), `止めたのに順番待ちが走った: ${asked.join(' / ')}`);
  } finally {
    await server.stop();
    await fake.close();
  }
});
