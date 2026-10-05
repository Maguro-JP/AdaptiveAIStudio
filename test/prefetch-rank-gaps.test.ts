/**
 * 先読み・並べ替え・数え方・歩幅の記録の不具合（40 回目の調査）。
 *
 * - 先読みのファイル一覧は、索引と同じ場所を飛ばし、`.gitignore` も見る（venv の中身を「手掛かり」にしない）
 * - 本文での並べ替えは、別の作業場の同じ道の本文を使わない
 * - GGUF の数え方は、同じ道の別のモデルに替わったら読み直す。一度読めなかったことを、ずっと覚えない
 * - 歩幅の記録は、`__proto__` という名前のモデルも落とさない
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { Prefetcher } from '../src/agent/prefetch.ts';
import { rerankByBody } from '../src/agent/rerank.ts';
import { counterForGguf } from '../src/agent/tokenizer.ts';
import { StrideBook } from '../src/agent/stride.ts';
import type { CodeIndex } from '../src/agent/code-index.ts';

async function project(files: Record<string, string>): Promise<string> {
  const root = await tempDir('aas-prg-');
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(root, name, '..'), { recursive: true });
    await writeFile(join(root, name), content);
  }
  return root;
}

describe('先読みのファイル一覧', () => {
  test('**索引と同じ場所（venv・vendor・coverage など）を飛ばし、.gitignore に書かれたものも入れない**', async () => {
    const root = await project({
      'src/a.py': 'x = 1\n',
      'venv/lib/six.py': 'y = 2\n',
      'vendor/lib.js': 'z\n',
      'coverage/out.json': '{}\n',
      'gen/made.ts': 'made\n',
      '.gitignore': 'gen/\n',
    });
    const p = new Prefetcher(root, undefined, () => true);
    p.start();
    const snap = (await p.snapshot())!;
    assert.ok(snap.files.includes('src/a.py'), snap.files.join(','));
    for (const out of ['venv/', 'vendor/', 'coverage/', 'gen/']) {
      assert.equal(snap.files.some((f) => f.startsWith(out)), false, `${out} を一覧に入れた: ${snap.files.join(',')}`);
    }
  });
});

describe('本文での並べ替え', () => {
  test('**別の作業場の同じ道の本文を、取り違えて使わない**', async () => {
    const a = await project({ 'a.ts': 'alpha alpha\n' });
    const b = await project({ 'a.ts': 'beta beta\n' });
    const builtAt = '2026-10-05T00:00:00.000Z';
    const index = (root: string) => ({ root, builtAt, files: [{ path: 'a.ts' }] }) as unknown as CodeIndex;
    const seed = () => new Map([[0, 1]]);
    await rerankByBody(index(a), 'alpha', seed(), 1);
    const got = await rerankByBody(index(b), 'beta', seed(), 1);
    assert.ok((got.get(0) ?? 0) > 1, `b の本文の beta を見ていない: ${JSON.stringify([...got])}`);
  });
});

describe('GGUF の数え方の覚え方', () => {
  test('**一度読めなかったことを、ずっと覚えない**', async () => {
    const dir = await tempDir('aas-prg-gguf-');
    const path = join(dir, 'm.gguf');
    await writeFile(path, 'x');
    let calls = 0;
    const read = async () => { calls += 1; if (calls === 1) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return { metadata: new Map<string, unknown>() }; };
    await counterForGguf(path, read);
    await counterForGguf(path, read);
    assert.equal(calls, 2, '読めなかった一度目を覚えて、二度目を読みに行かなかった');
  });

  test('**同じ道のファイルが替わったら、読み直す。替わっていなければ読み直さない**', async () => {
    const dir = await tempDir('aas-prg-gguf2-');
    const path = join(dir, 'm.gguf');
    await writeFile(path, 'one');
    let calls = 0;
    const read = async () => { calls += 1; return { metadata: new Map<string, unknown>() }; };
    await counterForGguf(path, read);
    await counterForGguf(path, read);
    assert.equal(calls, 1, '替わっていないのに読み直した');
    await writeFile(path, 'another model');
    await counterForGguf(path, read);
    assert.equal(calls, 2, '替わったのに前の数え方を使い続けた');
  });
});

describe('歩幅の記録', () => {
  test('**__proto__ という名前のモデルの記録も落とさない**', async () => {
    const dir = await tempDir('aas-prg-stride-');
    const book = new StrideBook(join(dir, 'stride.json'));
    const made = await book.record('__proto__', 8192, true);
    const got = await book.get('__proto__', 8192);
    assert.deepEqual(got, made);
    assert.ok(Object.hasOwn(await book.all(), '__proto__'));
    // 読み直しても残る
    const again = new StrideBook(join(dir, 'stride.json'));
    assert.deepEqual(await again.get('__proto__', 8192), made);
  });
});
