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
    await writeFile(join(models, 'qwen2.5-3b-instruct-q4_k_m.gguf'), 'x');
    await writeFile(join(models, 'よその.GGUF'), 'x');
    const found = await findRemovable({ keepTag: 'b9999' });
    assert.deepEqual(found.map((f) => f.path), [], 'モデルを消そうとしている');
  });

  test('途中で切れた取得は消す', async () => {
    const { models } = await scratch();
    await writeFile(join(models, 'm.gguf.part'), 'x');
    await writeFile(join(models, 'm.gguf'), 'x');
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
});
