import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedFrom } from '../src/agent/repo-map.ts';
import type { CodeIndex } from '../src/agent/code-index.ts';

const file = (path: string) => ({ path, size: 1, mtimeMs: 0, symbols: [], refs: [], head: '' });
const index = { root: '.', format: 0, builtAt: '', skipped: 0, files: [file('src/ui/server.ts'), file('src/ui/server-x.ts'), file('src/agent/code-index.ts')] } as unknown as CodeIndex;

test('拡張子を除いた名前の語で、そのファイルに当てる。似た名前には当てない', () => {
  const seed = seedFrom(index, 'server を直して', [], [], { search: false });
  assert.equal(seed.get(0), 3);
  assert.equal(seed.get(1), undefined);
  const ix = seedFrom(index, 'index を直して', [], [], { search: false });
  assert.equal(ix.get(2), undefined);
});
