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
import { fitToWindow, sizeOf, tokenBudget, estimateTokens, toolOutputBudget, fitByTokens, trimSchemas } from '../src/agent/window.ts';
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

/**
 * 道具の返しも、窓から決める。
 *
 * `read_file` は最大 40万字を丸ごと返していた。窓が 8k のモデルでは、
 * **一度読んだだけで溢れる。**刈る側は後から縮められるが、
 * そのときには中身がほとんど残らない（直近の結果は 1200 字まで削られる）。
 */
describe('道具の返しを、窓に収める', () => {
  test('窓が広ければ、多く返してよい', () => {
    assert.ok(toolOutputBudget(32768) > toolOutputBudget(8192));
  });

  test('狭い窓でも、使い物にならない長さにはしない', () => {
    // **窓に対する割合で言う。**2000 の決め打ちで守っていたが、窓 2048 では
    // 結果ひとつが履歴の取り分（1896）を超えていた。一度読んだ時点で溢れる。
    // 狙い（短すぎて使い物にならないのを防ぐ）はそのまま、数え方を直す。
    for (const w of [2048, 4096, 8192]) {
      const budget = tokenBudget(w);
      assert.ok(toolOutputBudget(w) >= budget * 0.3, `短すぎる: 窓 ${w}`);
    }
  });

  test('**一つの結果が、会話ぜんぶより大きくならない**', () => {
    for (const w of [2048, 4096, 8192, 32768]) {
      const budget = tokenBudget(w);
      assert.ok(
        toolOutputBudget(w) <= budget * 0.5,
        `結果ひとつが履歴の取り分を食っている: 窓 ${w}（${toolOutputBudget(w)} / ${budget}）`,
      );
    }
  });

  test('窓ぶん全部は使わない（依頼と履歴の分が要る）', () => {
    assert.ok(toolOutputBudget(8192) < 8192);
  });

  test('窓を渡すと、読んだ中身がそこで切れる', async () => {
    const { readFileTool } = await import('../src/agent/tools/fs.ts');
    const { tempDir } = await import('./tmp.ts');
    const { writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const root = await tempDir('aas-read-');
    await writeFile(join(root, 'big.ts'), 'あ'.repeat(60_000));

    const ctx = { root, signal: new AbortController().signal, approve: async () => true };
    const wide = await readFileTool.run({ path: 'big.ts' }, { ...ctx, contextTokens: 32768 });
    const narrow = await readFileTool.run({ path: 'big.ts' }, { ...ctx, contextTokens: 4096 });
    assert.ok(narrow.content.length < wide.content.length, '窓の広さで変わっていない');
    assert.match(narrow.content, /search_text|find_code/, '続きの取り方を言っていない');
  });

  test('**窓が分からないときは切らない**（試験や直接の呼び出しで消さない）', async () => {
    const { readFileTool } = await import('../src/agent/tools/fs.ts');
    const { tempDir } = await import('./tmp.ts');
    const { writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const root = await tempDir('aas-read-');
    await writeFile(join(root, 'big.ts'), 'あ'.repeat(60_000));
    const got = await readFileTool.run({ path: 'big.ts' },
      { root, signal: new AbortController().signal, approve: async () => true });
    assert.ok(got.content.length > 60_000, `切っている: ${got.content.length}`);
  });
});

/**
 * 件数ではなく、長さで決める。
 *
 * 「新しい順に8件」のような数え方は、一件の長さが変われば意味が変わる。
 * **窓が 4k のモデルでは 8 件で半分が埋まり、32k では 8 件では余る。**
 */
describe('入るだけ取る', () => {
  const items = ['あ'.repeat(100), 'い'.repeat(100), 'う'.repeat(100), 'え'.repeat(100)];
  const textOf = (x: string) => x;

  test('入るところまで取る', () => {
    assert.equal(fitByTokens(items, textOf, 250).length, 2);
    assert.equal(fitByTokens(items, textOf, 1000).length, 4);
  });

  test('**0 件にはしない**（そもそも効かなくなる）', () => {
    assert.equal(fitByTokens(items, textOf, 1).length, 1);
    assert.equal(fitByTokens(items, textOf, 0, 2).length, 2);
  });

  test('日本語と英語で、入る件数が変わる', () => {
    const en = ['a'.repeat(100), 'b'.repeat(100), 'c'.repeat(100), 'd'.repeat(100)];
    assert.ok(fitByTokens(en, textOf, 250).length > fitByTokens(items, textOf, 250).length,
      '同じ長さで同じ件数になっている（数え方が効いていない）');
  });

  test('空でも落ちない', () => {
    assert.deepEqual(fitByTokens([], textOf, 100), []);
  });
});

/**
 * 道具の説明も、窓に合わせる。
 *
 * 説明だけで 1400 トークンほどある。**窓が 4k のモデルでは 34%。**
 * 決まりと学びを足すと、肝心の依頼と履歴の場所が残らない。
 */
describe('道具の説明を、狭い窓では削る', () => {
  const schemas = [
    { name: 'read_file', description: 'ファイルを読む。全部読むと窓が埋まるので、必要なところだけにすること。' },
    { name: 'edit_file', description: '一部を差し替える。find は前後を含めて一意にすること。行番号は使わない。' },
  ];

  test('広い窓では、そのまま渡す（説明は効く）', () => {
    const got = trimSchemas(schemas, 32768);
    assert.deepEqual(got, schemas);
  });

  test('狭い窓では、一文目だけにする', () => {
    // 二つの道具なら、窓 256（取り分 64）で一文目の段に落ちる。
    // 丸ごとで 89、一文なら 37。取り分は窓の TOOL_SHARE。
    const got = trimSchemas(schemas, 256);
    assert.equal(got[0]?.description, 'ファイルを読む。');
    assert.equal(got[1]?.description, '一部を差し替える。');
  });

  test('**一文目は残す**（何をする道具かが消えると、呼び分けができない）', () => {
    // 実際に使われる窓（土台が作る窓の下限は 4096）では、必ず残る。
    for (const w of [4096, 8192, 32768]) {
      for (const s of trimSchemas(schemas, w)) {
        assert.ok((s.description ?? '').length > 0, `説明が消えている: ${s.name}（窓 ${w}）`);
      }
    }
  });

  test('それでも入らないほど狭ければ、名前と引数だけにする', () => {
    /*
     * **説明より、会話の場所を優先する。**
     *
     * 道具が九つある本物の並びでは、窓 2048 のとき、一文に切った説明だけで
     * 窓の 38% を占めていた（実測）。依頼と履歴に 242 しか残らない。
     * そこまで来たら説明は落として、名前と引数を残す。
     * **正しく呼べるかどうかは、そこで決まる。**
     */
    const got = trimSchemas(schemas, 1);
    assert.ok(got.every((s) => s.name.length > 0), '名前まで落としている');
    assert.ok(got.every((s) => (s.description ?? '') === ''), '入らないのに残している');
  });

  test('一文しか無いものは、触らない', () => {
    const one = [{ name: 'x', description: 'これだけ。' }];
    assert.deepEqual(trimSchemas(one, 4096), one);
  });

  test('説明が無くても落ちない', () => {
    assert.deepEqual(trimSchemas([{ name: 'x' }], 4096), [{ name: 'x' }]);
  });
});

/**
 * いちばん深く削るときも、**形は残す。**
 *
 * `{ type }` に組み直していたので、`enum` `items` `required` `default` が
 * 落ちていた。手元の道具は type と description しか持たないので気づかない。
 * **MCP で外から来る道具は持っている。**落とすと、モデルは通らない引数を
 * 作り、相手に断られる。減らしたいのは説明であって、形ではない。
 */
describe('削っても、引数の形は壊さない', () => {
  const mcpLike = [{
    name: 'create_issue',
    description: '課題を作る。題と本文が要る。ラベルは任意。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '題' },
        state: { type: 'string', enum: ['open', 'closed'], description: '状態' },
        labels: { type: 'array', items: { type: 'string', description: 'ラベル' } },
        depth: { type: 'number', default: 1, description: '深さ' },
      },
      required: ['title'],
      additionalProperties: false,
    },
  }];

  test('説明だけが消え、enum・items・required・default は残る', () => {
    const got = trimSchemas(mcpLike, 1)[0] as typeof mcpLike[number];
    const props = got.parameters.properties as Record<string, Record<string, unknown>>;
    assert.equal(got.description, undefined, '道具の説明が残っている');
    assert.equal(props.title!.description, undefined, '引数の説明が残っている');
    assert.deepEqual(props.state!.enum, ['open', 'closed'], 'enum を落としている');
    assert.deepEqual(props.labels!.items, { type: 'string' }, 'items を落としている');
    assert.equal(props.depth!.default, 1, 'default を落としている');
    assert.deepEqual(got.parameters.required, ['title'], 'required を落としている');
    assert.equal(got.parameters.additionalProperties, false, 'additionalProperties を落としている');
    // 型は当然残る。
    assert.equal(props.title!.type, 'string');
  });
});

