import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { tempDir } from './tmp.ts';

// 暇なときの考えごとで、外を読む（fetch_url）のを、承認の設定に従わせる
async function thinkOnce(approval: 'ask' | 'autoEdit'): Promise<string[]> {
  const home = await tempDir('aas-think144-');
  process.env.AAS_HOME = home;
  process.env.AAS_STATE_DIR = join(home, 'state');
  const hits: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (u: unknown, i?: RequestInit) => {
    const s = String((u as { url?: string })?.url ?? u);
    if (s.includes('example.com')) { hits.push(s); return new Response('hello', { status: 200, headers: { 'content-type': 'text/plain' } }); }
    return real(u as string, i);
  }) as typeof fetch;
  const { startFakeServer } = await import('./fake-server.ts');
  const { Session } = await import('../src/core/session.ts');
  const { DEFAULT_CONFIG } = await import('../src/config.ts');
  const { BUILTIN_IDLE_MODES } = await import('../src/harness/idle-modes.ts');
  const fake = await startFakeServer({ kind: 'toolcall', name: 'fetch_url', args: { url: 'https://example.com/x', purpose: 'p' }, then: 'done' } as never);
  const work = join(home, 'w');
  await mkdir(work, { recursive: true });
  const config = {
    ...DEFAULT_CONFIG,
    providers: [{ id: 'p', kind: 'openai-compatible', baseUrl: fake.baseUrl, locality: 'local', models: ['m'] }],
    candidates: ['p:m'], runtime: { kind: 'ollama' },
    network: { allowedHosts: ['example.com'], inspector: { enabled: false } },
    agent: { root: work, approval },
  } as never;
  const s = await Session.create(config, { approve: () => Promise.resolve(false) } as never);
  try {
    const mode = BUILTIN_IDLE_MODES.find((m: { id: string }) => m.id === 'briefing');
    (s as unknown as { nextThought: () => Promise<unknown> }).nextThought = async () => ({ mode });
    for await (const _ of s.think()) { /* 流すだけ */ }
  } finally {
    await s.close();
    await fake.close();
    globalThis.fetch = real;
  }
  return hits;
}

test('「尋ねる」設定では、考えごとでも尋ねずに外を読まない', async () => {
  assert.deepEqual(await thinkOnce('ask'), []);
});

test('既定（autoEdit）では、考えごとは今までどおり外を読める', async () => {
  assert.deepEqual(await thinkOnce('autoEdit'), ['https://example.com/x']);
});
