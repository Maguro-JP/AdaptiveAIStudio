/**
 * 試験の仮の作業場は `tempDir`（`test/tmp.ts`）で作る。
 *
 * 試験が `mkdtemp` で直に作ると、片づける者がいない。一回走らせるごとに置き土産が残り、積もって 27,000 個・11 GB になり、
 * ディスクが一杯になって押す前の確かめそのものが落ちた（2026-10-06）。作る口を一つにして、片づけもそこで持つ。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** 直に作ってよいもの。理由を書く。 */
const ALLOWED: Record<string, string> = {
  'tmp.ts': '作る口そのもの',
  'before-work.test.ts': '自分の after で消している（試験の前に一度だけ作る家）',
};

test('**試験は mkdtemp で仮の作業場を直に作らない**（tempDir を使う）', async () => {
  const bad: string[] = [];
  for (const f of await readdir(here)) {
    if (!f.endsWith('.ts') || Object.hasOwn(ALLOWED, f)) continue;
    const text = await readFile(join(here, f), 'utf8');
    text.split('\n').forEach((line, i) => {
      if (/\bmkdtemp(Sync)?\s*\(/.test(line) && !/^\s*(\/\/|\*)/.test(line)) bad.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(bad, [], `tempDir（test/tmp.ts）で作ってください: ${bad.join(', ')}`);
});
