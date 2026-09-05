/**
 * 文脈の窓に、履歴を収める。
 *
 * ここまで、履歴は一度も刈っていなかった。外の大きなモデルなら入るので
 * 済んでいた。ローカルは違う。会社の機械に載る大きさだと窓は 8192 で、
 * ファイルを2つ3つ読んだ時点で溢れる。
 *
 * 溢れたときが、いちばん悪い。ライブラリは**古い方から黙って落とす**。
 * 落ちるのは、いちばん古いもの＝**最初の依頼**。何をしていたのかを
 * 忘れたまま道具だけを呼び続ける。止まらないので気づけない。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fitToWindow, sizeOf, tokenBudget, estimateTokens } from '../src/agent/window.ts';
import type { ProviderMessage } from '../src/providers/contract.ts';

/** 読んで書いて、を n 回。道具の結果は大きい（ファイルの中身なので）。 */
function history(rounds: number, resultChars = 2000): ProviderMessage[] {
  const out: ProviderMessage[] = [{ role: 'user', content: 'src を直して' }];
  for (let i = 0; i < rounds; i += 1) {
    out.push({
      role: 'assistant', content: '',
      toolCalls: [{ id: `c${i}`, name: 'read_file', args: { path: `f${i}.ts` } }],
    });
    out.push({ role: 'tool', toolCallId: `c${i}`, content: 'あ'.repeat(resultChars) });
  }
  return out;
}

/**
 * 送れる形になっているか。
 *
 * **道具の結果には、必ずその呼び出しが先に要る。**片方だけ落とすと
 * OpenAI 互換の口が形の違うものを受け取って落ちる。
 */
function wellFormed(messages: ProviderMessage[]): true | string {
  const open = new Set<string>();
  for (const m of messages) {
    if (m.role === 'assistant') for (const c of m.toolCalls ?? []) open.add(c.id);
    if (m.role === 'tool') {
      if (!m.toolCallId || !open.has(m.toolCallId)) return `呼び出しの無い結果: ${m.toolCallId}`;
    }
  }
  return true;
}

describe('窓に収める', () => {
  test('収まっているなら、何もしない', () => {
    const h = history(2, 100);
    const r = fitToWindow(h, 100_000);
    assert.equal(r.trimmed, false);
    assert.deepEqual(r.messages, h);
  });

  test('元は変えない', () => {
    // 元を刈ると、残してある会話まで欠ける。送る分だけを作る。
    const h = history(20);
    const before = JSON.stringify(h);
    fitToWindow(h, 3000);
    assert.equal(JSON.stringify(h), before, '元を書き換えている');
  });

  test('最初の依頼は落とさない', () => {
    // ここが落ちると、何をしていたのかを忘れたまま道具を呼び続ける。
    const r = fitToWindow(history(30), 3000);
    assert.equal(r.messages[0]?.content, 'src を直して');
  });

  test('直近のやりとりは残る', () => {
    const h = history(30);
    const r = fitToWindow(h, 3000);
    const lastCall = h.at(-2)!.toolCalls![0]!.id;
    assert.ok(
      r.messages.some((m) => m.toolCalls?.some((c) => c.id === lastCall)),
      '直近まで落としている',
    );
  });

  test('落としたことを、本文に残す', () => {
    // 黙って落とすと、モデルは「読んだはずのもの」を読んでいないまま進む。
    const r = fitToWindow(history(30), 3000);
    assert.ok(r.dropped > 0, '落としていない');
    assert.ok(r.messages.some((m) => m.content.includes('省いています')), '落としたと書いていない');
  });

  test('呼び出しと結果を、切り離さない', () => {
    // 片方だけ落とすと、相手が形の違うものを受け取って落ちる。
    for (const budget of [500, 1500, 3000, 8000, 20000]) {
      const r = fitToWindow(history(30), budget);
      assert.equal(wellFormed(r.messages), true, `budget=${budget}: ${wellFormed(r.messages)}`);
    }
  });

  test('まず縮める。落とすのはそれでも溢れるときだけ', () => {
    // かさの大半は道具の結果。頭だけ残せば、往復の筋は追える。
    const r = fitToWindow(history(6, 3000), 12_000);
    assert.equal(r.trimmed, true);
    assert.equal(r.dropped, 0, '縮めるだけで足りるのに落としている');
    assert.ok(r.messages.some((m) => m.content.includes('省いています')), '省いたと書いていない');
  });

  test('狭すぎるときは、直近も縮める（落とすより縮める）', () => {
    // 落とすと往復の筋そのものが消える。縮めれば「何をしたか」は残る。
    const r = fitToWindow(history(6, 3000), 6000);
    assert.equal(wellFormed(r.messages), true);
    // 直近の呼び出しは、縮んででも残っていること。
    const h = history(6, 3000);
    const lastCall = h.at(-2)!.toolCalls![0]!.id;
    assert.ok(r.messages.some((m) => m.toolCalls?.some((c) => c.id === lastCall)), '直近まで落としている');
    assert.ok(sizeOf(r.messages) < sizeOf(h) / 2, `減っていない: ${sizeOf(r.messages)}`);
  });

  test('窓の大きさから、使ってよい分を決める', () => {
    assert.ok(tokenBudget(8192) > 4000, '8192 の窓で半分も使えないのはおかしい');
    assert.ok(tokenBudget(8192) < 8192, '窓ぶん全部を履歴に使っている');
    // 小さい窓でも 0 にしない（0 にすると何も送れず、必ず落ちる）。
    assert.ok(tokenBudget(1024) > 0);
  });
});

