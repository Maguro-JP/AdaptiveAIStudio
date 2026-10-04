/**
 * 「戻す」の不具合（19 回目の調査）。
 *
 * - 戻り先の後に外で変わったファイルは、黙って消さない（`force` で、それでも戻す）
 * - 空・壊れた戻り先を黙って飛ばさない
 * - 記録できなかったファイルを、後の書き込みで途中の姿のまま「前」にしない
 * - 画面が古い一覧のまま押したら、名前を出していない新しい回まで戻さない
 * - 消されたファイルを戻すとき、実行の権限も戻す
 * - 並びは始めた順の番号で決める（時計を戻しても入れ替わらない）
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, rm, chmod, stat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { UndoStore, UndoConflict, UndoStale } from '../src/core/undo.ts';

async function setup() {
  const base = await tempDir('aas-undo-gaps-');
  const root = join(base, 'work');
  const dir = join(base, 'undo');
  await mkdir(root, { recursive: true });
  return { root, dir, store: new UndoStore(root, dir) };
}

/** AI が一回書いた形を作る（書く前の中身を記録してから書く）。 */
async function turn(store: UndoStore, root: string, rel: string, next: string, now?: number): Promise<string> {
  await store.begin(`${rel} を書く`, now);
  const before = await readFile(join(root, rel), 'utf8').catch(() => undefined);
  store.capture(rel, before);
  await writeFile(join(root, rel), next);
  return (await store.end())!.id;
}

describe('後から入った変化', () => {
  test('**戻り先の後に外で変わったファイルは、黙って消さずに断る。force なら戻す**', async () => {
    const { root, store } = await setup();
    await writeFile(join(root, 'a.txt'), '元\n');
    const id = await turn(store, root, 'a.txt', 'AI\n');
    await writeFile(join(root, 'a.txt'), 'AI\n利用者が足した\n');
    await assert.rejects(store.restore(id), (e: unknown) => e instanceof UndoConflict && e.paths.includes('a.txt'));
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'AI\n利用者が足した\n', '断ったのに書き換えた');
    const done = await store.restore(id, { force: true });
    assert.deepEqual(done?.paths, ['a.txt']);
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), '元\n');
  });

  test('外で変わっていなければ、今までどおり戻す（対）', async () => {
    const { root, store } = await setup();
    await writeFile(join(root, 'a.txt'), '元\n');
    const id = await turn(store, root, 'a.txt', 'AI\n');
    await store.restore(id);
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), '元\n');
  });
});

describe('壊れた戻り先', () => {
  test('**空・JSON でない戻り先が挟まっていたら、飛ばして戻さない**', async () => {
    const { root, dir, store } = await setup();
    await writeFile(join(root, 'a.txt'), '元\n');
    const first = await turn(store, root, 'a.txt', '一\n');
    await turn(store, root, 'a.txt', '二\n');
    await writeFile(join(dir, 'u-broken.json'), '');
    await writeFile(join(dir, 'u-broken2.json'), '{"id":');
    await assert.rejects(store.restore(first), /読めない戻り先/);
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), '二\n', '途中の回を飛ばして当てた');
  });
});

describe('記録できなかったファイル', () => {
  test('**記録できなかった道は、後の書き込みで途中の姿のまま「前」にしない**', async () => {
    const { root, store } = await setup();
    await writeFile(join(root, 'x.txt'), '元\n');
    await store.begin('外のツールが変えてから書く');
    store.skip('x.txt'); // run_command が変え、前の中身を記録できなかった
    await writeFile(join(root, 'x.txt'), '途中\n');
    store.capture('x.txt', '途中\n');
    await writeFile(join(root, 'x.txt'), 'AI\n');
    const point = await store.end();
    assert.equal(point, undefined, '途中の姿を「前」として残した');
  });
});

describe('古い一覧', () => {
  test('**画面が見ていた一番新しい戻り先と違えば、戻さずに断る**', async () => {
    const { root, store } = await setup();
    await writeFile(join(root, 'a.txt'), '元\n');
    const first = await turn(store, root, 'a.txt', '一\n');
    await turn(store, root, 'b.txt', 'B\n');
    await assert.rejects(store.restore(first, { latest: first }), UndoStale);
    assert.equal(await readFile(join(root, 'b.txt'), 'utf8'), 'B\n', '名前を出していない回まで戻した');
    const latest = (await store.list())[0]!.id;
    await store.restore(first, { latest });
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), '元\n');
  });
});

describe('権限', () => {
  test('**消されたファイルを戻すと、実行の権限も戻る**', { skip: process.platform === 'win32' ? 'Windows には実行の権限が無い' : false }, async () => {
    const { root, store } = await setup();
    await writeFile(join(root, 'build.sh'), '#!/bin/sh\necho hi\n');
    await chmod(join(root, 'build.sh'), 0o755);
    await store.begin('消す');
    store.capture('build.sh', await readFile(join(root, 'build.sh'), 'utf8'));
    await rm(join(root, 'build.sh'));
    const id = (await store.end())!.id;
    await store.restore(id);
    assert.equal((await stat(join(root, 'build.sh'))).mode & 0o777, 0o755);
  });
});

