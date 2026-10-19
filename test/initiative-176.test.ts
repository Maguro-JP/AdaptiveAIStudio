import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { findLeads } from '../src/agent/initiative.ts';
import { Prefetcher } from '../src/agent/prefetch.ts';

async function leadsOf(root: string) {
  const p = new Prefetcher(root, undefined, () => true);
  p.start();
  return findLeads({ root, snapshot: (await p.snapshot())!, known: new Set(), max: 50 });
}

test('test_foo.py はテストとして扱い、「テストが無い実装」に挙げない', async () => {
  const root = await tempDir('aas-init176-');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'foo.py'), 'def foo():\n    return 1\n');
  await writeFile(join(root, 'src', 'test_foo.py'), 'from foo import foo\n\ndef test_foo():\n    assert foo() == 1\n');
  const titles = (await leadsOf(root)).map((l) => l.title);
  assert.equal(titles.some((t) => t.includes('test_foo.py') && t.includes('テストが見当たりません')), false, titles.join('\n'));
  assert.equal(titles.some((t) => t.includes('src/foo.py') && t.includes('テストが見当たりません')), false, titles.join('\n'));
});

test('末尾が改行のちょうど 600 行は、大きすぎるとは言わない。601 行なら言う', async () => {
  const root = await tempDir('aas-init176b-');
  await mkdir(join(root, 'src'), { recursive: true });
  const body = (n: number) => Array.from({ length: n }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n';
  await writeFile(join(root, 'src', 'a.ts'), body(600));
  await writeFile(join(root, 'src', 'b.ts'), body(601));
  const titles = (await leadsOf(root)).map((l) => l.title);
  assert.equal(titles.some((t) => t.startsWith('src/a.ts が')), false, titles.join('\n'));
  assert.ok(titles.includes('src/b.ts が 601 行あります'), titles.join('\n'));
});
