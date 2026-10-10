/**
 * 長い頁を上限で切ったのに、切ったと言わなかった（84 回目の調査の残り）。
 *
 * 読む上限（maxBytes の 4 倍のバイト）で切ったあと、HTML の札を外すと文字が短くなり、
 * 渡す上限（maxBytes）に収まる。そのとき「以降は省略」が付かず、頁の全部を読んだように見えていた。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFetchUrlTool } from '../src/agent/tools/network.ts';
import type { ToolContext } from '../src/agent/tools/types.ts';

const ctx: ToolContext = {
  root: process.cwd(),
  signal: new AbortController().signal,
  async approve() { return true; },
};

test('読む上限で頁を切ったら、切ったと言う', async () => {
  // 札ばかりの長い頁。札を外すと短くなる
  const html = '<html><body>' + '<div class="x"><span>a</span></div>'.repeat(200) + '<p>最後の段落</p></body></html>';
  const fetchImpl = (async () => new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })) as unknown as typeof fetch;
  const tool = createFetchUrlTool({ fetchImpl, maxBytes: 100 });
  const r = await tool.run({ url: 'https://registry.npmjs.org/x' }, ctx);
  assert.doesNotMatch(r.content, /最後の段落/, '切られていない（試験の作りが違う）');
  assert.match(r.content, /頭の 400 バイトまで/, `切ったと言っていない:\n${r.content.slice(-200)}`);
});

test('短い頁は、何も足さない（対）', async () => {
  const fetchImpl = (async () => new Response('<p>短い</p>', { headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
  const tool = createFetchUrlTool({ fetchImpl, maxBytes: 100 });
  const r = await tool.run({ url: 'https://registry.npmjs.org/x' }, ctx);
  assert.doesNotMatch(r.content, /バイトまで/);
});
