/**
 * エージェントループの検証。
 * ツール呼び出しを返す偽のOpenAI互換サーバを相手に、
 * 「読む → 書く → 報告する」が一周するかを確認する。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { writeFile, readFile } from 'node:fs/promises';
import { tempDir } from './tmp.ts';
import { join } from 'node:path';
import { OpenAiCompatibleProvider } from '../src/providers/openai-compatible.ts';
import { ProviderRegistry } from '../src/core/registry.ts';
import { ChatOrchestrator } from '../src/core/orchestrator.ts';
import { Agent, type AgentEvent } from '../src/agent/loop.ts';
import { readFileTool, writeFileTool } from '../src/agent/tools/fs.ts';
import type { ProviderMessage } from '../src/providers/contract.ts';

type Scripted =
  | { text: string }
  | { tool: string; args: unknown };

/** 台本どおりに応答する偽モデル。1リクエストごとに次の手へ進む。 */
async function scriptedServer(script: Scripted[]) {
  let turn = 0;
  const seen: unknown[] = [];
  const server = createServer((req, res) => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"data":[{"id":"m"}]}');
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push(JSON.parse(body || '{}'));
      const step = script[Math.min(turn, script.length - 1)]!;
      turn += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if ('text' in step) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: step.text } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      } else {
        // 引数を2つに割って送り、分割組み立てを検証する
        const argstr = JSON.stringify(step.args);
        const half = Math.ceil(argstr.length / 2);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `c${turn}`, function: { name: step.tool, arguments: argstr.slice(0, half) } }] } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: argstr.slice(half) } }] } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    seen,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

async function runAgent(script: Scripted[], opts: { approve?: () => Promise<boolean> } = {}) {
  const server = await scriptedServer(script);
  const root = await tempDir('aas-agent-');
  await writeFile(join(root, 'app.ts'), 'export const answer = 41;\n');
  try {
    const registry = new ProviderRegistry();
    registry.register(new OpenAiCompatibleProvider({
      id: 'local', baseUrl: server.baseUrl, locality: 'local',
    }));
    const agent = new Agent(new ChatOrchestrator(registry), {
      candidates: ['local:m'],
      system: 'test',
      tools: [readFileTool, writeFileTool],
      root,
      maxTurns: 10,
      approve: opts.approve ?? (async () => true),
    });
    const history: ProviderMessage[] = [{ role: 'user', content: '42に直して' }];
    const events: AgentEvent[] = [];
    for await (const ev of agent.run(history, new AbortController().signal)) events.push(ev);
    return { events, root, history, seen: server.seen };
  } finally {
    await server.close();
  }
}

describe('エージェントループ', () => {
  test('読む→書く→報告 が一周し、ファイルが実際に変わる', async () => {
    const { events, root } = await runAgent([
      { tool: 'read_file', args: { path: 'app.ts' } },
      { tool: 'write_file', args: { path: 'app.ts', content: 'export const answer = 42;\n' } },
      { text: '42に修正しました。' },
    ]);

    const names = events.filter((e) => e.type === 'toolStart').map((e) => e.call.name);
    assert.deepEqual(names, ['read_file', 'write_file']);

    assert.equal(await readFile(join(root, 'app.ts'), 'utf8'), 'export const answer = 42;\n');

    const finished = events.at(-1);
    assert.equal(finished?.type, 'finished');
    assert.equal(finished.reason, 'completed');
  });

  test('本文に書かれた呼び出しでも道具が動き、生の JSON は表に出ない', async () => {
    // 1B級のモデルは、呼び出しの枠を使わず本文へ書いてしまうことがある。
    const { events, root } = await runAgent([
      { text: '直します。<tool_call>{"name":"write_file","arguments":'
        + '{"path":"app.ts","content":"export const answer = 42;\n"}}</tool_call>' },
      { text: '直しました。' },
    ]);

    const names = events.filter((e) => e.type === 'toolStart').map((e) => e.call.name);
    assert.deepEqual(names, ['write_file'], '本文の呼び出しが道具として動いていない');
    assert.equal(await readFile(join(root, 'app.ts'), 'utf8'), 'export const answer = 42;\n');

    const shown = events.filter((e) => e.type === 'thinking').map((e) => e.delta).join('');
    assert.equal(shown.includes('tool_call'), false, `生の JSON が画面へ出ている: ${shown}`);
    assert.equal(shown.includes('{'), false, `生の JSON が画面へ出ている: ${shown}`);
    assert.ok(shown.includes('直します。'), '本文まで消してしまっている');

    assert.ok(events.some((e) => e.type === 'salvaged' && e.name === 'write_file'),
      '拾ったことを黙っている');
  });

  test('呼び出しでない JSON は、そのまま本文として見せる', async () => {
    const { events } = await runAgent([{ text: '既定は {"temperature": 0.2} です。' }]);
    const shown = events.filter((e) => e.type === 'thinking').map((e) => e.delta).join('');
    assert.equal(shown, '既定は {"temperature": 0.2} です。');
    assert.equal(events.filter((e) => e.type === 'toolStart').length, 0);
  });

  test('ツールを呼ばなければ即完了する', async () => {
    const { events } = await runAgent([{ text: 'すでに正しいので変更不要です。' }]);
    assert.equal(events.filter((e) => e.type === 'toolStart').length, 0);
    const last = events.at(-1);
    assert.equal(last?.type, 'finished');
    assert.equal(last.reason, 'completed');
  });

  test('承認を拒否するとファイルは変わらず、モデルにその旨が返る', async () => {
    const { events, root } = await runAgent([
      { tool: 'write_file', args: { path: 'app.ts', content: 'destroyed' } },
      { text: '拒否されたので中止します。' },
    ], { approve: async () => false });

    assert.equal(await readFile(join(root, 'app.ts'), 'utf8'), 'export const answer = 41;\n');
    const end = events.find((e) => e.type === 'toolEnd');
    assert.equal(end?.isError, true);
    assert.match(end.result, /拒否/);
  });

  test('未知のツールはエラーとして返し、ループは止まらない', async () => {
    const { events } = await runAgent([
      { tool: 'delete_everything', args: {} },
      { text: '使えないツールでした。' },
    ]);
    const end = events.find((e) => e.type === 'toolEnd');
    assert.equal(end?.isError, true);
    assert.match(end.result, /未知のツール/);
    const last = events.at(-1);
    assert.equal(last?.type, 'finished');
    assert.equal(last.reason, 'completed');
  });

  test('同じ操作を3回繰り返すと堂々巡りとして止める', async () => {
    const { events } = await runAgent([
      { tool: 'read_file', args: { path: 'app.ts' } }, // 以降ずっと同じ手を返す
    ]);
    const finished = events.at(-1);
    assert.equal(finished?.type, 'finished');
    assert.equal(finished.reason, 'noProgress');
  });

  test('ツール定義がモデルへ渡り、ツール結果が履歴に積まれる', async () => {
    const { seen, history } = await runAgent([
      { tool: 'read_file', args: { path: 'app.ts' } },
      { text: '確認しました。' },
    ]);
    const first = seen[0] as { tools?: Array<{ function: { name: string } }> };
    assert.ok(first.tools?.some((t) => t.function.name === 'read_file'));

    const second = seen[1] as { messages: Array<{ role: string; tool_call_id?: string }> };
    assert.ok(second.messages.some((m) => m.role === 'tool' && m.tool_call_id));

    assert.ok(history.some((m) => m.role === 'tool'));
  });
});
