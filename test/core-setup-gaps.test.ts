/**
 * src/core の起動まわりの不具合（70 回目の調査）。
 *
 * - PATH に引用符で囲んだ項目（`"C:\Program Files\nodejs"`）があると、その中の命令を「無い」と断った
 * - GGUF が二つ以上あると、数え方は名前の先頭のものを「本物」と見せ、runtime が実際に読むもの（大きさと機械で選ぶ）とずれた
 *
 * 同梱の GitHub のツールで起こすのに「npx が無いので動きません」と言っていた件は、同梱の有無を外から渡す口が要るので試験を書いていない
 * （確かめていない）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { truncate, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { totalmem } from 'node:os';
import { tempDir } from './tmp.ts';
import { findOnPath } from '../src/core/which.ts';
import { resolveCounting } from '../src/core/counting.ts';
import { listGguf, chooseModel } from '../src/runtime/inproc.ts';

test('**PATH の項目の引用符を外して探す**', () => {
  const got = findOnPath('npx', {
    platform: 'win32',
    path: '"C:\\Program Files\\nodejs";C:\\Windows',
    exists: (p) => p === 'C:\\Program Files\\nodejs\\npx.CMD',
  });
  assert.equal(got, 'C:\\Program Files\\nodejs\\npx.CMD');
});

test('**二つ以上の GGUF から、runtime と同じものを選んで数える**', async () => {
  const dir = await tempDir('aas-counting-choose-');
  for (const name of ['a-small.gguf', 'b-big.gguf']) {
    execFileSync(process.execPath, ['scripts/tiny-gguf.mjs', join(dir, name), '--seed', '1'], { stdio: 'pipe' });
  }
  // 名前の先頭ではない方を大きくしておく（runtime は載るなら大きい方を選ぶ。名前の先頭を取るとずれる）
  const big = join(dir, 'b-big.gguf');
  await truncate(big, (await stat(big)).size + 64 * 1024 * 1024);
  const found = await listGguf(dir);
  const expected = chooseModel(found, totalmem())?.chosen.ref;
  assert.ok(expected, '前提: 選べない');
  assert.notEqual(expected, found[0]!.ref, `前提: runtime が名前の先頭を選んでいて、見分けられない（${expected}）`);
  const got = await resolveCounting({ runtime: { kind: 'inproc', modelsDir: dir }, providers: [], candidates: [] } as never);
  assert.equal(got.file, expected, `runtime と別のモデルで数えた: ${got.file} / runtime ${expected}`);
});
