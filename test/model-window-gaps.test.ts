/**
 * モデルとの通信と、会話をコンテキストウィンドウに収める所の不具合（21 回目の調査）。
 *
 * - 今の依頼（最後の人の発言）は、コンテキストウィンドウから落とさない。押し戻しは今の依頼と見なさない
 * - 履歴の取り分は、実際に送るシステムプロンプトとツールの説明のかさを引いて決める
 * - 番号が同じで id が違う呼び出しを一つに繋がない
 * - `stream: true` を無視してまとめて返す相手の答えを捨てない
 * - ハングル・絵文字・1 通ごとの包みを少なく見積もらない
 * - 失敗の本文を読む間に止めたら、止めただけ（canceled）
 * - 停滞と言うときは、実際に待った秒数を言う
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { OpenAiCompatibleProvider } from '../src/providers/openai-compatible.ts';
import type { ProviderMessage } from '../src/providers/contract.ts';
import { ProviderError } from '../src/providers/errors.ts';
import { fitToWindow, estimateTokens, sizeOf } from '../src/agent/window.ts';

const servers: Server[] = [];
after(() => { for (const s of servers) { s.closeAllConnections(); s.close(); } });

async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
}

/** ツールを一回呼んで結果を受け取った往復。 */
function round(i: number, size: number): ProviderMessage[] {
  return [
    { role: 'assistant', content: '', toolCalls: [{ id: `c${i}`, name: 'read_file', args: { path: `f${i}.ts` } }] },
    { role: 'tool', toolCallId: `c${i}`, content: 'あ'.repeat(size) },
  ];
}

describe('今の依頼を落とさない', () => {
  test('**2 件目の依頼のあとにツールの往復が続いても、2 件目の依頼は残る**', () => {
    const h: ProviderMessage[] = [
      { role: 'user', content: 'A を直して' },
      ...round(0, 2000), ...round(1, 2000), ...round(2, 2000),
      { role: 'user', content: 'B を直して' },
      ...round(3, 2000), ...round(4, 2000), ...round(5, 2000), ...round(6, 2000), ...round(7, 2000),
    ];
    const got = fitToWindow(h, 6144);
    assert.ok(got.trimmed);
    assert.ok(got.messages.some((m) => m.content === 'B を直して'), '今の依頼が落ちた');
    assert.ok(got.messages.some((m) => m.content === 'A を直して'), '最初の依頼が落ちた');
  });

  test('**押し戻しのあとでも、守るのは押し戻しではなく本物の依頼**', () => {
    const h: ProviderMessage[] = [
      { role: 'user', content: 'A を直して' },
      ...round(0, 2000),
      { role: 'user', content: 'B を直して' },
      ...round(1, 2000), ...round(2, 2000), ...round(3, 2000),
      { role: 'assistant', content: '考えています' },
      { role: 'user', content: 'まだ TASK_DONE がありません。', nudge: true },
      ...round(4, 2000), ...round(5, 2000), ...round(6, 2000),
    ];
    const got = fitToWindow(h, 6144);
    assert.ok(got.messages.some((m) => m.content === 'B を直して'), '押し戻しを守って、今の依頼を落とした');
  });

  test('**今の依頼の往復が長くて速い道で切るときも、今の依頼から始める**（assistant から始めない）', () => {
    const h: ProviderMessage[] = [
      { role: 'user', content: 'A を直して' },
      ...round(0, 100),
      { role: 'user', content: 'B を直して' },
      ...Array.from({ length: 15 }, (_, i) => round(i + 1, 2000)).flat(),
    ];
    const got = fitToWindow(h, 6144);
    assert.ok(got.messages.some((m) => m.content === 'B を直して'), '速い道で今の依頼を落とした');
    assert.equal(got.messages[0]!.role, 'user');
  });

  test('最初の依頼が長くて連れて行けないときも、並びは人の依頼から始まる', () => {
    const h: ProviderMessage[] = [
      { role: 'user', content: 'い'.repeat(4000) },
      ...round(0, 100),
      { role: 'user', content: 'B を直して' },
      ...Array.from({ length: 15 }, (_, i) => round(i + 1, 2000)).flat(),
    ];
    const got = fitToWindow(h, 6144);
    assert.equal(got.messages[0]!.role, 'user');
    assert.ok(got.messages.some((m) => m.content === 'B を直して'));
  });
});

