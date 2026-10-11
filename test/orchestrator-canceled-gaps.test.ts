/**
 * 利用者が止めていないのに、相手が「打ち切った」と返したとき（95 回目の調査）。
 *
 * 打ち切りは、利用者が止めたときにだけ黙って終わってよい。中の時計などで打ち切られたときも黙って終わっていたので、
 * 呼ぶ側は本文も失敗も受け取らず、「返事が空でした（モデルが本文を書かずに止まりました）」とモデルのせいにしていた。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderRegistry } from '../src/core/registry.ts';
import { ChatOrchestrator, type ChatEvent } from '../src/core/orchestrator.ts';
import { ProviderError } from '../src/providers/errors.ts';

function cancelingProvider() {
  return {
    id: 'p', locality: 'cloud' as const,
    async health() { return { ok: true } as never; },
    async listModels() { return []; },
    // eslint-disable-next-line require-yield
    async *chat(): AsyncGenerator<never> { throw new ProviderError({ kind: 'canceled', providerId: 'p', message: '中で打ち切りました' }); },
  };
}

async function drain(signal: AbortSignal): Promise<ChatEvent[]> {
  const registry = new ProviderRegistry();
  registry.register(cancelingProvider() as never);
  const out: ChatEvent[] = [];
  for await (const ev of new ChatOrchestrator(registry).run({ candidates: ['p:m'], messages: [{ role: 'user', content: 'hi' }] }, signal)) out.push(ev);
  return out;
}

test('利用者が止めていない打ち切りは、失敗として返す', async () => {
  const events = await drain(new AbortController().signal);
  assert.ok(events.some((e) => e.type === 'failed'), JSON.stringify(events));
});

test('利用者が止めたなら、これまでどおり黙って終わる（対）', async () => {
  const ac = new AbortController();
  ac.abort();
  const events = await drain(ac.signal);
  assert.equal(events.some((e) => e.type === 'failed'), false, JSON.stringify(events));
});
