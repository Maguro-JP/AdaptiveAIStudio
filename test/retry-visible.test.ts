/**
 * やり直しは黙ってしない。何回目か、何秒経っていたかを流れに出す。
 *
 * 「337 秒で落ちた」とだけ言われても、10 秒 × 3 回だったのか、
 * 一回で 300 秒だったのかが分からない。内訳が無いと切り分けられない。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './tmp.ts';
import { startFakeServer } from './fake-server.ts';
import { OpenAiCompatibleProvider } from '../src/providers/openai-compatible.ts';
import { ProviderRegistry } from '../src/core/registry.ts';
import { ChatOrchestrator } from '../src/core/orchestrator.ts';
import { Agent, type AgentEvent } from '../src/agent/loop.ts';

describe('やり直しが見える', () => {
  test('雲の口が時間切れを繰り返すと、何回目かと経過秒が出て、落ちた理由にも秒が付く', async () => {
    const server = await startFakeServer({ kind: 'hang' });
    const root = await tempDir('aas-retry-');
    try {
      const registry = new ProviderRegistry();
      registry.register(new OpenAiCompatibleProvider({
        id: 'cloud', baseUrl: server.baseUrl, locality: 'cloud', connectTimeoutMs: 50,
      }));
      const agent = new Agent(new ChatOrchestrator(registry), {
        candidates: ['cloud:m'], system: 'test', tools: [], root, maxTurns: 1,
        approve: async () => true,
      });
      const events: AgentEvent[] = [];
      for await (const ev of agent.run([{ role: 'user', content: 'hi' }], new AbortController().signal)) events.push(ev);

      const retries = events.filter((e): e is Extract<AgentEvent, { type: 'retry' }> => e.type === 'retry');
      assert.deepEqual(retries.map((r) => r.attempt), [1, 2], 'やり直しの回数が見えない');
      assert.ok(retries.every((r) => r.modelId === 'cloud:m'));
      assert.ok(retries[1]!.elapsedMs >= retries[0]!.elapsedMs, '経過が進んでいない');
      const end = events.at(-1);
      assert.equal(end?.type, 'finished');
      if (end?.type === 'finished') {
        assert.equal(end.reason, 'failed');
        assert.match(end.detail ?? '', /timeout: /);
        assert.match(end.detail ?? '', /（\d+ 秒）$/, `落ちた理由に秒が無い: ${end.detail}`);
      }
      assert.equal(server.requests, 3);
    } finally {
      await server.close();
    }
  });

  test('一度で通れば、やり直しは出ない（対）', async () => {
    const server = await startFakeServer({ kind: 'stream', text: 'はい' });
    const root = await tempDir('aas-retry-');
    try {
      const registry = new ProviderRegistry();
      registry.register(new OpenAiCompatibleProvider({ id: 'cloud', baseUrl: server.baseUrl, locality: 'cloud' }));
      const agent = new Agent(new ChatOrchestrator(registry), {
        candidates: ['cloud:m'], system: 'test', tools: [], root, maxTurns: 1, approve: async () => true,
      });
      const events: AgentEvent[] = [];
      for await (const ev of agent.run([{ role: 'user', content: 'hi' }], new AbortController().signal)) events.push(ev);
      assert.equal(events.filter((e) => e.type === 'retry').length, 0);
      assert.equal(events.at(-1)?.type, 'finished');
    } finally {
      await server.close();
    }
  });
});
