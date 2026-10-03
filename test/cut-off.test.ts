/**
 * 出力の上限で切れた返事を、答え終えたことにしない。
 *
 * 相手は上限で切れると `length` で終わる。その合図を orchestrator が捨てていたので、
 * ツールを使っていない返事は途中で切れていても「完了」になっていた。
 * 切れたら続きを求め、求められないなら切れたと言う。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './tmp.ts';
import { ProviderRegistry } from '../src/core/registry.ts';
import { ChatOrchestrator } from '../src/core/orchestrator.ts';
import { Agent, type AgentEvent } from '../src/agent/loop.ts';
import type {
  ChatProvider, FinishReason, ProviderChunk, ProviderMessage, ProviderRequest, ToolCall,
} from '../src/providers/contract.ts';
import type { Tool } from '../src/agent/tools/types.ts';

interface Reply { text?: string; calls?: ToolCall[]; finish: FinishReason }

/** 決めた順に返す相手。受け取った会話も記録する。 */
function scripted(replies: Reply[]) {
  const seen: ProviderMessage[][] = [];
  const provider: ChatProvider = {
    id: 'fake', locality: 'local',
    health: async () => ({ ok: true }),
    listModels: async () => [{ id: 'fake:m', providerId: 'fake', model: 'm', displayName: 'm', locality: 'local' }],
    async *chat(req: ProviderRequest): AsyncIterable<ProviderChunk> {
      seen.push(req.messages.map((m) => ({ ...m })));
      const r = replies[Math.min(seen.length - 1, replies.length - 1)]!;
      if (r.text) yield { type: 'text', delta: r.text };
      for (const call of r.calls ?? []) yield { type: 'toolCall', call };
      yield { type: 'done', finishReason: r.finish };
    },
  };
  return { provider, seen };
}

async function run(replies: Reply[], opts: { maxNudges?: number; tools?: Tool[] } = {}) {
  const { provider, seen } = scripted(replies);
  const registry = new ProviderRegistry();
  registry.register(provider);
  const agent = new Agent(new ChatOrchestrator(registry), {
    candidates: ['fake:m'], system: 'test', tools: opts.tools ?? [], root: await tempDir('aas-cut-'),
    maxTurns: 6, approve: async () => true,
    ...(opts.maxNudges !== undefined ? { maxNudges: opts.maxNudges } : {}),
  });
  const events: AgentEvent[] = [];
  for await (const ev of agent.run([{ role: 'user', content: '説明して' }], new AbortController().signal)) events.push(ev);
  return { events, end: events.at(-1), seen };
}

describe('出力の上限で切れた返事', () => {
  test('切れたら続きを求め、言い終えたら完了', async () => {
    const { events, end, seen } = await run([
      { text: '前半です。', finish: 'length' },
      { text: '後半です。', finish: 'stop' },
    ]);
    assert.equal(seen.length, 2, '続きを求めていない');
    assert.match(seen[1]!.at(-1)?.content ?? '', /上限で切れて/);
    assert.ok(events.some((e) => e.type === 'nudged'));
    assert.equal(end?.type, 'finished');
    if (end?.type === 'finished') assert.equal(end.reason, 'completed');
  });

  test('何度求めても切れるなら、完了ではなく切れたと言う', async () => {
    const { end, seen } = await run([{ text: '長い話の途中', finish: 'length' }], { maxNudges: 2 });
    assert.equal(seen.length, 3);
    assert.equal(end?.type, 'finished');
    if (end?.type === 'finished') {
      assert.equal(end.reason, 'noProgress');
      assert.match(end.detail ?? '', /上限で切れました/);
    }
  });

  test('押し戻しを切ってあれば、求めずに切れたと言う', async () => {
    const { end, seen } = await run([{ text: '途中', finish: 'length' }], { maxNudges: 0 });
    assert.equal(seen.length, 1);
    if (end?.type === 'finished') {
      assert.equal(end.reason, 'noProgress');
      assert.match(end.detail ?? '', /押し戻しは切ってあります/);
    } else assert.fail(`終わっていない: ${JSON.stringify(end)}`);
  });

  test('言い終えた返事は、そのまま完了（対）', async () => {
    const { end, seen } = await run([{ text: '答えです。', finish: 'stop' }]);
    assert.equal(seen.length, 1);
    if (end?.type === 'finished') assert.equal(end.reason, 'completed');
    else assert.fail(`終わっていない: ${JSON.stringify(end)}`);
  });

  test('上限で引数が切れた呼び出しには、小さく分けて呼び直すよう返す', async () => {
    const ran: unknown[] = [];
    const echo: Tool = {
      schema: { name: 'echo', description: 'echo', parameters: { type: 'object', properties: {} } },
      run: async (args) => { ran.push(args); return { content: 'ok' }; },
    };
    const broken: ToolCall = { id: 'c1', name: 'echo', args: { __raw: '{"text":"途中', __parseError: true } };
    const { seen } = await run([
      { calls: [broken], finish: 'length' },
      { text: 'TASK_DONE', finish: 'stop' },
    ], { tools: [echo] });
    assert.equal(ran.length, 0, '壊れた引数でツールを動かしている');
    const result = seen[1]!.find((m) => m.role === 'tool');
    assert.match(result?.content ?? '', /上限で、引数のJSONが途中で切れました/);
  });
});