/**
 * 文字数からトークン数を見積もる。
 *
 * **一つの係数で済ませると、日本語で溢れる。**
 * 2.5文字＝1トークンで数えていたので、日本語では2倍以上入ると見積もっていた。
 * 入らない分は窓から溢れ、途中で落ちる（「打っても返事が来ない」の形）。
 */
describe('日本語と英語を、同じ係数で数えない', () => {
  test('日本語は、ほぼ1文字1トークンで数える', () => {
    const said = 'これは日本語の文です';
    assert.ok(estimateTokens(said) >= said.length, `少なく見ている: ${estimateTokens(said)}`);
  });

  test('英語は、まとめて数える（多く見すぎない）', () => {
    const said = 'this is an english sentence about files';
    assert.ok(estimateTokens(said) < said.length / 2, `多く見すぎ: ${estimateTokens(said)}`);
  });

  test('**同じ長さでも、日本語のほうが重い**', () => {
    const ja = 'あ'.repeat(100);
    const en = 'a'.repeat(100);
    assert.ok(estimateTokens(ja) > estimateTokens(en) * 3, `差が付いていない: ${estimateTokens(ja)} vs ${estimateTokens(en)}`);
  });

  test('空でも落ちない', () => {
    assert.equal(estimateTokens(''), 0);
  });

  test('絵文字や記号でも数えられる', () => {
    assert.ok(estimateTokens('📁 src/a.ts を読む') > 0);
  });
});

describe('通しで、窓を超えないこと', () => {
  test('大きなファイルを何度読んでも、送る分は窓に収まる', async () => {
    // **これが自律で回すときの形。**読んで、直して、また読む。
    // 刈らないと、5回目あたりで窓を超え、ライブラリが古い方から黙って
    // 落とす。落ちるのは最初の依頼で、何をしていたのかが消える。
    const { createServer } = await import('node:http');
    const { writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tempDir } = await import('./tmp.ts');
    const { OpenAiCompatibleProvider } = await import('../src/providers/openai-compatible.ts');
    const { ProviderRegistry } = await import('../src/core/registry.ts');
    const { ChatOrchestrator } = await import('../src/core/orchestrator.ts');
    const { Agent } = await import('../src/agent/loop.ts');
    const { readFileTool } = await import('../src/agent/tools/fs.ts');

    const root = await tempDir('aas-win-');
    // 1ファイル 6000 字。8192 の窓には2つも入らない。
    for (let i = 0; i < 8; i += 1) await writeFile(join(root, `f${i}.ts`), 'あ'.repeat(6000));

    /** 送られてきた履歴のかさ。**受け取る側で数える。** */
    const sent: number[] = [];
    let turn = 0;
    const server = createServer((req, res) => {
      if (req.url?.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{"data":[{"id":"m"}]}');
      }
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const p = JSON.parse(body || '{}') as { messages: { content: string }[] };
        sent.push(p.messages.reduce((n, m) => n + (m.content ?? '').length, 0));
        // **最初の依頼が残っているか。**ここが落ちると何をしていたか消える。
        const first = p.messages.find((m) => (m.content ?? '').includes('ぜんぶ読んで'));
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (!first) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '最初の依頼が消えました' } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
        } else if (turn < 8) {
          const args = JSON.stringify({ path: `f${turn}.ts` });
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `c${turn}`, function: { name: 'read_file', arguments: args } }] } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
        } else {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '読みました。\nTASK_DONE\n' } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
        }
        turn += 1;
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as import('node:net').AddressInfo;

    const registry = new ProviderRegistry();
    registry.register(new OpenAiCompatibleProvider({
      id: 'p', baseUrl: `http://127.0.0.1:${port}/v1`, locality: 'local', fallbackModels: ['m'],
    }));
    const agent = new Agent(new ChatOrchestrator(registry), {
      candidates: ['p:m'], system: 'テスト', tools: [readFileTool], root,
      contextTokens: 8192,
      approve: () => Promise.resolve(true),
    });

    const history: ProviderMessage[] = [{ role: 'user', content: 'f0 から f7 まで、ぜんぶ読んで' }];
    const events: string[] = [];
    let said = '';
    try {
      for await (const ev of agent.run(history, new AbortController().signal)) {
        events.push(ev.type);
        if (ev.type === 'thinking') said += ev.delta;
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => { server.close(() => r()); });
    }

    const limit = tokenBudget(8192);
    const over = sent.filter((n) => n > limit * 1.1);
    assert.deepEqual(over, [], `窓を超えたまま送っている: ${sent.join(', ')} / 上限 ${limit}`);
    assert.ok(!said.includes('最初の依頼が消えました'), '最初の依頼が落ちている');
    assert.ok(events.includes('trimmed'), '刈ったことを言っていない');
    // 残してある履歴の方は、刈られていないこと（送る分だけを刈る）。
    assert.ok(history.length > 10, `元の履歴まで刈っている: ${history.length}`);
  });
});