describe('システムプロンプトとツールの説明の分', () => {
  test('履歴の取り分は、システムプロンプトとツールの説明のかさを引いた分', async () => {
    const { historyBudget } = await import('../src/agent/window.ts');
    assert.equal(historyBudget(8192, 0), 8192 - 2048);
    assert.equal(historyBudget(8192, 3000), 8192 - 2048 - 3000);
    // 下限に当たったら、返事の予約から削る（下限の 512 をそのまま返してコンテキストウィンドウを超えていた）
    assert.equal(historyBudget(4096, 3000), 512);
    assert.ok(3000 + historyBudget(4096, 3000) + 256 <= 4096, '返事に 256 を残す');
    assert.equal(historyBudget(4096, 10_000), 256, 'それでも足りなければ 256');
  });

  test('**通しで、システムプロンプト・ツールの説明・履歴を足しても、返事の予約を残してコンテキストウィンドウに収まる**', async () => {
    const { ProviderRegistry } = await import('../src/core/registry.ts');
    const { ChatOrchestrator } = await import('../src/core/orchestrator.ts');
    const { Agent } = await import('../src/agent/loop.ts');
    const { readFileTool } = await import('../src/agent/tools/fs.ts');
    const root = await tempDir('aas-mwin-');
    for (let i = 0; i < 8; i += 1) await writeFile(join(root, `f${i}.ts`), 'あ'.repeat(6000));
    const system = '決まり。'.repeat(400); // 約 1600 トークン
    const totals: number[] = [];
    let turn = 0;
    const url = await serve((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const p = JSON.parse(body || '{}') as { messages: { content: string | null }[]; tools?: unknown[] };
        totals.push(p.messages.reduce((n, m) => n + estimateTokens(m.content ?? ''), 0) + estimateTokens(JSON.stringify(p.tools ?? [])));
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (turn < 8) {
          const args = JSON.stringify({ path: `f${turn}.ts` });
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `c${turn}`, function: { name: 'read_file', arguments: args } }] } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
        } else {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '読みました。\nTASK_DONE\n' } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
        }
        turn += 1;
        res.end('data: [DONE]\n\n');
      });
    });
    const registry = new ProviderRegistry();
    registry.register(new OpenAiCompatibleProvider({ id: 'p', baseUrl: url, locality: 'cloud', fallbackModels: ['m'] }));
    const agent = new Agent(new ChatOrchestrator(registry), {
      candidates: ['p:m'], system, tools: [readFileTool], root, contextTokens: 8192,
      approve: () => Promise.resolve(true),
    });
    const history: ProviderMessage[] = [{ role: 'user', content: 'f0 から f7 まで、ぜんぶ読んで' }];
    for await (const ev of agent.run(history, new AbortController().signal)) void ev;
    assert.ok(totals.length >= 8, `回っていない: ${totals.length}`);
    const over = totals.filter((n) => n > 8192 - 2048);
    assert.deepEqual(over, [], `返事の予約を食っている: ${totals.join(', ')}`);
  });
});

