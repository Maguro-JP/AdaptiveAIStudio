/**
 * 本文が空のまま止まったら、「完了」と言わない。
 *
 * 考えごと（<think>）だけで予算を使い切ると、本文は空のまま返る。
 * それを完了と出していたので、18 分待って何も無いのに「完了・検証していません」と出た。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './tmp.ts';
import { startFakeServer } from './fake-server.ts';
import { OpenAiCompatibleProvider } from '../src/providers/openai-compatible.ts';
import { ProviderRegistry } from '../src/core/registry.ts';
import { ChatOrchestrator } from '../src/core/orchestrator.ts';
import { Agent, type AgentEvent } from '../src/agent/loop.ts';

async function run(text: string) {
  const server = await startFakeServer({ kind: 'stream', text });
  try {
    const registry = new ProviderRegistry();
    registry.register(new OpenAiCompatibleProvider({ id: 'local', baseUrl: server.baseUrl, locality: 'local' }));
    const agent = new Agent(new ChatOrchestrator(registry), {
      candidates: ['local:m'], system: 'test', tools: [], root: await tempDir('aas-empty-'), maxTurns: 2, approve: async () => true,
    });
    const events: AgentEvent[] = [];
    for await (const ev of agent.run([{ role: 'user', content: '1+1=' }], new AbortController().signal)) events.push(ev);
    return events.at(-1);
  } finally {
    await server.close();
  }
}

describe('空の返事', () => {
  test('本文が空なら、完了ではなく「動かなかった」', async () => {
    const end = await run('');
    assert.equal(end?.type, 'finished');
    if (end?.type === 'finished') {
      assert.equal(end.reason, 'noProgress');
      assert.match(end.detail ?? '', /空/);
    }
  });
  test('本文があれば完了（対）', async () => {
    const end = await run('2');
    assert.equal(end?.type, 'finished');
    if (end?.type === 'finished') assert.equal(end.reason, 'completed');
  });
});
