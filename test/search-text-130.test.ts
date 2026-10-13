import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { searchText } from '../src/agent/tools/fs.ts';
import { tempDir } from './tmp.ts';

const find = async (body: string, query: string) => {
  const root = await tempDir('aas-search130-');
  await writeFile(join(root, 't.txt'), body);
  return searchText(root, query, '.', new AbortController().signal);
};

test('CRLF のファイルを、改行を含む文字列で探しても当たる', async () => {
  const r = await find('alpha\r\nbeta\r\ngamma\r\n', 'alpha\nbeta');
  assert.equal(r.hits.length, 1);
  assert.equal(r.hits[0]!.line, 1);
});

test('端に空白のある文字列が長い行で当たったら、見せる部分に当たりを入れる', async () => {
  const r = await find(`${'a'.repeat(300)}END  \n`, 'END  ');
  assert.equal(r.hits.length, 1);
  assert.ok(r.hits[0]!.text.includes('END'), r.hits[0]!.text);
});

test('合成済みと分解済みの綴りの違いでは、当たり外れを変えない', async () => {
  const r = await find('café\n', 'café');
  assert.equal(r.hits.length, 1);
});
