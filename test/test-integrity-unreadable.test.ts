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
    const verdict = compareTests(before, after);
    assert.equal(verdict.ok, true, '一瞬読めなかっただけのテストを「消された」と読んだ');
    // 減っていないとも言えないので、通ったとはみなさない（呼ぶ側はこれを合格にしない）
    assert.match(verdict.unsure ?? '', /a\.test\.ts/, '読めなかったテストを素通しにした');
  });

  test('後で中を見られなかったフォルダの下のテストも「消えた」と数えない', async () => {
    const root = await project({ 'tests/a.test.ts': 'test("x", () => {});', 'b.test.ts': 'test("z", () => {});' });
    const before = await snapshotTests(root);
    const after = await failing('readdir', join(root, 'tests'), () => snapshotTests(root));
    assert.deepEqual([...(after.unreadable ?? [])], ['tests/']);
    assert.equal(compareTests(before, after).ok, true, '見られなかったフォルダの下のテストを「消された」と読んだ');
  });

  test('見られなかったフォルダと名前の頭が同じだけの別のフォルダ（tests2/）で消したテストは、今までどおり見つける', async () => {
    const root = await project({ 'tests/a.test.ts': 'test("x", () => {});', 'tests2/b.test.ts': 'test("z", () => {});' });
    const before = await snapshotTests(root);
    await rm(join(root, 'tests2', 'b.test.ts'));
    const after = await failing('readdir', join(root, 'tests'), () => snapshotTests(root));
    const verdict = compareTests(before, after);
    assert.equal(verdict.ok, false, 'tests/ を見られなかったのを、tests2/ にまで広げた');
    assert.match(verdict.reason!, /tests2\/b\.test\.ts/);
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

describe('確かめのループで、テストを読めなかったとき', () => {
  /*
   * 試験は通ったが、テストを読めなかった。前は「テストを読めませんでした」をモデルに直させに戻し、
   * 同じ要約が続いて打ち切られ、送り口では「失敗」として巻き戻しの対象にしていた。
   */
  test('モデルに直させず、読み直しても読めなければ「確かめられなかった」で終える', async () => {
    const { verifyLoop } = await import('../src/agent/verify.ts');
    const root = await project({ 'a.test.ts': 'test("x", () => {});' });
    const before = await snapshotTests(root);
    let fixes = 0;
    const events: Array<{ type: string; reason?: string }> = [];
    const outcome = await failing('readFile', join(root, 'a.test.ts'), async () => {
      const gen = verifyLoop(
        { command: `"${process.execPath}" -e "process.exit(0)"`, root, maxRounds: 5 },
        async () => { fixes += 1; },
        new AbortController().signal,
        before,
      );
      let step = await gen.next();
      while (!step.done) { events.push(step.value as { type: string; reason?: string }); step = await gen.next(); }
      return step.value;
    });
    assert.equal(fixes, 0, '読めなかっただけなのに、モデルに直させている');
    assert.ok(!events.some((e) => e.type === 'failed'), `失敗として数えている: ${JSON.stringify(events)}`);
    assert.ok(events.some((e) => e.type === 'giveUp' && e.reason === 'unsure'), JSON.stringify(events));
    assert.equal(outcome.passed, false, '確かめられなかったものを合格にしている');
    assert.match(outcome.unsure ?? '', /a\.test\.ts/);
  });

  test('一度だけ読めなかったなら、読み直して合格にする', async () => {
    const { verifyLoop } = await import('../src/agent/verify.ts');
    const root = await project({ 'a.test.ts': 'test("x", () => {});' });
    const before = await snapshotTests(root);
    // 最初の読みだけ失敗させる
    const real = fsp.readFile;
    let failed = false;
    (fsp as Record<string, unknown>).readFile = ((p: unknown, ...rest: unknown[]) => {
      if (p === join(root, 'a.test.ts') && !failed) { failed = true; return Promise.reject(Object.assign(new Error('EBUSY'), { code: 'EBUSY' })); }
      return (real as (...a: unknown[]) => Promise<unknown>)(p, ...rest);
    }) as never;
    syncBuiltinESMExports();
    let fixes = 0;
    let passed = false;
    try {
      const gen = verifyLoop(
        { command: `"${process.execPath}" -e "process.exit(0)"`, root, maxRounds: 5 },
        async () => { fixes += 1; },
        new AbortController().signal,
        before,
      );
      let step = await gen.next();
      while (!step.done) step = await gen.next();
      passed = step.value.passed;
    } finally {
      (fsp as Record<string, unknown>).readFile = real;
      syncBuiltinESMExports();
    }
    assert.equal(failed, true, '読めない場面が作れていない');
    assert.equal(passed, true, '一瞬読めなかっただけで合格にしていない');
    assert.equal(fixes, 0);
  });
});
