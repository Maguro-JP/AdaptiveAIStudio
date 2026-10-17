import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { buildIndex, MAX_FILE } from '../src/agent/code-index.ts';

test('大きすぎて外したファイルは、上限で切った残りに数えない（見た・外した・残りの和が全体）', async () => {
  // readdir の順は場所で変わるので、順に頼らない。大きいものを多めに置き、どの順でも和が全体になることを見る
  const root = await tempDir('aas-ix173-');
  await writeFile(join(root, 'a.ts'), 'export const a = 1;\n');
  await writeFile(join(root, 'b.ts'), 'export const b = 2;\n');
  for (const n of ['c', 'd', 'e', 'f']) await writeFile(join(root, `0${n}.ts`), 'x'.repeat(MAX_FILE + 1));
  const ix = await buildIndex(root, 2);
  assert.equal(ix.files.length, 2);
  assert.equal(ix.files.length + ix.skipped + (ix.capped ?? 0), 6);
});

test('本当に残っているときは、その数だけ言う', async () => {
  const root = await tempDir('aas-ix173b-');
  for (const n of ['a', 'b', 'c', 'd']) await writeFile(join(root, `${n}.ts`), `export const ${n} = 1;\n`);
  const ix = await buildIndex(root, 2);
  assert.equal(ix.capped, 2);
});