describe('レビューで挙がった筋書き', () => {
  test('**前後比べで中身を入れ替えても（段取り）、書く手前に取った権限は残る**', { skip: process.platform === 'win32' ? 'Windows には実行の権限が無い' : false }, async () => {
    const { root, store } = await setup();
    await writeFile(join(root, 'build.sh'), '#!/bin/sh\n');
    await chmod(join(root, 'build.sh'), 0o755);
    await store.begin('段取り');
    store.capture('build.sh', '#!/bin/sh\n');
    store.replace('build.sh', '#!/bin/sh\n'); // 依頼の前後比べで、依頼の前の姿を入れ直す
    await rm(join(root, 'build.sh'));
    const id = (await store.end())!.id;
    await store.restore(id);
    assert.equal((await stat(join(root, 'build.sh'))).mode & 0o777, 0o755);
  });

  test('**新しい回で記録できなかった道を、古い回の書き終えた姿と比べて「後から変わった」と言わない**', async () => {
    const { root, store } = await setup();
    await writeFile(join(root, 'a.txt'), '元\n');
    const first = await turn(store, root, 'a.txt', '一\n');
    // 次の回は a.txt を変えたが、前の中身を記録できなかった（外のツール）。別のファイルは記録できた
    await store.begin('外のツールで変える');
    store.skip('a.txt');
    await writeFile(join(root, 'a.txt'), '二\n');
    store.capture('b.txt', undefined);
    await writeFile(join(root, 'b.txt'), 'B\n');
    await store.end();
    const done = await store.restore(first);
    assert.ok(done, '戻せなかった');
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), '元\n');
  });
});

describe('並び', () => {
  test('**時計を戻しても、後に始めた回が上に並ぶ**', async () => {
    const { root, store } = await setup();
    const NOW = Date.now();
    const older = await turn(store, root, 'a.txt', '一\n', NOW);
    const newer = await turn(store, root, 'b.txt', '二\n', NOW - 60 * 60 * 1000); // 時計が 1 時間戻った
    assert.deepEqual((await store.list()).map((p) => p.id), [newer, older]);
  });
});

describe('綴りの違いと巻き戻しの範囲', () => {
  test('**大文字小文字・末尾の点だけ違う綴りは、Windows と macOS では同じ道の鍵になる**', async () => {
    const { pathKey } = await import('../src/core/undo.ts');
    assert.equal(pathKey('src/Foo.ts', 'win32'), pathKey('src/foo.ts', 'win32'));
    assert.equal(pathKey('src\\foo.ts.', 'win32'), pathKey('src/foo.ts', 'win32'));
    assert.equal(pathKey('src/foo.ts ', 'win32'), pathKey('src/foo.ts', 'win32'));
    assert.equal(pathKey('README.md', 'darwin'), pathKey('readme.md', 'darwin'));
    assert.notEqual(pathKey('README.md', 'linux'), pathKey('readme.md', 'linux'), 'Linux では別のファイル');
    assert.equal(pathKey('../x', 'win32'), '../x', '上の階層を指す `..` は落とさない');
  });

  test('**打ち切ったときの巻き戻しは、書けた道だけを当てる**（書く手前に記録したが書かなかった道は触らない）', async () => {
    const { Checkpoint } = await import('../src/harness/checkpoint.ts');
    const { root } = await setup();
    await writeFile(join(root, 'wrote.txt'), '元\n');
    await writeFile(join(root, 'declined.txt'), '元\n');
    const cp = new Checkpoint(root);
    await cp.capture('wrote.txt');
    await cp.capture('declined.txt'); // 書く手前に記録したが、断られて書かなかった
    await writeFile(join(root, 'wrote.txt'), 'AI\n');
    await writeFile(join(root, 'declined.txt'), '利用者が外で直した\n');
    const r = await cp.restoreAll(['wrote.txt']);
    assert.deepEqual(r.restored, ['wrote.txt']);
    assert.equal(await readFile(join(root, 'wrote.txt'), 'utf8'), '元\n');
    assert.equal(await readFile(join(root, 'declined.txt'), 'utf8'), '利用者が外で直した\n', '書かなかった道まで書き戻した');
  });

  test('UndoStore.has は、この回で前の中身を記録した道かを言う', async () => {
    const { root, store } = await setup();
    await store.begin('x');
    store.capture('a.txt', undefined);
    assert.equal(store.has('a.txt'), true);
    assert.equal(store.has('b.txt'), false);
    store.discard();
    assert.equal(store.has('a.txt'), false);
    void root;
  });
});

describe('大文字小文字を区別するかは、作業場ごとに確かめる', () => {
  /** この機械の一時フォルダが大文字小文字を区別するか（実際に作って確かめる）。 */
  async function sensitive(dir: string): Promise<boolean> {
    const { existsSync } = await import('node:fs');
    await writeFile(join(dir, 'Probe.txt'), 'x');
    return !existsSync(join(dir, 'pROBE.txt'));
  }

  test('**foldsCase は、実際の作業場の振る舞いと一致する**', async () => {
    const { foldsCase } = await import('../src/harness/put-back.ts');
    const { root } = await setup();
    assert.equal(foldsCase(root), !(await sensitive(root)));
  });

  test('**大文字小文字を区別する作業場では、綴りの大小だけ違う別のファイルを一つにまとめない**', async (t) => {
    const { root, store } = await setup();
    if (!(await sensitive(root))) { t.skip('この機械の一時フォルダは大文字小文字を区別しない'); return; }
    await writeFile(join(root, 'X.h'), '大\n');
    await writeFile(join(root, 'x.h'), '小\n');
    await store.begin('両方書く');
    store.capture('X.h', '大\n');
    store.capture('x.h', '小\n');
    await writeFile(join(root, 'X.h'), 'AI-大\n');
    await writeFile(join(root, 'x.h'), 'AI-小\n');
    const id = (await store.end())!.id;
    await store.restore(id);
    assert.equal(await readFile(join(root, 'X.h'), 'utf8'), '大\n');
    assert.equal(await readFile(join(root, 'x.h'), 'utf8'), '小\n', '片方の中身でもう片方を書き戻した');
  });
});
