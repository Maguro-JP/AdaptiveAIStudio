/**
 * 作業場にしか無いもの（`.github/`・`.githooks/`）を開く試験は、bundle の中では飛ばす。
 *
 * bundle には CI の設定もフックも入れない。そこを開く試験を飛ばさずに置くと、bundle の中で
 * `ENOENT` で落ちる（何も壊れていないのに赤い）。二日続けて同じ形を作った（`test/hooks.test.ts`
 * 2026-09-24、`test/docs-only-push.test.ts` 2026-09-25。どちらも `check:bundle` で見つけた）。
 * 注意書きでは防げなかったので、試験の側で見る。
 *
 * 見るのは形だけ: `join(...)` の引数に `'.github'` か `'.githooks'` が在る試験のファイルは、
 * `skip` を持つ（`sourceOnly` / `inBundle` の形）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const here = import.meta.dirname;

test('`.github` / `.githooks` を開く試験は、bundle の中で飛ばす手を持つ', async () => {
  const opens = /join\([^)]*['"]\.git(?:hub|hooks)['"]/;
  const bad: string[] = [];
  for (const f of await readdir(here)) {
    if (!f.endsWith('.test.ts') || f === 'source-only.test.ts') continue;
    const src = await readFile(join(here, f), 'utf8');
    if (opens.test(src) && !/\bskip\s*:/.test(src)) bad.push(f);
  }
  assert.deepEqual(bad, [], `作業場にしか無いものを開くのに、bundle の中で飛ばす手が無い: ${bad.join(', ')}`);
});
