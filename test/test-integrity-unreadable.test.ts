/**
 * テストの数え直しで、読めなかったファイル・見られなかったフォルダを「消えた」「減った」と数えない。
 *
 * 数え直しは読めないものを黙って飛ばしていたので、作業の後で一瞬読めなかっただけのテストを「消された」と読み、
 * 打ち切りの巻き戻しで作業を丸ごと戻していた。本当に消した・減らしたときは、今までどおり見つける。
 *
 * 読めなさは fs/promises の関数をその道だけ失敗させて作る（権限に頼らない。root でも同じ結果になる）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tempDir } from './tmp.ts';
import { snapshotTests, compareTests } from '../src/agent/test-integrity.ts';

const require = createRequire(import.meta.url);
const fsp = require('node:fs/promises') as typeof import('node:fs/promises');

/** fs/promises の `name` を、`path` のときだけ EACCES で失敗させて `fn` を回す。 */
async function failing<T>(name: 'readFile' | 'readdir', path: string, fn: () => Promise<T>): Promise<T> {
  const real = fsp[name] as (...a: unknown[]) => Promise<unknown>;
  (fsp as Record<string, unknown>)[name] = ((p: unknown, ...rest: unknown[]) => p === path
    ? Promise.reject(Object.assign(new Error(`EACCES: ${name} failed`), { code: 'EACCES' }))
    : real(p, ...rest)) as never;
  syncBuiltinESMExports();
  try {
    return await fn();
  } finally {
    (fsp as Record<string, unknown>)[name] = real;
    syncBuiltinESMExports();
  }
}

async function project(files: Record<string, string>): Promise<string> {
  const root = await tempDir('aas-integrity-unreadable-');
  for (const [name, content] of Object.entries(files)) {
    const abs = join(root, name);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, content);
  }
  return root;
}

describe('数え直しで読めなかったもの', () => {
  test('後で読めなかったテストファイルは「消えた」と数えない', async () => {
    const root = await project({ 'a.test.ts': 'test("x", () => {}); test("y", () => {});' });
    const before = await snapshotTests(root);
    const after = await failing('readFile', join(root, 'a.test.ts'), () => snapshotTests(root));
    assert.deepEqual([...(after.unreadable ?? [])], ['a.test.ts']);
    assert.equal(compareTests(before, after).ok, true, '一瞬読めなかっただけのテストを「消された」と読んだ');
  });

  test('後で中を見られなかったフォルダの下のテストも「消えた」と数えない', async () => {
    const root = await project({ 'tests/a.test.ts': 'test("x", () => {});', 'b.test.ts': 'test("z", () => {});' });
    const before = await snapshotTests(root);
    const after = await failing('readdir', join(root, 'tests'), () => snapshotTests(root));
    assert.equal(compareTests(before, after).ok, true, '見られなかったフォルダの下のテストを「消された」と読んだ');
  });

  test('読めなかったものとは別に、本当に消したテストは今までどおり見つける', async () => {
    const root = await project({ 'a.test.ts': 'test("x", () => {});', 'b.test.ts': 'test("z", () => {});' });
    const before = await snapshotTests(root);
    await rm(join(root, 'b.test.ts'));
    const after = await failing('readFile', join(root, 'a.test.ts'), () => snapshotTests(root));
    const verdict = compareTests(before, after);
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason!, /b\.test\.ts/);
    assert.doesNotMatch(verdict.reason!, /a\.test\.ts/);
  });
});
