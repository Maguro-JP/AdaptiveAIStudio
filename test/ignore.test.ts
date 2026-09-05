/**
 * `.gitignore` を見るところの検査。
 *
 * ここまで、見ない場所は名前の決め打ちだった。決め打ちなので、
 * その置き場が実際に何を無視しているかとは関係が無く、生成物が索引に入り、
 * 窓を食い、直す先を間違えていた。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { Ignores, parseIgnore } from '../src/agent/ignore.ts';

describe('書き方を読む', () => {
  test('注釈と空行は捨てる', () => {
    assert.equal(parseIgnore('# メモ\n\n   \nbuild\n').length, 1);
  });

  test('打ち消しは、後の行が勝つ', () => {
    assert.equal(parseIgnore('*.log\n!keep.log').length, 2);
  });
});

/** 実物と同じ道（ディスクに置いて読む）で確かめる。 */
async function place(files: Record<string, string>): Promise<{ dir: string; ign: Ignores }> {
  const dir = await tempDir('aas-ignore-');
  for (const [rel, body] of Object.entries(files)) {
    const path = join(dir, rel);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, body);
  }
  return { dir, ign: await Ignores.load(dir) };
}

describe('見ない場所を決める', () => {
  test('名前だけ書けば、どの深さでも当たる', async () => {
    const { ign } = await place({ '.gitignore': 'build\n*.log\n' });
    assert.equal(ign.ignores('build', true), true);
    assert.equal(ign.ignores('src/build', true), true);
    assert.equal(ign.ignores('a/b/x.log', false), true);
    assert.equal(ign.ignores('src/main.ts', false), false);
  });

  test('先頭の / は、その場所の直下だけ', async () => {
    const { ign } = await place({ '.gitignore': '/build\n' });
    assert.equal(ign.ignores('build', true), true);
    assert.equal(ign.ignores('src/build', true), false, '深い所まで消している');
  });

  test('末尾の / は、ディレクトリだけ', async () => {
    const { ign } = await place({ '.gitignore': 'dist/\n' });
    assert.equal(ign.ignores('dist', true), true);
    assert.equal(ign.ignores('dist', false), false, 'ファイルまで消している');
  });

  test('消したものの下は、全部消える', async () => {
    const { ign } = await place({ '.gitignore': 'build\n' });
    assert.equal(ign.ignores('build/a/b.ts', false), true);
  });

  test('打ち消せる。**後の行が勝つ**', async () => {
    const { ign } = await place({ '.gitignore': '*.log\n!keep.log\n' });
    assert.equal(ign.ignores('a.log', false), true);
    assert.equal(ign.ignores('keep.log', false), false, '打ち消しが効いていない');
  });

  test('** は深さをまたぐ', async () => {
    const { ign } = await place({ '.gitignore': 'a/**/c\n' });
    assert.equal(ign.ignores('a/c', true), true);
    assert.equal(ign.ignores('a/b/c', true), true);
    assert.equal(ign.ignores('a/b/b2/c', true), true);
  });

  test('* は / を跨がない', async () => {
    const { ign } = await place({ '.gitignore': 'a/*.ts\n' });
    assert.equal(ign.ignores('a/x.ts', false), true);
    assert.equal(ign.ignores('a/b/x.ts', false), false, '深い所まで当てている');
  });

  test('下の階に置いた決まりは、そこから下にだけ効く', async () => {
    const { ign } = await place({ '.gitignore': '', 'web/.gitignore': 'out\n' });
    const web = await ign.enter('web');
    assert.equal(web.ignores('web/out', true), true);
    assert.equal(ign.ignores('out', true), false, '上の階まで効いている');
  });

  test('無ければ、何も消さない', async () => {
    const { ign } = await place({ 'a.ts': 'x' });
    assert.equal(ign.ignores('a.ts', false), false);
    assert.equal(ign.ignores('node_modules', true), false, '書いていないものを消している');
  });
});

/**
 * 読めることと、実際に見なくなることは別。
 * **道具と索引の両方で、確かめる。**
 */
describe('道具も索引も、見なくなる', () => {
  test('list_files と search_text から消える', async () => {
    const { listFilesTool, searchTextTool } = await import('../src/agent/tools/fs.ts');
    const dir = await tempDir('aas-ignore-tools-');
    await mkdir(join(dir, 'out'), { recursive: true });
    await writeFile(join(dir, '.gitignore'), 'out\n*.generated.ts\n');
    await writeFile(join(dir, 'main.ts'), 'const 目印 = 1;\n');
    await writeFile(join(dir, 'x.generated.ts'), 'const 目印 = 2;\n');
    await writeFile(join(dir, 'out', 'bundle.ts'), 'const 目印 = 3;\n');

    const ctx = { root: dir, signal: new AbortController().signal } as never;
    const list = await listFilesTool.run({}, ctx);
    assert.ok(list.content.includes('main.ts'), '要るものが消えている');
    assert.ok(!list.content.includes('generated'), '無視するものが出ている');
    assert.ok(!list.content.includes('bundle'), '無視するディレクトリが出ている');

    const found = await searchTextTool.run({ query: '目印' }, ctx);
    assert.ok(found.content.includes('main.ts'));
    assert.ok(!found.content.includes('generated'), '検索に無視するものが出ている');
    assert.ok(!found.content.includes('bundle'));
  });

  test('索引にも入らない', async () => {
    const { buildIndex } = await import('../src/agent/code-index.ts');
    const dir = await tempDir('aas-ignore-index-');
    await mkdir(join(dir, 'gen'), { recursive: true });
    await writeFile(join(dir, '.gitignore'), 'gen\n');
    await writeFile(join(dir, 'main.ts'), 'export function 本物() {}\n');
    await writeFile(join(dir, 'gen', 'auto.ts'), 'export function 生成物() {}\n');
    const index = await buildIndex(dir);
    const paths = index.files.map((f) => f.path);
    assert.ok(paths.includes('main.ts'));
    assert.ok(!paths.some((p) => p.startsWith('gen/')), `生成物が索引に入っている: ${paths.join(', ')}`);
  });
});
