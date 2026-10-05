/**
 * 作業のループの抜け（34 回目の調査、DECISIONS 10-05）。
 *
 * - 名前があるだけのただの JSON（package.json の例など）を、本文から呼び出しとして拾わない（ツールに無い名前は本文のまま）
 * - 終わりの合図は、流れの区切れ方で変わらない（行の途中に書いた TASK_DONE は合図ではない）
 * - 最後のツールの最中に止めたら、「止めた」で終わる（同じ手の繰り返し・回数切れにしない）
 * - 引数が物でないときはツールを動かさない（`{}` で動かすと、本当の誤りがモデルに届かない）
 * - 書き始めた後に落ちても、見せた文は履歴に残す
 * - ツールが投げても、結果の無い呼び出しを残さない
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './tmp.ts';
import { ProviderRegistry } from '../src/core/registry.ts';
import { ChatOrchestrator } from '../src/core/orchestrator.ts';
import { Agent, type AgentEvent } from '../src/agent/loop.ts';
import { DoneMark } from '../src/agent/done.ts';
import { ProviderError } from '../src/providers/errors.ts';
import type {
  ChatProvider, FinishReason, ProviderChunk, ProviderMessage, ProviderRequest, ToolCall,
} from '../src/providers/contract.ts';
import type { Tool } from '../src/agent/tools/types.ts';

interface Reply { text?: string; calls?: ToolCall[]; finish: FinishReason; failAfterText?: boolean }

function scripted(replies: Reply[]) {
  let n = 0;
  const provider: ChatProvider = {
    id: 'fake', locality: 'cloud',
    health: async () => ({ ok: true }),
    listModels: async () => [{ id: 'fake:m', providerId: 'fake', model: 'm', displayName: 'm', locality: 'cloud' }],
    async *chat(_req: ProviderRequest): AsyncIterable<ProviderChunk> {
      const r = replies[Math.min(n, replies.length - 1)]!;
      n += 1;
      if (r.text) yield { type: 'text', delta: r.text };
      if (r.failAfterText) throw new ProviderError({ kind: 'unavailable', providerId: 'fake', message: '途中で落ちました' });
      for (const call of r.calls ?? []) yield { type: 'toolCall', call };
      yield { type: 'done', finishReason: r.finish };
    },
  };
  return provider;
}

async function run(replies: Reply[], tools: Tool[], opts: { maxTurns?: number; controller?: AbortController } = {}) {
  const registry = new ProviderRegistry();
  registry.register(scripted(replies));
  const agent = new Agent(new ChatOrchestrator(registry), {
    candidates: ['fake:m'], system: 'test', tools, root: await tempDir('aas-loop-gaps-'),
    maxTurns: opts.maxTurns ?? 6, approve: async () => true, maxNudges: 0,
  });
  const history: ProviderMessage[] = [{ role: 'user', content: 'やって' }];
  const events: AgentEvent[] = [];
  const signal = (opts.controller ?? new AbortController()).signal;
  for await (const ev of agent.run(history, signal)) events.push(ev);
  return { events, end: events.at(-1) as Extract<AgentEvent, { type: 'finished' }>, history };
}

function tool(name: string, runFn: Tool['run']): Tool {
  return { schema: { name, description: name, parameters: { type: 'object', properties: {} } }, run: runFn };
}

describe('作業のループ', () => {
  test('ツールに無い名前のただの JSON は、本文のまま見せる（呼び出しとして拾わない）', async () => {
    const answer = '例です:\n```json\n{"name":"demo","version":"1.0.0"}\n```\n';
    const { events, end } = await run([{ text: answer, finish: 'stop' }], [tool('read_file', async () => ({ content: 'x' }))]);
    assert.equal(events.some((e) => e.type === 'toolStart'), false, 'ただの JSON を呼び出しとして動かした');
    const shown = events.filter((e) => e.type === 'thinking').map((e) => (e as { delta: string }).delta).join('');
    assert.match(shown, /"version":"1.0.0"/, '答えの中の JSON を消した');
    assert.equal(end.reason, 'completed');
  });

  test('終わりの合図は、流れの区切れ方で変わらない', () => {
    const whole = new DoneMark();
    const a = whole.push('終わったら TASK_DONE\n');
    const wholeEnd = whole.end();
    const split = new DoneMark();
    const b = split.push('終わったら ') + split.push('TASK_DONE\n');
    const splitEnd = split.end();
    assert.equal(wholeEnd.done, false);
    assert.equal(splitEnd.done, wholeEnd.done, '区切れ方で合図の判定が変わった');
    assert.equal(b + splitEnd.text, a + wholeEnd.text, '区切れ方で見せる文が変わった');
    // 行だけの合図は、区切れても合図（対）
    const own = new DoneMark();
    own.push('済みました\n'); own.push('TASK_'); own.push('DONE\n');
    assert.equal(own.end().done, true);
  });

  test('本文に書いた呼び出しの直後の行の合図は、画面にも履歴にも出さない', async () => {
    const work = tool('work', async () => ({ content: 'ok' }));
    const { events, history } = await run([
      { text: 'これから動かします <tool_call>{"name":"work","arguments":{}}</tool_call>\nTASK_DONE\n', finish: 'stop' },
      { text: 'TASK_DONE\n', finish: 'stop' },
    ], [work]);
    assert.ok(events.some((e) => e.type === 'toolStart'), '本文の呼び出しを拾っていない');
    const shown = events.filter((e) => e.type === 'thinking').map((e) => (e as { delta: string }).delta).join('');
    assert.doesNotMatch(shown, /TASK_DONE/, `合図を画面に出した: ${JSON.stringify(shown)}`);
    assert.equal(history.some((m) => m.role === 'assistant' && m.content.includes('TASK_DONE')), false, '合図を履歴に残した');
  });

  test('最後のツールの最中に止めたら、「止めた」で終わる', async () => {
    const controller = new AbortController();
    const stopper = tool('work', async () => { controller.abort(); return { content: 'done' }; });
    const { end } = await run(
      [{ calls: [{ id: 'c1', name: 'work', args: {} }], finish: 'toolCalls' }],
      [stopper], { maxTurns: 1, controller },
    );
    assert.equal(end.reason, 'aborted', `止めたのに ${end.reason} で終わった`);
  });

  test('引数が物でないときは、ツールを動かさずに誤りを返す', async () => {
    let ran = 0;
    const reader = tool('read_file', async () => { ran += 1; return { content: 'x' }; });
    const { history } = await run([
      { calls: [{ id: 'c1', name: 'read_file', args: '{"path":"a"}' as unknown as Record<string, unknown> }], finish: 'toolCalls' },
      { text: 'TASK_DONE\n', finish: 'stop' },
    ], [reader]);
    assert.equal(ran, 0, '物でない引数のまま動かした');
    const result = history.find((m) => m.role === 'tool');
    assert.match(result?.content ?? '', /^ERROR: .*オブジェクト/, `誤りを返していない: ${result?.content}`);
  });

  test('書き始めた後に落ちても、見せた文は履歴に残す', async () => {
    const { end, history } = await run([{ text: '途中まで書いた文', finish: 'stop', failAfterText: true }], []);
    assert.equal(end.reason, 'failed');
    assert.ok(history.some((m) => m.role === 'assistant' && m.content.includes('途中まで書いた文')), '見せた文が履歴に無い');
  });

  test('ツールが投げても、結果の無い呼び出しを残さない', async () => {
    const thrower = tool('boom', async () => { throw new Error('壊れた'); });
    const { history } = await run([
      { calls: [{ id: 'c1', name: 'boom', args: {} }], finish: 'toolCalls' },
      { text: 'TASK_DONE\n', finish: 'stop' },
    ], [thrower]);
    const result = history.find((m) => m.role === 'tool' && m.toolCallId === 'c1');
    assert.ok(result, '結果の無い呼び出しが残った');
    assert.match(result.content, /^ERROR: .*壊れた/);
  });
});
