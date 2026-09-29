/**
 * 書く前の中身を読めなかった道を、「前は無かった」と取り違えない。
 *
 * 読めない理由を問わず「無い」として記録していたので、打ち切ったときの巻き戻しで、
 * 元から在ったファイルを消していた。読めなかった（権限・掴まれている）道は触らず、戻せない道として返す。
 *
 * 読めなさは fs/promises の readFile をその道だけ失敗させて作る（権限に頼らない。root でも同じ結果になる）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tempDir } from './tmp.ts';
import { Checkpoint } from '../src/harness/checkpoint.ts';

const require = createRequire(import.meta.url);

/** `path` だけ `code` で読めなくして `fn` を回す。 */
async function unreadable<T>(path: string, code: string, fn: () => Promise<T>): Promise<T> {
  const fsp = require('node:fs/promises') as typeof import('node:fs/promises');
  const real = fsp.readFile;
  (fsp as { readFile: unknown }).readFile = ((file: unknown, ...rest: unknown[]) => file === path
    ? Promise.reject(Object.assign(new Error(code), { code }))
    : (real as (...a: unknown[]) => Promise<unknown>)(file, ...rest)) as never;
  syncBuiltinESMExports();
  try {
    return await fn();
  } finally {
    (fsp as { readFile: unknown }).readFile = real;
    syncBuiltinESMExports();
  }
}

describe('Checkpoint.capture で前の中身を読めなかったとき', () => {
  for (const code of ['EACCES', 'EBUSY']) {
    test(`${code}: 巻き戻しで消さず、戻せない道として返す`, async () => {
      const root = await tempDir('aas-cp-unreadable-');
      const abs = join(root, 'a.txt');
      await writeFile(abs, 'もとの中身\n');
      const cp = new Checkpoint(root);
      await unreadable(abs, code, () => cp.capture('a.txt'));
      await writeFile(abs, '書き換えた\n');

      assert.deepEqual(cp.unrecorded(), ['a.txt']);
      const r = await cp.restoreAll();
      assert.deepEqual(r.restored, [], '読めなかった道を「戻した」と言っている');
      assert.equal(await readFile(abs, 'utf8').catch(() => undefined), '書き換えた\n', '元から在ったファイルを消した');
      assert.deepEqual(cp.unrecorded(), [], '巻き戻しの後も残っている');
    });
  }

  test('「無い」（ENOENT）は今までどおり「前は無かった」として、巻き戻しで消す', async () => {
    const root = await tempDir('aas-cp-unreadable-');
    const cp = new Checkpoint(root);
    await cp.capture('made.txt');
    await writeFile(join(root, 'made.txt'), '作った\n');
    assert.deepEqual(cp.unrecorded(), []);
    assert.deepEqual(await cp.restore(), ['made.txt']);
    assert.equal(await readFile(join(root, 'made.txt'), 'utf8').catch(() => undefined), undefined);
  });

  test('読めなかった道は、後から渡された中身（remember）でも上書きしない', async () => {
    const root = await tempDir('aas-cp-unreadable-');
    const abs = join(root, 'a.txt');
    await writeFile(abs, 'もとの中身\n');
    const cp = new Checkpoint(root);
    await unreadable(abs, 'EACCES', () => cp.capture('a.txt'));
    // 後で分かる「前」は、途中の姿。回の前の姿ではないので記録しない
    cp.remember('a.txt', '途中\n');
    await writeFile(abs, '最後\n');
    await cp.restoreAll();
    assert.equal(await readFile(abs, 'utf8'), '最後\n', '途中の姿に戻した');
  });

  test('途中がファイルで辿れない（ENOTDIR）のは「無い」として記録する', async () => {
    const root = await tempDir('aas-cp-unreadable-');
    const abs = join(root, 'd', 'a.txt');
    const cp = new Checkpoint(root);
    await unreadable(abs, 'ENOTDIR', () => cp.capture('d/a.txt'));
    assert.deepEqual(cp.unrecorded(), [], '「無い」を記録できなかった道にしている');
    assert.equal(cp.size, 1);
  });

  test('書き込めた道だけを、戻せない道として返す（綴りが違っても同じ道）', async () => {
    const root = await tempDir('aas-cp-unreadable-');
    const cp = new Checkpoint(root);
    for (const name of ['a.txt', 'b.txt']) {
      const abs = join(root, name);
      await writeFile(abs, 'もと\n');
      await unreadable(abs, 'EACCES', () => cp.capture(name));
    }
    assert.deepEqual(cp.unrecorded(), ['a.txt', 'b.txt']);
    // b.txt は書けずに終わった。変えていない道まで「戻せなかった」と言わない
    assert.deepEqual(cp.unrecorded(['./a.txt']), ['a.txt']);
  });
});