describe('ツールの呼び出しの組み立て', () => {
  test('**番号が同じでも id が違えば、別の呼び出しとして分ける**', async () => {
    const url = await serve((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const l of [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"path":"a"}' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_2', function: { name: 'read_file', arguments: '{"path":"b"}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      ]) res.write(`data: ${JSON.stringify(l)}\n\n`);
      res.end('data: [DONE]\n\n');
    });
    const provider = new OpenAiCompatibleProvider({ id: 'p', baseUrl: url, locality: 'cloud' });
    const calls: { id: string; args: unknown }[] = [];
    for await (const ch of provider.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, new AbortController().signal)) {
      if (ch.type === 'toolCall') calls.push({ id: ch.call.id, args: ch.call.args });
    }
    assert.deepEqual(calls, [{ id: 'call_1', args: { path: 'a' } }, { id: 'call_2', args: { path: 'b' } }]);
  });

  test('番号が同じで id の無い欠片は、今までどおり同じ呼び出しの続き（対）', async () => {
    const url = await serve((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const l of [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"path"' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"a"}' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { arguments: '' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      ]) res.write(`data: ${JSON.stringify(l)}\n\n`);
      res.end('data: [DONE]\n\n');
    });
    const provider = new OpenAiCompatibleProvider({ id: 'p', baseUrl: url, locality: 'cloud' });
    const calls: unknown[] = [];
    for await (const ch of provider.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, new AbortController().signal)) {
      if (ch.type === 'toolCall') calls.push(ch.call.args);
    }
    assert.deepEqual(calls, [{ path: 'a' }]);
  });
});

describe('まとめて返す相手', () => {
  test('**`stream: true` を無視して JSON で返されても、本文とツールの呼び出しを読む**', async () => {
    const url = await serve((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        choices: [{
          message: { content: '読みます', tool_calls: [{ id: 'x', function: { name: 'read_file', arguments: '{"path":"a"}' } }] },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 3 },
      }));
    });
    const provider = new OpenAiCompatibleProvider({ id: 'p', baseUrl: url, locality: 'cloud' });
    let text = '';
    const calls: unknown[] = [];
    let done = '';
    for await (const ch of provider.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, new AbortController().signal)) {
      if (ch.type === 'text') text += ch.delta;
      if (ch.type === 'toolCall') calls.push({ id: ch.call.id, args: ch.call.args });
      if (ch.type === 'done') done = ch.finishReason;
    }
    assert.equal(text, '読みます');
    assert.deepEqual(calls, [{ id: 'x', args: { path: 'a' } }]);
    assert.equal(done, 'toolCalls');
  });
});

describe('止めたときと停滞', () => {
  test('**失敗の本文を読む間に止めたら、canceled**（状態番号で unavailable にして口を冷やさない）', async () => {
    const url = await serve((req, res) => {
      req.resume();
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.write('busy');
      // 本文を閉じない
    });
    const provider = new OpenAiCompatibleProvider({ id: 'p', baseUrl: url, locality: 'cloud' });
    const ac = new AbortController();
    const run = (async () => {
      for await (const ch of provider.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, ac.signal)) void ch;
    })();
    setTimeout(() => ac.abort(), 200);
    await assert.rejects(run, (e: unknown) => e instanceof ProviderError && e.kind === 'canceled');
  });

  test('**最初のトークンの前に切れたら、最初のトークンを待った秒数を言う**', async () => {
    const url = await serve((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': started\n\n');
      // 何も送らない
    });
    const provider = new OpenAiCompatibleProvider({
      id: 'p', baseUrl: url, locality: 'cloud', firstTokenTimeoutMs: 2000, stallTimeoutMs: 120_000,
    });
    await assert.rejects(
      (async () => { for await (const ch of provider.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, new AbortController().signal)) void ch; })(),
      (e: unknown) => e instanceof ProviderError && e.kind === 'timeout' && /2秒/.test(e.message) && !/120秒/.test(e.message),
    );
  });
});

describe('見積もり', () => {
  test('**ハングル・絵文字・拡張 B の漢字を、4 字で 1 と数えない**', () => {
    assert.ok(estimateTokens('안녕하세요'.repeat(100)) >= 500);
    assert.ok(estimateTokens('😀'.repeat(100)) >= 200);
    assert.ok(estimateTokens('𠀋'.repeat(100)) >= 200);
    assert.equal(estimateTokens('abcd'), 1, 'ASCII は今までどおり');
  });

  test('**1 通ごとの包みも数える**（空の 10 通は 0 ではない）', () => {
    const empty: ProviderMessage[] = Array.from({ length: 10 }, () => ({ role: 'user', content: '' }));
    assert.ok(sizeOf(empty) >= 40);
  });
});