/**
 * 使うほど遅くならない。
 *
 * 毎回すべての履歴を数え直していた。半年ひとつの会話を続けると
 * 14,400 通・16.6MB になり、**一往復あたり 1.2 秒**（本物の数え方なら
 * 2.1 秒）を刈り込みだけに使っていた（実測）。残すのは 18 通なのに、
 * 16MB を測る。**使うほど遅くなるのは、使うほど馬鹿になるのと同じ。**
 *
 * ここは時間ではなく、**量を増やしたとき何倍になるか**で見る
 * （走らせる機械で結果が変わる試験にしない）。
 */
describe('入り切らないものを、測らない', () => {
  /** 一往復ぶん。道具の結果を挟んで、実際の形に近づける。 */
  function round(i: number): ProviderMessage[] {
    return [
      { role: 'user', content: `依頼${i}: ${'長めの文章。'.repeat(20)}` },
      { role: 'assistant', content: '', toolCalls: [{ id: String(i), name: 'read_file', args: {} }] },
      { role: 'tool', content: 'ファイルの中身。'.repeat(100), toolCallId: String(i) },
      { role: 'assistant', content: `返事${i}: ${'説明。'.repeat(20)}` },
    ];
  }
  const history = (rounds: number): ProviderMessage[] =>
    Array.from({ length: rounds }, (_, i) => round(i)).flat();

  test('古い分がいくら増えても、残るものは変わらない', () => {
    const budget = tokenBudget(8192);
    const h20 = history(20);
    const h400 = history(400);
    const few = fitToWindow(h20, budget);
    const many = fitToWindow(h400, budget);
    // **直近は必ず残る。**それぞれの履歴の末尾と突き合わせる。
    assert.equal(many.messages.at(-1)?.content, h400.at(-1)?.content, '直近が落ちている');
    assert.equal(few.messages.at(-1)?.content, h20.at(-1)?.content, '直近が落ちている');
    // 残る通数は、古い分が増えても変わらない（入る量で決まるので）。
    assert.equal(many.messages.length, few.messages.length, `残る量が変わっている: ${many.messages.length} / ${few.messages.length}`);
    assert.ok(many.dropped > few.dropped, '落とした数を数えていない');
    assert.ok(many.trimmed, '刈ったと言っていない');
  });

  test('**量を増やしても、かかる時間が比例して増えない**', () => {
    const budget = tokenBudget(8192);
    const at = (rounds: number): number => {
      const h = history(rounds);
      fitToWindow(h.slice(0, 40), budget); // 温めてから測る
      const t0 = process.hrtime.bigint();
      fitToWindow(h, budget);
      return Number(process.hrtime.bigint() - t0) / 1e6;
    };
    const small = Math.max(at(100), 0.5);
    const large = at(1000);
    assert.ok(
      large / small < 5,
      `10 倍の量で ${(large / small).toFixed(1)} 倍かかっている（全部を測っている）`,
    );
  });

  test('全部が入るなら、何も切らない（対）', () => {
    const h = history(2);
    const got = fitToWindow(h, tokenBudget(32768));
    assert.equal(got.trimmed, false, '入るのに刈っている');
    assert.equal(got.dropped, 0);
    assert.deepEqual(got.messages, h);
  });

  test('最初の依頼は、できるだけ残す', () => {
    const got = fitToWindow(history(400), tokenBudget(8192));
    assert.equal(
      got.messages[0]?.content,
      '依頼0: ' + '長めの文章。'.repeat(20),
      '最初の依頼が消えている（何をしているのか分からなくなる）',
    );
  });
});
