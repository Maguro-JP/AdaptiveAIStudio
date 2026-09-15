/**
 * 組んだ模型の中身は、走らせるたびに変えない。
 *
 * 重みを `Math.random()` で書いていたので、組むたびに別の模型になっていた。
 * 中身が無意味なのは構わないが、**中身が毎回違うとテストの結果が毎回変わる。**
 * 実際に `scripts/real-model.mjs` の「考えごとの予算」が、同じコードのまま
 * 一度落ちて、次に通った。落ちた側を追いかけて、原因を探す時間を丸ごと無駄にする。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { tempDir } from './tmp.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 組んで、中身をそのまま返す。 */
async function build(dir: string, name: string, args: string[] = []): Promise<Buffer> {
  const at = join(dir, name);
  execFileSync(process.execPath, [join(root, 'scripts', 'tiny-gguf.mjs'), at, ...args], { stdio: 'pipe' });
  return readFile(at);
}

describe('組んだ模型の中身は、毎回同じ', () => {
  test('**二度組んでも、一致する**', async () => {
    const dir = await tempDir('aas-seed-');
    const a = await build(dir, 'a.gguf');
    const b = await build(dir, 'b.gguf');
    assert.ok(a.equals(b), `組むたびに中身が変わっている（${a.length} / ${b.length} バイト）`);
  });

  test('考えごとをする方も、毎回同じ', async () => {
    const dir = await tempDir('aas-seed-think-');
    const a = await build(dir, 'a.gguf', ['--thinks']);
    const b = await build(dir, 'b.gguf', ['--thinks']);
    assert.ok(a.equals(b), '考えごとをする方が毎回違う');
  });

  test('**種を変えれば、違う中身になる（対）**', async () => {
    // ここが一致すると、種を読んでいない（固定の中身を書いているだけ）。
    const dir = await tempDir('aas-seed-diff-');
    const a = await build(dir, 'a.gguf');
    const b = await build(dir, 'b.gguf', ['--seed', '12345']);
    assert.ok(!a.equals(b), '種を変えても中身が同じ');
  });
});
