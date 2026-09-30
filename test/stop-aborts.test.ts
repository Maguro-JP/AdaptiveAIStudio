/**
 * 止めた（■）ときは、「止めた」で終える。
 *
 * 相手（プロバイダ）は止められると黙って終わる。返事の後で止められたかを見ていなかったので、途中までの文を普通の返事として
 * 「完了」にし、ツールを使った後なら「まだ TASK_DONE がありません」を会話の記録に積んでいた。
 * 確かめ（テスト）の途中で止めたときも、止めたせいで落ちた結果を「落ちた」と記録していた。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Agent, type AgentEvent } from '../src/agent/loop.ts';
import type { ChatOrchestrator } from '../src/core/orchestrator.ts';
import type { ProviderMessage } from '../src/providers/contract.ts';
import { runLoop, type LoopCheck, type LoopEvent } from '../src/harness/loop.ts';
import { readFileTool } from '../src/agent/tools/fs.ts';
import { tempDir } from './tmp.ts';

/** 決めた順に出来事を流し、途中で止める相手。止められたら、本物と同じく黙って終わる。 */
function stoppingOrchestrator(ac: AbortController, withToolFirst: boolean): ChatOrchestrator {
  let call = 0;
  return {
    async *run() {
      call += 1;
      if (withToolFirst && call === 1) {
        yield { type: 'toolCall', call: { id: 'c1', name: 'read_file', args: { path: 'a.txt' } } };
        yield { type: 'done', modelId: 'm' };
        return;
      }
      yield { type: 'text', delta: '途中' };
      ac.abort();
    },
  } as unknown as ChatOrchestrator;
}

async function runAgent(withToolFirst: boolean) {
  const ac = new AbortController();
  const root = await tempDir('aas-stop-');
  const agent = new Agent(stoppingOrchestrator(ac, withToolFirst), {
    candidates: ['x:m'], system: 's', tools: [readFileTool], root, maxTurns: 5, approve: async () => true,
  });
  const history: ProviderMessage[] = [{ role: 'user', content: 'q' }];
  const events: AgentEvent[] = [];
  for await (const ev of agent.run(history, ac.signal)) events.push(ev);
  return { events, history };
}

describe('返事の途中で止めたとき', () => {
  test('ツールを使わない問いでも、「完了」ではなく「止めた」で終える', async () => {
    const { events } = await runAgent(false);
    const last = events.at(-1) as { type: string; reason?: string };
    assert.deepEqual([last.type, last.reason], ['finished', 'aborted'], JSON.stringify(events));
  });

  test('ツールを使った後でも、促しを記録に積まずに「止めた」で終える', async () => {
    const { events, history } = await runAgent(true);
    const last = events.at(-1) as { type: string; reason?: string };
    assert.deepEqual([last.type, last.reason], ['finished', 'aborted'], JSON.stringify(events));
    assert.equal(events.some((e) => e.type === 'nudged'), false, '止めたのに促している');
    assert.equal(history.some((m) => m.role === 'user' && m.content.includes('TASK_DONE')), false, '促しが記録に残った');
  });
});

describe('確かめの途中で止めたとき', () => {
  test('止めたせいで落ちた結果を「落ちた」と言わず、止めたで終える', async () => {
    const ac = new AbortController();
    const gen = runLoop<LoopCheck>({ name: 't', maxRounds: 3 }, async () => {
      ac.abort(); // 確かめの最中に止められ、確かめは落ちた形で返る
      return { passed: false, digest: 'killed' };
    }, async () => undefined, ac.signal);
    const events: LoopEvent<LoopCheck>[] = [];
    let next = await gen.next();
    while (!next.done) { events.push(next.value); next = await gen.next(); }
    assert.equal(events.some((e) => e.type === 'checked'), false, `止めたのに確かめの結果として出した: ${JSON.stringify(events)}`);
    assert.equal(next.value.reason, 'aborted');
  });
});
