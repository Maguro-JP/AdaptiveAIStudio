/**
 * 働き方（docs/WORK-STYLE.md）のうち、コードで止めるもの。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './tmp.ts';
import { Agent, type AgentEvent } from '../src/agent/loop.ts';
import type { ChatOrchestrator, ChatEvent } from '../src/core/orchestrator.ts';
import type { ProviderMessage as Message } from '../src/providers/contract.ts';
import type { Tool } from '../src/agent/tools/types.ts';
import { claimsVerified, expandShortUtterance, isShortUtterance, UNBACKED_CLAIM_NUDGE } from '../src/agent/work-style.ts';

describe('確かめたという言い切り', () => {
  test('「テストが通りました」は言い切り', () => {
    assert.equal(claimsVerified('直しました。テストが通りました。'), true);
    assert.equal(claimsVerified('npm test が成功しました'), true);
  });
  test('「確かめていない」と添えていれば言い切りではない（対）', () => {
    assert.equal(claimsVerified('直しました。テストは確かめていません。'), false);
    assert.equal(claimsVerified('テストが通りませんでした'), false);
  });
  test('書いただけの報告は見ない（対）', () => {
    assert.equal(claimsVerified('src/a.ts を書き換えました。'), false);
  });
});

describe('短い一言', () => {
  test('対象の無い一言だけを短いと読む', () => {
    assert.equal(isShortUtterance('続けて'), true);
    assert.equal(isShortUtterance('それも。'), true);
    assert.equal(isShortUtterance('npm test'), false);
    assert.equal(isShortUtterance('src/a.ts を直して'), false);
  });
  test('前の依頼を添え、聞き返させない', () => {
    const got = expandShortUtterance('続けて', 'src/a.ts の型エラーを直して');
    assert.ok(got?.includes('src/a.ts の型エラーを直して'));
    assert.ok(got?.includes('聞き返さない'));
    assert.equal(expandShortUtterance('続けて', undefined), undefined);
    assert.equal(expandShortUtterance('README を書いて', '前'), undefined);
  });
});

function scripted(turns: ChatEvent[][], systems: string[] = []): ChatOrchestrator {
  let n = 0;
  return {
    async *run(req: { system?: string }) {
      systems.push(String(req?.system ?? ''));
      const evs = turns[Math.min(n, turns.length - 1)]!;
      n += 1;
      for (const ev of evs) yield ev;
    },
  } as unknown as ChatOrchestrator;
}

const tool = (name: string, isError = false): Tool => ({
  schema: { name, description: 'x', parameters: { type: 'object', properties: {} } } as never,
  run: async () => ({ content: isError ? 'ERROR' : 'ok', isError }),
});
const call = (id: string, name: string): ChatEvent => ({ type: 'toolCall', call: { id, name, args: {} } });
const done: ChatEvent = { type: 'done', modelId: 'm' };
const say = (t: string): ChatEvent => ({ type: 'text', delta: t });

async function run(turns: ChatEvent[][], tools: Tool[], history: Message[], systems?: string[]) {
  const agent = new Agent(scripted(turns, systems), {
    candidates: ['m'], system: 'test', tools, root: await tempDir('aas-work-style-'), maxTurns: 6, approve: async () => true,
  });
  const events: AgentEvent[] = [];
  for await (const ev of agent.run(history, new AbortController().signal)) events.push(ev);
  return events;
}

describe('作業ループでの確かめ', () => {
  test('コマンドが成功していないのに「通りました」なら一度押し戻す', async () => {
    const history: Message[] = [{ role: 'user', content: 'a.ts を直して' }];
    const events = await run([
      [call('c1', 'write_file'), done],
      [say('直しました。テストが通りました。\nTASK_DONE\n'), done],
      [say('直しました。テストは確かめていません。\nTASK_DONE\n'), done],
    ], [tool('write_file')], history);
    assert.ok(events.some((e) => e.type === 'nudged'), '押し戻していない');
    assert.ok(history.some((m) => m.role === 'user' && m.content === UNBACKED_CLAIM_NUDGE));
    const end = events.at(-1);
    assert.equal(end?.type === 'finished' && end.reason, 'completed');
  });

  test('run_command が成功していれば押し戻さない（対）', async () => {
    const events = await run([
      [call('c1', 'run_command'), done],
      [say('テストが通りました。\nTASK_DONE\n'), done],
    ], [tool('run_command')], [{ role: 'user', content: 'テストして' }]);
    assert.equal(events.some((e) => e.type === 'nudged'), false);
  });

  test('run_command が失敗しただけなら根拠にしない', async () => {
    const events = await run([
      [call('c1', 'run_command'), done],
      [say('テストが通りました。\nTASK_DONE\n'), done],
      [say('テストは確かめていません。\nTASK_DONE\n'), done],
    ], [tool('run_command', true)], [{ role: 'user', content: 'テストして' }]);
    assert.ok(events.some((e) => e.type === 'nudged'));
  });

  test('短い一言には、前の依頼をシステムプロンプトに添える', async () => {
    const systems: string[] = [];
    await run([[say('↩ 前の続き\nTASK_DONE\n'), done]], [tool('noop')], [
      { role: 'user', content: 'README の誤字を直して' },
      { role: 'assistant', content: '途中です' },
      { role: 'user', content: '続けて' },
    ], systems);
    assert.ok(systems[0]?.includes('README の誤字を直して'), systems[0]);
  });
});
