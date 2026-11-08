/**
 * 途中で手を止めたモデルを、押し戻す。
 *
 * ここまで **「道具を呼ばなかった＝終わった」** で判じていた。
 * 小さいモデルは作業の途中で平気で手を止める。
 * 「では次に src/a.ts を書き換えます」と言って、そこで返してくる。
 * それを完了と読んでいたので、**何もしていないのに完了と出ていた。**
 *
 * 自律で回し続けられなかったのは、毎回ここで降りていたから。
 * ローカルの小さいモデルほど、この降り方をする。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { OpenAiCompatibleProvider } from '../src/providers/openai-compatible.ts';
import { ProviderRegistry } from '../src/core/registry.ts';
import { ChatOrchestrator } from '../src/core/orchestrator.ts';
import { Agent, type AgentEvent } from '../src/agent/loop.ts';
import { readFileTool, writeFileTool } from '../src/agent/tools/fs.ts';
import { DONE_MARK } from '../src/agent/done.ts';

type Step = { text: string } | { tool: string; args: unknown };

/** 台本どおりに返す偽モデル。最後の手は繰り返す（本物も同じ返事を繰り返す）。 */
async function scripted(script: Step[]) {
  let turn = 0;
  const asked: string[] = [];
  const server = createServer((req, res) => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"data":[{"id":"m"}]}');
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}') as { messages: { role: string; content: string }[] };
      asked.push(parsed.messages.at(-1)?.content ?? '');
      const step = script[Math.min(turn, script.length - 1)]!;
      turn += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if ('text' in step) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: step.text } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      } else {
        const args = JSON.stringify(step.args);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `c${turn}`, function: { name: step.tool, arguments: args } }] } }] })}\n\n`);
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
    asked,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

async function run(script: Step[], maxNudges?: number, expectsWork?: boolean, ask = 'a.txt を書き換えて') {
  const root = await tempDir('aas-nudge-');
  await writeFile(join(root, 'a.txt'), 'もとの中身\n');
  const fake = await scripted(script);
  const registry = new ProviderRegistry();
  registry.register(new OpenAiCompatibleProvider({
    id: 'p', baseUrl: fake.baseUrl, locality: 'local', fallbackModels: ['m'],
  }));
  const agent = new Agent(new ChatOrchestrator(registry), {
    candidates: ['p:m'], system: 'テスト', tools: [readFileTool, writeFileTool],
    root, approve: () => Promise.resolve(true),
    ...(maxNudges !== undefined ? { maxNudges } : {}),
    ...(expectsWork !== undefined ? { expectsWork } : {}),
  });
  const events: AgentEvent[] = [];
  const history = [{ role: 'user' as const, content: ask }];
  for await (const ev of agent.run(history, new AbortController().signal)) events.push(ev);
  return { events, root, asked: fake.asked, close: fake.close };
}

describe('途中で手を止めたら、押し戻す', () => {
  test('作業の頼みで、コードを文で書いて止まったら押し戻し、ファイルを書かせる', async () => {
    // 本物の重み（Qwen3.5-4B）で実際に起きた形。ツールを一度も呼ばず、コードの塊を返して「済んだ」になっていた
    const r = await run([
      { text: '```javascript\nconsole.log(1)\n```' },
      { tool: 'write_file', args: { path: 'a.txt', content: '書きました\n' } },
      { text: `${DONE_MARK}\n` },
    ], undefined, true, 'さっきのファイルを書き換えて');
    try {
      assert.ok(r.events.some((e) => e.type === 'nudged'), '押し戻していない');
      assert.ok(r.asked.some((a) => a.includes('ファイルを書くツール')), 'ツールで書くよう言っていない');
      assert.equal(await readFile(join(r.root, 'a.txt'), 'utf8'), '書きました\n');
    } finally { await r.close(); }
  });

  test('**頼みにファイル名が 1 つあり、答えのコードが 1 つなら、そのファイルを書く呼び出しに直す**（4B が本文に書いて「完了」と言った形）', async () => {
    const r = await run([
      { text: '```javascript\nconsole.log(15)\n```\n' + DONE_MARK + '\n' },
      { text: `${DONE_MARK}\n` },
    ], undefined, true, 'b.js というファイルを作ってください');
    try {
      assert.equal(await readFile(join(r.root, 'b.js'), 'utf8'), 'console.log(15)\n');
      assert.ok(r.events.some((e) => e.type === 'salvaged'), '直したことを知らせていない');
    } finally { await r.close(); }
  });

  test('ファイル名が 2 つある頼みでは、どこに書くかを推測しない', async () => {
    const { fileFromCode } = await import('../src/agent/loop.ts');
    assert.equal(fileFromCode('```js\nx\n```', 'a.js と b.js を作って'), undefined);
    assert.equal(fileFromCode('```js\nx\n```\n```js\ny\n```', 'a.js を作って'), undefined);
    assert.deepEqual(fileFromCode('```js\nx\n```', 'fizzbuzz.js というファイルを作ってください。'), { path: 'fizzbuzz.js', content: 'x\n' });
    // 実行の仕方を添えた塊（bash）は数えない（Windows の check-user で 4B が書いた形）
    assert.deepEqual(fileFromCode('```javascript\nx\n```\n実行するには:\n```bash\nnode fizzbuzz.js\n```', 'fizzbuzz.js というファイルを作ってください。'), { path: 'fizzbuzz.js', content: 'x\n' });
    assert.deepEqual(fileFromCode('```bash\necho hi\n```', 'run.sh を作って'), { path: 'run.sh', content: 'echo hi\n' });
  });

  test('終わりの合図をコマンドの形で呼んでも、終わりとして受け取る', async () => {
    // Windows の確かめで実際に起きた形。run_command に TASK_DONE を渡し、「許されていないコマンド」で回り続けた
    const r = await run([
      { tool: 'write_file', args: { path: 'a.txt', content: '書きました\n' } },
      { tool: 'run_command', args: { command: 'TASK_DONE' } },
    ], undefined, true);
    try {
      assert.ok(!r.events.some((e) => e.type === 'toolStart' && e.call.name === 'run_command'), '合図をコマンドとして走らせた');
      const last = r.events.at(-1);
      assert.equal(last?.type, 'finished');
      assert.equal(last.reason, 'completed');
    } finally { await r.close(); }
  });

  test('**終わりの合図をファイルとして書いても、終わりとして受け取る**（TASK_DONE というファイルを作らない）', async () => {
    // Windows の check-work（Qwen3.5-4B）で実際に起きた形。write_file に path: TASK_DONE を渡し、同じ書き込みの禁止で 15 分回り続けた
    const { existsSync } = await import('node:fs');
    const r = await run([
      { tool: 'write_file', args: { path: 'a.txt', content: '書きました\n' } },
      { tool: 'write_file', args: { path: DONE_MARK, content: DONE_MARK } },
    ], undefined, true);
    try {
      assert.ok(!existsSync(join(r.root, DONE_MARK)), '作業場に TASK_DONE というファイルを作った');
      assert.ok(!r.events.some((e) => e.type === 'toolStart' && (e.call.args as { path?: string }).path === DONE_MARK), '合図をファイルの書き込みとして走らせた');
      const last = r.events.at(-1);
      assert.equal(last?.type, 'finished');
      assert.equal(last.reason, 'completed');
    } finally { await r.close(); }
    const { isDoneCall } = await import('../src/agent/loop.ts');
    assert.equal(isDoneCall({ name: 'read_file', args: { path: './TASK_DONE' } }), true);
    assert.equal(isDoneCall({ name: 'write_file', args: { path: 'TASK_DONE.txt', content: 'x' } }), true);
    assert.equal(isDoneCall({ name: 'write_file', args: { path: 'task_done_notes.js', content: 'x' } }), false);
  });

  test('押し戻しの文は、合図がファイルではないと言う', async () => {
    const r = await run([
      { tool: 'read_file', args: { path: 'a.txt' } },
      { text: '読みました。' },
      { text: `${DONE_MARK}\n` },
    ], undefined, true);
    try {
      assert.ok(r.asked.some((a) => a.includes('ファイルではありません')), '合図がファイルではないと言っていない');
    } finally { await r.close(); }
  });

  test('**作業の頼みに「修正します」と言っただけで返したら、一度押し戻して実行させる**', async () => {
    // Windows の check-work（Qwen3.5-4B）の形。「足し算に修正します。」で終わり、calc.js は直っていなかった
    const r = await run([
      { text: 'a.txt の中身が違うので、修正します。' },
      { tool: 'write_file', args: { path: 'a.txt', content: '直しました\n' } },
      { text: `${DONE_MARK}\n` },
    ], undefined, true);
    try {
      assert.ok(r.events.some((e) => e.type === 'nudged'), '押し戻していない');
      assert.ok(r.asked.some((a) => a.includes('やると言っただけ')), '実行を求める押し戻しが届いていない');
      assert.equal(await readFile(join(r.root, 'a.txt'), 'utf8'), '直しました\n');
      const last = r.events.at(-1);
      assert.equal(last?.type, 'finished');
      assert.equal(last.reason, 'completed');
    } finally { await r.close(); }
  });

  test('「修正します」と言うだけを繰り返したら、済んだと言わない', async () => {
    const r = await run([{ text: '足し算に修正します。' }], undefined, true);
    try {
      const last = r.events.at(-1);
      assert.equal(last?.type, 'finished');
      assert.equal(last.reason, 'noProgress', 'やっていないのに完了と言っている');
    } finally { await r.close(); }
  });

  test('会話（作業の頼みでない）の「〜します」は押し戻さない（対）', async () => {
    const r = await run([{ text: 'それでは説明します。' }], undefined, false);
    try {
      assert.ok(!r.events.some((e) => e.type === 'nudged'), '会話の返事を押し戻している');
    } finally { await r.close(); }
    const { announcesAction } = await import('../src/agent/work-style.ts');
    assert.equal(announcesAction('足し算に修正します。'), true);
    assert.equal(announcesAction('hello.js を作成しました。'), false);
    assert.equal(announcesAction('この作業場は src と test でできています。'), false);
  });

  test('作業の頼みでも、普通に答えただけなら押し戻さない（対）', async () => {
    const r = await run([{ text: 'この作業場は src と test でできています。' }], undefined, true);
    try {
      assert.ok(!r.events.some((e) => e.type === 'nudged'), '答えただけの返事を押し戻している');
      const last = r.events.at(-1);
      assert.equal(last?.type, 'finished');
      assert.equal(last.reason, 'completed');
    } finally { await r.close(); }
  });

  test('作業の頼みで、押し戻してもツールを使わないなら、済んだと言わない', async () => {
    const r = await run([{ text: '```js\nx\n```' }], undefined, true);
    try {
      const last = r.events.at(-1);
      assert.equal(last?.type, 'finished');
      assert.equal(last.reason, 'noProgress');
    } finally { await r.close(); }
  });

  test('読んだだけで止まったら押し戻し、その先で書ける', async () => {
    // これが実際に起きる形。読んで、「では書き換えます」と言って止まる。
    const r = await run([
      { tool: 'read_file', args: { path: 'a.txt' } },
      { text: 'では a.txt を書き換えます。' },
      { tool: 'write_file', args: { path: 'a.txt', content: '書き換えました\n' } },
      { text: `終わりました。\n${DONE_MARK}\n` },
    ]);
    try {
      assert.ok(r.events.some((e) => e.type === 'nudged'), '押し戻していない');
      // **ファイルで見る。**出来事だけを見ていたので、何も変わっていないのに
      // 「完了」と出ているのに気づけなかった。
      assert.equal(await readFile(join(r.root, 'a.txt'), 'utf8'), '書き換えました\n');
      const last = r.events.at(-1);
      assert.equal(last?.type, 'finished');
      assert.equal(last.reason, 'completed');
      // 押し戻しは、次の一手を求める文言であること（「続けて」だけでは同じ返事が来る）。
      assert.ok(r.asked.some((a) => a.includes(DONE_MARK)), '押し戻しの中身が届いていない');
    } finally { await r.close(); }
  });

  test('合図を書いたら、押し戻さずに終わる（対）', async () => {
    // 何でも押し戻すと、素直に終わったものまで往復が二度増える。
    const r = await run([
      { tool: 'write_file', args: { path: 'a.txt', content: 'x\n' } },
      { text: `やりました。\n${DONE_MARK}\n` },
    ]);
    try {
      assert.ok(!r.events.some((e) => e.type === 'nudged'), '要らない押し戻しをしている');
      const last = r.events.at(-1);
      assert.equal(last?.type, 'finished');
      assert.equal(last.reason, 'completed');
    } finally { await r.close(); }
  });

  test('押し戻しても動かないなら、動かないと言う', async () => {
    // 「完了」と出してはいけない。**やったと言って、やっていない**を作らない。
    const r = await run([
      { tool: 'read_file', args: { path: 'a.txt' } },
      { text: 'では書き換えます。' },
    ]);
    try {
      const last = r.events.at(-1);
      assert.equal(last?.type, 'finished');
      assert.equal(last.reason, 'noProgress', '動いていないのに完了と言っている');
      assert.equal(await readFile(join(r.root, 'a.txt'), 'utf8'), 'もとの中身\n');
      // 押し戻しは決めた回数まで。際限なく粘らない（只ではない）。
      assert.equal(r.events.filter((e) => e.type === 'nudged').length, 2);
    } finally { await r.close(); }
  });

  test('訊かれて答えただけなら、押し戻さない（対）', async () => {
    // 道具を一度も使っていないなら、答えが仕事。押し戻しても意味がなく、
    // 往復を二度増やすだけになる。
    const r = await run([{ text: 'これは設定を読む関数です。' }]);
    try {
      assert.ok(!r.events.some((e) => e.type === 'nudged'), '答えただけなのに押し戻している');
      const last = r.events.at(-1);
      assert.equal(last?.type, 'finished');
      assert.equal(last.reason, 'completed');
    } finally { await r.close(); }
  });

  test('合図は画面に出さない', async () => {
    const r = await run([{ text: `できました。\n${DONE_MARK}\n` }]);
    try {
      const shown = r.events.filter((e) => e.type === 'thinking').map((e) => e.delta).join('');
      assert.ok(!shown.includes(DONE_MARK), `合図が画面に出ている: ${shown}`);
      assert.ok(shown.includes('できました。'), `本文まで消している: ${shown}`);
    } finally { await r.close(); }
  });

  test('押し戻しを 0 にすれば、これまでどおり', async () => {
    const r = await run([
      { tool: 'read_file', args: { path: 'a.txt' } },
      { text: 'では書き換えます。' },
    ], 0);
    try {
      assert.ok(!r.events.some((e) => e.type === 'nudged'));
      assert.equal((r.events.at(-1) as { reason?: string }).reason, 'noProgress');
    } finally { await r.close(); }
  });

  /**
   * **押し戻していないなら、押し戻したと書かない。**
   *
   * 切ってある（0 回）のに「0 回押し戻しましたが、動きませんでした」と出していた。
   * 本物の重みで確かめた回に実際に出た文言で、読む人は「押し戻したのに駄目だった」と
   * 受け取る。止めること自体は変えない（やっていないのに完了と言わないため）。
   */
  test('**押し戻しを切ったときの理由に、押し戻した回数を書かない**', async () => {
    const off = await run([
      { tool: 'read_file', args: { path: 'a.txt' } },
      { text: 'では書き換えます。' },
    ], 0);
    try {
      const last = off.events.at(-1) as { reason?: string; detail?: string };
      assert.equal(last.reason, 'noProgress');
      assert.ok(!/回押し戻し/.test(last.detail ?? ''), `押し戻していないのに回数を書いている: ${last.detail}`);
      assert.match(last.detail ?? '', /押し戻しは切ってあります/);
    } finally { await off.close(); }

    // 対。押し戻しが在るときは、回数を書く（何度粘ったかが分からないと追えない）。
    const on = await run([
      { tool: 'read_file', args: { path: 'a.txt' } },
      { text: 'では書き換えます。' },
    ], 2);
    try {
      const last = on.events.at(-1) as { detail?: string };
      assert.match(last.detail ?? '', /2 回押し戻しましたが/);
    } finally { await on.close(); }
  });
});
