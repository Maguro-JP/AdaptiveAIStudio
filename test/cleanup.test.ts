/**
 * 溜まったものを片づける。
 *
 * **消してはいけないものを、消さないことを確かめる。**
 * GGUF は数GBある。落とし直しに何十分もかかるものを黙って消されるのが、
 * いちばん困る。「消せた」ことより「消さなかった」ことを見る。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { tempDir } from './tmp.ts';
import { findRemovable } from '../src/runtime/cleanup.ts';

/** 置き場を作って、その中に一式を並べる。 */
async function scratch(): Promise<{ home: string; models: string; bin: string }> {
  const home = await tempDir('aas-clean-');
  const models = join(home, 'models');
  const bin = join(home, 'bin');
  await mkdir(models, { recursive: true });
  await mkdir(bin, { recursive: true });
  process.env.AAS_HOME = home;
  delete process.env.AAS_MODELS_DIR;
  delete process.env.AAS_BIN_DIR;
  delete process.env.AAS_STATE_DIR;
  return { home, models, bin };
}

describe('片づけるもの・片づけないもの', () => {
  test('GGUF は消さない', async () => {
    const { models } = await scratch();
    await writeFile(join(models, 'qwen2.5-3b-instruct-q4_k_m.gguf'), 'GGUF');
    await writeFile(join(models, 'よその.GGUF'), 'x');
    const found = await findRemovable({ keepTag: 'b9999' });
    assert.deepEqual(found.map((f) => f.path), [], 'モデルを消そうとしている');
  });

  test('会話の見出しの書き換えで残った古い一時ファイルは消す。書いている最中の新しいものと会話そのものは消さない', async () => {
    const { home } = await scratch();
    const talks = join(home, 'conversations');
    await mkdir(talks, { recursive: true });
    await writeFile(join(talks, 'c1.jsonl'), '{}\n');
    await writeFile(join(talks, 'c1.jsonl.123.1.tmp'), '{}\n');
    const later = Date.now() + 2 * 60 * 60 * 1000;
    assert.deepEqual((await findRemovable({ keepTag: 'b9999', now: later })).map((f) => f.path), [join(talks, 'c1.jsonl.123.1.tmp')]);
    assert.deepEqual((await findRemovable({ keepTag: 'b9999' })).map((f) => f.path), [], '書いている最中の一時ファイルを消そうとした');
  });

  test('状態のファイルと戻り先で残った古い一時ファイルは消す。新しいもの・元のファイル・知らない名前は消さない', async () => {
    const { home } = await scratch();
    const undo = join(home, 'undo');
    await mkdir(undo, { recursive: true });
    const old = [
      join(home, 'memory.jsonl.123.a1b2c3.tmp'),
      join(home, 'unfinished.jsonl.123.4.tmp'),
      join(home, 'goals.jsonl.123.5.tmp'),
      join(undo, 'u1.json.123.6.tmp'),
    ];
    for (const p of old) await writeFile(p, 'x');
    await writeFile(join(home, 'memory.jsonl'), '{}\n');
    await writeFile(join(home, 'goals.jsonl'), '{}\n');
    await writeFile(join(home, 'mine.jsonl.123.4.tmp'), 'x');
    await writeFile(join(undo, 'u1.json'), JSON.stringify({ id: 'u1', root: home }));
    const later = Date.now() + 2 * 60 * 60 * 1000;
    assert.deepEqual((await findRemovable({ keepTag: 'b9999', now: later })).map((f) => f.path).sort(), [...old].sort());
    assert.deepEqual((await findRemovable({ keepTag: 'b9999' })).map((f) => f.path), [], '書いている最中の一時ファイルを消そうとした');
  });

  test('作業場の根を持たない古い戻り先は消す。根を持つもの（別の作業場のものも）・読めないものは消さない', async () => {
    const { home } = await scratch();
    const undo = join(home, 'undo');
    await mkdir(undo, { recursive: true });
    await writeFile(join(undo, 'old.json'), JSON.stringify({ id: 'old', files: [] }));
    await writeFile(join(undo, 'here.json'), JSON.stringify({ id: 'here', root: home, files: [] }));
    await writeFile(join(undo, 'there.json'), JSON.stringify({ id: 'there', root: '/somewhere/else', files: [] }));
    await writeFile(join(undo, 'broken.json'), '{');
    await writeFile(join(undo, 'nothing.json'), 'null');
    await writeFile(join(undo, 'no-id.json'), JSON.stringify({ files: [] }));
    await writeFile(join(undo, 'text.json'), JSON.stringify('x'));
    assert.deepEqual((await findRemovable({ keepTag: 'b9999' })).map((f) => f.path), [join(undo, 'old.json')]);
  });

  test('途中で切れた取得は消す', async () => {
    const { models } = await scratch();
    await writeFile(join(models, 'm.gguf.part'), 'x');
    await writeFile(join(models, 'm.gguf'), 'GGUF');
    const found = await findRemovable({ keepTag: 'b9999' });
    assert.deepEqual(found.map((f) => f.path), [join(models, 'm.gguf.part')]);
  });

  test('古い llama-server は消すが、いま使っている版は残す', async () => {
    const { bin } = await scratch();
    await mkdir(join(bin, 'b1000'));
    await mkdir(join(bin, 'b2000'));
    // 版の形をしていないものは触らない。知らない名前を消さない。
    await mkdir(join(bin, 'なにか'));
    const found = await findRemovable({ keepTag: 'b2000' });
    assert.deepEqual(found.map((f) => f.path), [join(bin, 'b1000')]);
  });

  test('新しい記録は残す', async () => {
    const { home } = await scratch();
    const logs = join(home, 'logs');
    await mkdir(logs, { recursive: true });
    await writeFile(join(logs, 'today.log'), 'x');
    const found = await findRemovable({ keepTag: 'b9999' });
    assert.deepEqual(found.map((f) => f.path), []);
  });

  test('置き場が無くても落ちない', async () => {
    process.env.AAS_HOME = join(await tempDir('aas-none-'), 'まだ無い');
    assert.deepEqual(await findRemovable({ keepTag: 'b1' }), []);
  });
});

