/**
 * 戻すときに読めない・見られないものを、「無い」「変わらず」と取り違えて途中だけ戻さない。
 *
 *   ・置き戻しの lstat が落ちたのを「無い」と読み、消すべきものを「変わらず」と返して戻り先ごと捨てていた
 *   ・戻り先の一覧から読めない戻り先を黙って外し、それを挟んだ古い戻り先まで戻すとき、その回の分だけ当てずに「戻した」と返していた
 *
 * 読めなさは fs/promises の関数をその道だけ失敗させて作る（権限に頼らない。root でも同じ結果になる）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tempDir } from './tmp.ts';
import { UndoStore } from '../src/core/undo.ts';
import { putBack } from '../src/harness/put-back.ts';

const require = createRequire(import.meta.url);
const fsp = require('node:fs/promises') as typeof import('node:fs/promises');

/** fs/promises の `name` を、`path` のときだけ EACCES で失敗させて `fn` を回す。 */
async function failing<T>(name: 'readFile' | 'lstat', path: string, fn: () => Promise<T>): Promise<T> {
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

describe('置き戻しで見られないとき', () => {
  test('消すべきものを「変わらず」と返さず、「戻せなかった」と返す', async () => {
    const root = await tempDir('aas-putback-unreadable-');
    const abs = join(root, 'made.txt');
    await writeFile(abs, '作った\n');
    const r = await failing('lstat', abs, () => putBack(root, 'made.txt', undefined));
    assert.equal(r, 'failed', `見られないのを「無い」と読んだ: ${r}`);
  });
});

describe('読めない戻り先があるとき', () => {
  test('途中を飛ばして戻さず、何も当てずにそう言う', async () => {
    const root = await tempDir('aas-undo-unreadable-');
    const state = await tempDir('aas-undo-unreadable-state-');
    const dir = join(state, 'undo');
    const undo = new UndoStore(root, dir);
    const abs = join(root, 'a.txt');
    await writeFile(abs, 'v1\n');
    // 1 回目: v1 → v2、2 回目: v2 → v3
    await undo.begin('一回目', 1_000);
    undo.capture('a.txt', 'v1\n');
    await writeFile(abs, 'v2\n');
    const first = (await undo.end())!;
    await undo.begin('二回目', 2_000);
    undo.capture('a.txt', 'v2\n');
    await writeFile(abs, 'v3\n');
    const second = (await undo.end())!;
    assert.ok(first && second);

    // 二回目の戻り先を読めなくして、一回目まで戻す
    const secondFile = join(dir, `${second.id}.json`);
    await assert.rejects(failing('readFile', secondFile, () => undo.restore(first.id)), /読めない戻り先/);
    assert.equal(await readFile(abs, 'utf8'), 'v3\n', '途中だけ戻した');
    assert.deepEqual((await readdir(dir)).sort(), [`${first.id}.json`, `${second.id}.json`].sort(), '戻り先を消した');
    // 読めるようになれば戻せる
    await undo.restore(first.id);
    assert.equal(await readFile(abs, 'utf8'), 'v1\n');
  });
});
