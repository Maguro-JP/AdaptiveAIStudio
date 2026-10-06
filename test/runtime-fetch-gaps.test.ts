/**
 * 74 回目の不具合調査（モデルを取ってくる・片づける所）の分。
 *
 * - HuggingFace のファイルの頁（`/blob/`）を貼られたら、ファイルそのもの（`/resolve/`）を取る
 * - 続きから取るときは、取れている分を差し引いて空きを見る
 * - clean は、設定や画面で選んだモデルの保存先の途中の分も挙げる
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { installModel, roomNeeded } from '../src/runtime/model-install.ts';
import { findRemovable } from '../src/runtime/cleanup.ts';
import type { CatalogEntry } from '../src/runtime/model-catalog.ts';

describe('取ってくる場所', () => {
  test('**HuggingFace のファイルの頁（/blob/）を貼られたら、/resolve/ を取りに行く**', async () => {
    const modelsDir = await tempDir('aas-models-');
    const asked: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      asked.push(String(url));
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    const entry = { id: 'x', repo: 'https://huggingface.co/a/b/blob/main/x.gguf', quant: 'Q4_K_M', ollama: '', approxGB: 0 } as unknown as CatalogEntry;
    await installModel({ entry, modelsDir, fetchImpl }).catch(() => undefined);
    assert.ok(asked.length > 0, '取りに行っていない');
    assert.ok(asked.every((u) => u.includes('/resolve/main/x.gguf') && !u.includes('/blob/')), `頁の HTML を取りに行った: ${asked.join(' / ')}`);
  });

  test('ほかの場所はそのまま（対）', async () => {
    const modelsDir = await tempDir('aas-models-');
    const asked: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      asked.push(String(url));
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    const entry = { id: 'x', repo: 'https://example.invalid/blob/x.gguf', quant: 'Q4_K_M', ollama: '', approxGB: 0 } as unknown as CatalogEntry;
    await installModel({ entry, modelsDir, fetchImpl }).catch(() => undefined);
    assert.deepEqual(asked, ['https://example.invalid/blob/x.gguf']);
  });
});

describe('続きから取るときの空き', () => {
  test('**取れている分を差し引く**（22GB のうち 20GB 取れていれば、要るのは残りの 2GB と少し）', () => {
    const GB = 1024 ** 3;
    const need = roomNeeded(22, 20 * GB);
    assert.ok(need < 3 * GB, `全体の大きさで見ている: ${(need / GB).toFixed(1)}GB`);
    assert.ok(need >= 2 * GB, `残りより少なく見ている: ${(need / GB).toFixed(1)}GB`);
    // 何も取れていなければ、これまでどおり全体に少し足したもの
    assert.ok(roomNeeded(22) > 22 * GB);
    // 全部取れている（416 で終わる回）なら、もう要らない
    assert.equal(roomNeeded(22, 23 * GB), 0);
  });
});

describe('clean が見る保存先', () => {
  test('**設定や画面で選んだ保存先の、途中で切れた分も挙げる**', async () => {
    const other = await tempDir('aas-other-models-');
    const part = join(other, 'x.gguf.part');
    await writeFile(part, 'x'.repeat(1000));
    const old = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    await utimes(part, old, old);
    const items = await findRemovable({ keepTag: 'b0', modelsDirs: [other, other] });
    const hits = items.filter((i) => i.path === part);
    assert.equal(hits.length, 1, `挙げていない（または二度挙げた）: ${items.map((i) => i.path).join(' / ')}`);
  });
});
