import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIgnore } from '../src/agent/ignore.ts';
import { Ignores } from '../src/agent/ignore.ts';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';

// git の答え（`git check-ignore` で確かめた）と同じになるか
const cases: Array<{ gitignore: string; path: string; ignored: boolean }> = [
  { gitignore: '/*\n!/src/\n', path: 'src/a.ts', ignored: false },
  { gitignore: '/*\n!/src/\n', path: 'other/b.ts', ignored: true },
  { gitignore: 'x\\[1\\].txt\n', path: 'x[1].txt', ignored: true },
  { gitignore: 'a.txt\t\n', path: 'a.txt', ignored: false },
  { gitignore: 'build\n', path: 'build/out/x.js', ignored: true },
  { gitignore: 'logs/\n!logs/keep.txt\n', path: 'logs/keep.txt', ignored: true },
];

for (const c of cases) {
  test(`.gitignore ${JSON.stringify(c.gitignore)} で ${c.path} は ${c.ignored ? '無視' : '無視しない'}（git と同じ）`, async () => {
    const root = await tempDir('aas-ign133-');
    await writeFile(join(root, '.gitignore'), c.gitignore);
    const ig = await Ignores.load(root);
    assert.equal(ig.ignores(c.path, false), c.ignored);
  });
}

test('parseIgnore は空行と注釈を捨てる', () => {
  assert.equal(parseIgnore('# x\n\n').length, 0);
  void mkdir;
});
