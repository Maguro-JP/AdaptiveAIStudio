import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { tempDir } from './tmp.ts';
// @ts-expect-error 型の無い .mjs
import { sweepStale } from '../scripts/run-tests.mjs';

test('止めた回の一時フォルダは消し、動いている回と関係の無いものには触らない', async () => {
  const dir = await tempDir('aas-sweep-');
  for (const n of ['run-111', 'run-222', 'other']) await mkdir(join(dir, n));
  const removed = sweepStale(dir, (pid: number) => pid === 222);
  assert.deepEqual(removed, ['run-111']);
  assert.deepEqual((await readdir(dir)).sort(), ['other', 'run-222']);
});

test('試験は回ごとの一時フォルダの中で走る', () => {
  assert.match(tmpdir(), /aas-tests[\\/]run-\d+$/);
});

test('試験の家（HOME）は回ごとの場所で、使う人の家に書かない', () => {
  assert.match(homedir(), /aas-tests[\\/]run-\d+[\\/]home$/);
});