describe('前に渡した添付', () => {
  test('1日より古いものは片づける対象。新しいものは残す（対）', async () => {
    const { home } = await scratch();
    const { join: j } = await import('node:path');
    const { mkdir: mk, writeFile: wf, utimes } = await import('node:fs/promises');
    const dir = j(home, 'attachments');
    await mk(dir, { recursive: true });
    await wf(j(dir, 'old-a.txt'), 'x');
    await wf(j(dir, 'new-b.txt'), 'y');
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    await utimes(j(dir, 'old-a.txt'), old, old);
    const found = await findRemovable({ keepTag: 'b1' });
    const names = found.map((f) => f.path.split(/[\\/]/).at(-1));
    assert.ok(names.includes('old-a.txt'), '古い添付が対象に無い');
    assert.ok(!names.includes('new-b.txt'), '新しい添付まで消そうとしている');
  });

  /**
   * 記録は増えるだけで、減る道が無かった。作業場に doctor-…txt が 37 個
   * 並び、横の一覧がそれで埋まった（実機）。新しい方から 10 件だけ残す。
   */
  test('**古い記録は挙げる。新しい 10 件は残す**', async () => {
    const { home } = await scratch();
    const reports = join(home, 'reports');
    await mkdir(reports, { recursive: true });
    for (let i = 1; i <= 14; i += 1) {
      await writeFile(join(reports, `doctor-20260901-${String(1000 + i)}.txt`), 'x');
    }
    const found = await findRemovable({ keepTag: 'b9999' });
    const names = found.map((f) => f.path.split(/[\\/]/).at(-1)).sort();
    assert.deepEqual(names, [
      'doctor-20260901-1001.txt', 'doctor-20260901-1002.txt', 'doctor-20260901-1003.txt',
      'doctor-20260901-1004.txt',
    ], `挙げたものが違う: ${names.join(', ')}`);
    assert.ok(found.every((f) => f.why.includes('古い doctor の記録')), JSON.stringify(found));
  });

  test('**記録に見えないものは触らない（対）**', async () => {
    const { home } = await scratch();
    const reports = join(home, 'reports');
    await mkdir(reports, { recursive: true });
    // 15 個置いても、名前の形が違えば対象にしない。
    for (let i = 1; i <= 15; i += 1) {
      await writeFile(join(reports, `メモ${i}.txt`), 'x');
      await writeFile(join(reports, `doctor-${i}.txt`), 'x');
    }
    assert.deepEqual(await findRemovable({ keepTag: 'b9999' }), [], '関係ないものを消そうとしている');
  });
});
