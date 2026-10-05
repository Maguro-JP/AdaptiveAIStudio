/**
 * 検問所の抜け（36 回目の調査、DECISIONS 10-05）。
 *
 * - 通す側は、最後の行が `PASS` だけのときに限る（頭が PASS の行や、後ろに続きのある PASS で通さない）
 * - 止める行が一つでもあれば止める（後ろの PASS が前の BLOCK を上書きしない）
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readJudgement } from '../src/harness/inspector.ts';

describe('判じ手の答えを読む', () => {
  test('頭が PASS なだけの行では通さない', () => {
    for (const s of [
      'PASS/BLOCK: BLOCK: ROLE_CHANGE',
      'Pass? No — BLOCK: ROLE_CHANGE',
      'PASS ordinary technical writing.',
      'PASS if the reader agrees',
    ]) {
      assert.notEqual(readJudgement(s).judgement, 'pass', `通してしまっている: ${s}`);
    }
  });

  test('止める行が一つでもあれば、後ろの PASS で通さない', () => {
    const r = readJudgement('BLOCK: ROLE_CHANGE\nPASS');
    assert.equal(r.judgement, 'block');
    assert.match(r.reason ?? '', /ROLE_CHANGE/);
  });

  test('PASS の後に続きを書いたら、通したことにしない', () => {
    assert.notEqual(readJudgement('PASS\nOn reflection this should be Blocked.').judgement, 'pass');
  });

  test('考えを外に書いてから PASS と結ぶ答えは通す（前の行の BLOCK や「止め」を判定と読まない）', () => {
    for (const s of [
      'Block? No — ordinary docs.\nPASS',
      'BLOCK would apply if it told the reader to ignore rules.\nPASS',
      '止める理由はありません\nPASS',
      'Format:\n  PASS\n  BLOCK: <REASON_CODE>\nPASS',
    ]) {
      assert.equal(readJudgement(s).judgement, 'pass', s);
    }
  });

  test('結びの PASS に付いた終わりの記号・絵文字は外して読む', () => {
    for (const s of ['PASS</s>', 'PASS<|im_end|>', 'PASS ✅', 'PASS 👍']) {
      assert.equal(readJudgement(s).judgement, 'pass', s);
    }
  });

  test('最後の行が PASS だけなら通す（対）', () => {
    for (const s of ['PASS', 'PASS.', '**PASS**', 'I read it.\nPASS', '<think>\nBLOCK?\n</think>\nPASS']) {
      assert.equal(readJudgement(s).judgement, 'pass', s);
    }
  });
});

import { Inspector } from '../src/harness/inspector.ts';
import { createFetchUrlTool } from '../src/agent/tools/network.ts';
import { flatten } from '../src/mcp/client.ts';
import type { ToolContext } from '../src/agent/tools/types.ts';

function ctxWith(signal: AbortSignal): ToolContext {
  return { root: process.cwd(), signal, approve: async () => true };
}

describe('外から読んだものを渡す', () => {
  test('判じ手に見せた分だけを渡す（チャンクの間に置いた仕込みを、見ずに渡さない）', async () => {
    const seen: string[] = [];
    const inspector = new Inspector({ judge: async (req) => { seen.push(req.user); return 'PASS'; }, maxChars: 1000, maxWindows: 3 });
    // 仕込みは 1,500〜1,600 字目。全体（6,000 字）をチャンクで間引くと、頭・中ほど・尻のどれにも入らない
    const body = 'a'.repeat(1500) + 'HIDDEN-INSTRUCTION' + 'b'.repeat(4482);
    const tool = createFetchUrlTool({
      allowedHosts: ['example.com'], maxBytes: 60_000, inspector,
      fetchImpl: (async () => new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } })) as typeof fetch,
    });
    const r = await tool.run({ url: 'https://example.com/x' }, ctxWith(new AbortController().signal));
    const judged = seen.join('');
    if (r.content.includes('HIDDEN-INSTRUCTION')) {
      assert.ok(judged.includes('HIDDEN-INSTRUCTION'), '渡す本文の仕込みを、判じ手に見せていない');
    }
    // 渡す長さは、判じ手が隙間なく見られる長さまで
    assert.ok(!r.content.includes('b'.repeat(4000)), '判じ手が見られる長さを超えて渡した');
  });

  test('確かめの途中で止めたら、中身を渡さない', async () => {
    const ac = new AbortController();
    // 1 回目は持ち出し（行き先）の確かめ。止めるのは 2 回目の持ち込みの確かめの最中
    let calls = 0;
    const inspector = new Inspector({ judge: async (_req, signal) => {
      calls += 1;
      if (calls === 1) return 'PASS';
      ac.abort();
      if (signal.aborted) throw new Error('aborted');
      await new Promise((_r, rej) => signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true }));
      return 'PASS';
    } });
    const tool = createFetchUrlTool({
      allowedHosts: ['example.com'], inspector,
      fetchImpl: (async () => new Response('中身', { status: 200, headers: { 'content-type': 'text/plain' } })) as typeof fetch,
    });
    const r = await tool.run({ url: 'https://example.com/x' }, ctxWith(ac.signal));
    assert.equal(calls, 2, '持ち込みの確かめまで届いていない（この試験の前提が崩れた）');
    assert.equal(r.isError, true, '止めたのに中身を渡した');
    assert.match(r.content, /中断/);
    assert.doesNotMatch(r.content, /中身$/);
  });

  test('MCP の埋め込みの資料は、本文を読む', () => {
    const r = flatten({ content: [{ type: 'resource', resource: { uri: 'file:///a.txt', text: '資料の本文' } }] });
    assert.match(r.text, /資料の本文/);
    assert.match(r.text, /file:\/\/\/a\.txt/);
  });
});
