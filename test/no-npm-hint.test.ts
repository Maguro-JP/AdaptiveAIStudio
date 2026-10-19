import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

/*
 * 配った形（portable・setup.exe）には npm が無い。人に見せる案内で `npm run …` と決め打ちすると、
 * Windows の利用者には打てない一手になる（モデルが無いときの案内がそうなっていた）。打つ一手は `how()` で組む。
 * 注釈の中と、モデルへの指示（役職の決まり）は数えない。
 */
const ALLOWED = new Set(['src/cli/how.ts', 'src/roles/builtin.ts']);

async function* tsFiles(dir: string): AsyncGenerator<string> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* tsFiles(p);
    else if ((e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) || (e.name.endsWith('.js') && p.includes('web'))) yield p;
  }
}

test('人に見せる案内に（画面の JS も）、決め打ちの npm run を書かない（how() で組む）', async () => {
  const root = join(import.meta.dirname, '..');
  const hits: string[] = [];
  for await (const file of tsFiles(join(root, 'src'))) {
    const rel = relative(root, file).split('\\').join('/');
    if (ALLOWED.has(rel)) continue;
    const lines = (await readFile(file, 'utf8')).split('\n');
    lines.forEach((line, i) => {
      const code = line.trim();
      if (code.startsWith('*') || code.startsWith('/*') || code.startsWith('//')) return;
      const body = code.replace(/\/\/.*$/, '');
      if (/['"`][^'"`]*npm run [a-z]/.test(body)) hits.push(`${rel}:${i + 1}: ${code.slice(0, 100)}`);
    });
  }
  assert.deepEqual(hits, []);
});
