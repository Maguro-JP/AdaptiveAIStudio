/**
 * 名前で引いて、そこへ飛ぶ。
 *
 * `find_code` は言葉から当てる道で、**名前がもう分かっているときには
 * 遠回り**になる。関数名を知っているのに、点数の高い順に 8 ファイル
 * 読まされて、その中に無ければ諦めることになる。
 *
 * 索引には名前と行が既に入っているので、引くだけで済む。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildIndex, lookupSymbol } from '../src/agent/code-index.ts';
import { tempDir } from './tmp.ts';

async function sample(): Promise<string> {
  const root = await tempDir('aas-sym-');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'),
    'export function saveConfig(x: string): void {\n  return void x;\n}\n'
    + 'function helper(): void {}\n');
  await writeFile(join(root, 'src', 'b.ts'),
    "import { saveConfig } from './a.ts';\nsaveConfig('x');\n");
  await writeFile(join(root, 'src', 'c.ts'), 'export const untouched = 1;\n');
  return root;
}

describe('名前で引く', () => {
  test('宣言の場所と、使っているファイルを返す', async () => {
    const index = await buildIndex(await sample());
    const got = lookupSymbol(index, 'saveConfig');
    assert.equal(got.defined.length, 1, JSON.stringify(got));
    assert.equal(got.defined[0]!.path, 'src/a.ts');
    assert.equal(got.defined[0]!.exported, true);
    assert.ok(got.defined[0]!.line >= 1);
    assert.deepEqual(got.used, ['src/b.ts']);
  });

  test('宣言している所を「使っている」に混ぜない', async () => {
    const index = await buildIndex(await sample());
    const got = lookupSymbol(index, 'saveConfig');
    assert.ok(!got.used.includes('src/a.ts'), '宣言した所が混ざっている');
  });

  test('大文字小文字が違っても当てる', async () => {
    const index = await buildIndex(await sample());
    const got = lookupSymbol(index, 'saveconfig');
    assert.equal(got.defined.length, 1, JSON.stringify(got));
  });

  test('**無いときは、近い名前を出す**', async () => {
    // 「無い」で終わると、打ち間違いなのか本当に無いのかが分からない。
    const index = await buildIndex(await sample());
    const got = lookupSymbol(index, 'saveConf');
    assert.equal(got.defined.length, 0);
    assert.ok(got.near.includes('saveConfig'), `近い名前が出ていない: ${got.near.join(',')}`);
  });

  test('**短い名前が何にでも当たらない**', async () => {
    /*
     * 最初は「含む」だけで見ていた。`loadConfg` と打ったのに出たのは
     * `load, on, lo` で、肝心の `loadConfig` は出なかった（含む関係に無い）。
     * 頭からどこまで同じかで見る形に直した。
     */
    const index = await buildIndex(await sample());
    const got = lookupSymbol(index, 'saveConf');
    assert.equal(got.near[0], 'saveConfig', `並び順が違う: ${got.near.join(',')}`);
    for (const n of got.near) {
      assert.ok(n.length >= 3, `短すぎる名前が混ざっている: ${n}`);
    }
  });

  test('文章に出てくるのは、使っているに数えない', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const root = await sample();
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'docs', 'note.md'), '# 覚え書き\n\nsaveConfig について。\n');
    const index = await buildIndex(root);
    const got = lookupSymbol(index, 'saveConfig');
    assert.ok(!got.used.some((p) => p.endsWith('.md')), `文章が混ざっている: ${got.used.join(',')}`);
  });

  test('本当に無いものは、近い名前も出さない（対）', async () => {
    const index = await buildIndex(await sample());
    const got = lookupSymbol(index, 'まったく関係のない名前');
    assert.deepEqual(got.defined, []);
    assert.deepEqual(got.near, []);
  });

  test('空の名前で、全部を返さない', async () => {
    const index = await buildIndex(await sample());
    assert.deepEqual(lookupSymbol(index, '   '), { defined: [], used: [], near: [] });
  });
});
