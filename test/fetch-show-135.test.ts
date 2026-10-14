import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFetchUrlTool, toText } from '../src/agent/tools/network.ts';
import { createShowFileTool } from '../src/agent/tools/show.ts';
import { tempDir } from './tmp.ts';

const ctx = { approve: async () => true, signal: new AbortController().signal, root: '.' } as never;
const toolFor = (status: number, headers: Record<string, string>, body: Uint8Array | string) =>
  createFetchUrlTool({ allowedHosts: ['x.test'], fetchImpl: (async () => new Response(status >= 300 && status < 400 ? null : body, { status, headers })) as unknown as typeof fetch });

test('見出しに charset が無い HTML は、meta の charset で読む（EUC-JP）', async () => {
  const euc = Buffer.from([0xc6, 0xfc, 0xcb, 0xdc, 0xb8, 0xec, 0xa4, 0xc7, 0xa4, 0xb9]); // 日本語です
  const body = Buffer.concat([Buffer.from('<html><head><meta charset="EUC-JP"></head><body>'), euc, Buffer.from('</body></html>')]);
  const r = await toolFor(200, { 'content-type': 'text/html' }, body).run({ url: 'https://x.test/a' }, ctx);
  assert.match(r.content, /日本語です/);
});

test('文字でない中身は渡さない', async () => {
  const r = await toolFor(200, { 'content-type': 'image/png' }, new Uint8Array([0x89, 0x50, 0x4e, 0x47])).run({ url: 'https://x.test/p' }, ctx);
  assert.equal(r.isError, true);
  assert.match(r.content, /文字ではない中身（image\/png）/);
});

test('飛ばされたら、繋がらなかったとは言わず、飛ばされた先を言う', async () => {
  const r = await toolFor(302, { location: 'https://x.test/b' }, '').run({ url: 'https://x.test/a' }, ctx);
  assert.equal(r.isError, true);
  assert.match(r.content, /302 で別の場所へ飛ばされました: https:\/\/x\.test\/b/);
  assert.doesNotMatch(r.content, /外に出られませんでした/);
});

test('HTML の注釈は丸ごと落とし、文字の参照は字に戻す', () => {
  const t = toText('<p>price: 100</p><!-- old: if a > b then price 999 --><p>&quot;ok&quot; &#26085;&#x672C;</p>', 'text/html');
  assert.doesNotMatch(t, /999/);
  assert.match(t, /"ok" 日本/);
});

test('show_file は無い行を開いたと言わない', async () => {
  const root = await tempDir('aas-show135-');
  await writeFile(join(root, 'a.txt'), '1\n2\n3\n');
  const tool = createShowFileTool(() => undefined);
  const r = await tool.run({ path: 'a.txt', line: 9999 }, { ...(ctx as object), root } as never);
  assert.equal(r.isError, true);
  assert.match(r.content, /3 行しかありません/);
  const ok3 = await tool.run({ path: 'a.txt', line: 3 }, { ...(ctx as object), root } as never);
  assert.notEqual(ok3.isError, true);
});