describe('レビューで挙がった筋書き', () => {
  test('**ツールの返しの上限は、履歴の取り分から決める**（コンテキストウィンドウから決めると取り分より大きくなる）', async () => {
    const { toolOutputBudget } = await import('../src/agent/window.ts');
    assert.ok(toolOutputBudget(8192, undefined, 2000) <= 1000);
    assert.equal(toolOutputBudget(8192), toolOutputBudget(8192, undefined, undefined), '渡さなければ今までどおり');
  });

  test('**今の依頼そのものが大きくても、取り分を超えたまま返さない**（頭を残して縮める）', () => {
    const h: ProviderMessage[] = [
      { role: 'user', content: 'A を直して' },
      ...round(0, 2000),
      { role: 'user', content: `B を直して\n${'添'.repeat(9000)}` },
      ...round(1, 2000), ...round(2, 2000),
    ];
    const got = fitToWindow(h, 6144);
    assert.ok(sizeOf(got.messages) <= 6144, `超えている: ${sizeOf(got.messages)}`);
    assert.ok(got.messages.some((m) => m.content.startsWith('B を直して')), '今の依頼の頭が残っていない');
  });

  test('**名札が JSON でも中身が流れなら、流れとして読む**', async () => {
    const url = await serve((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'はい' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
    const provider = new OpenAiCompatibleProvider({ id: 'p', baseUrl: url, locality: 'cloud' });
    let text = '';
    for await (const ch of provider.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, new AbortController().signal)) {
      if (ch.type === 'text') text += ch.delta;
    }
    assert.equal(text, 'はい');
  });

  test('**まとめ返しの本文が部品の配列でも読む**', async () => {
    const url = await serve((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: [{ type: 'text', text: 'は' }, { type: 'text', text: 'い' }] }, finish_reason: 'stop' }] }));
    });
    const provider = new OpenAiCompatibleProvider({ id: 'p', baseUrl: url, locality: 'cloud' });
    let text = '';
    for await (const ch of provider.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, new AbortController().signal)) {
      if (ch.type === 'text') text += ch.delta;
    }
    assert.equal(text, 'はい');
  });

  test('**番号を振り直した呼び出しの、id の無い続きの欠片は、振り直した先へ繋ぐ**', async () => {
    const url = await serve((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const l of [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'A', function: { name: 'read_file', arguments: '' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"a"}' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'B', function: { name: 'read_file', arguments: '' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"b"}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      ]) res.write(`data: ${JSON.stringify(l)}\n\n`);
      res.end('data: [DONE]\n\n');
    });
    const provider = new OpenAiCompatibleProvider({ id: 'p', baseUrl: url, locality: 'cloud' });
    const calls: { id: string; args: unknown }[] = [];
    for await (const ch of provider.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, new AbortController().signal)) {
      if (ch.type === 'toolCall') calls.push({ id: ch.call.id, args: ch.call.args });
    }
    assert.deepEqual(calls, [{ id: 'A', args: { path: 'a' } }, { id: 'B', args: { path: 'b' } }]);
  });

  test('欠片ごとに id を付け直してくる相手でも、名前の無い欠片で呼び出しを割らない（対）', async () => {
    const url = await serve((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const l of [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'x1', function: { name: 'read_file', arguments: '{"path"' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'x2', function: { arguments: ':"a"}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      ]) res.write(`data: ${JSON.stringify(l)}\n\n`);
      res.end('data: [DONE]\n\n');
    });
    const provider = new OpenAiCompatibleProvider({ id: 'p', baseUrl: url, locality: 'cloud' });
    const calls: unknown[] = [];
    for await (const ch of provider.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, new AbortController().signal)) {
      if (ch.type === 'toolCall') calls.push(ch.call.args);
    }
    assert.deepEqual(calls, [{ path: 'a' }]);
  });
});
