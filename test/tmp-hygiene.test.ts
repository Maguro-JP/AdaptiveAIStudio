/**
 * 試験の仮の作業場は `tempDir`（`test/tmp.ts`）で作る。
 *
 * 試験が `mkdtemp` で直に作ると、片づける者がいない。一回走らせるごとに置き土産が残り、積もって 27,000 個・11 GB になり、
 * ディスクが一杯になって押す前の確かめそのものが落ちた（2026-10-06）。作る口を一つにして、片づけもそこで持つ。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './tmp.ts';

const here = dirname(fileURLToPath(import.meta.url));

/** 直に作ってよいもの。理由を書く。 */
const ALLOWED: Record<string, string> = {
  'tmp.ts': '作る口そのもの',
  'before-work.test.ts': '自分の after で消している（試験の前に一度だけ作る家）',
};

test('**試験は mkdtemp で仮の作業場を直に作らない**（tempDir を使う）', async () => {
  const bad: string[] = [];
  for (const f of await readdir(here)) {
    if (!f.endsWith('.ts') || Object.hasOwn(ALLOWED, f)) continue;
    const text = await readFile(join(here, f), 'utf8');
    text.split('\n').forEach((line, i) => {
      if (/\bmkdtemp(Sync)?\s*\(/.test(line) && !/^\s*(\/\/|\*)/.test(line)) bad.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(bad, [], `tempDir（test/tmp.ts）で作ってください: ${bad.join(', ')}`);
});

test('**試験の中で後から読み込んでも（`await import`）、作った場所は終わりに片づく**', async () => {
  // `after` は読み込んだ時点の試験に付くので、後から読み込むと一度も走らず、作った場所が残り続けた
  const { writeFile, stat } = await import('node:fs/promises');
  const { spawnSync } = await import('node:child_process');
  const { pathToFileURL } = await import('node:url');
  const { needsStripFlag } = await import('../src/core/node-flags.ts');
  // 子の試験ファイルを置く場所（これ自体は、ここで消す）
  const box = await tempDir('aas-hygiene-probe-');
  {
    const marker = join(box, 'made.txt');
    const tmpUrl = pathToFileURL(join(here, 'tmp.ts')).href;
    await writeFile(join(box, 'child.test.ts'), [
      "import { test } from 'node:test';",
      "import { writeFileSync } from 'node:fs';",
      // 先の試験で読み込み（ここで片づけがこの試験に付く）、後の試験で作る。window.test.ts で実際に残った形
      `test('first', async () => { await import(${JSON.stringify(tmpUrl)}); });`,
      "test('late', async () => {",
      `  const { tempDir } = await import(${JSON.stringify(tmpUrl)});`,
      "  const d = await tempDir('aas-hygiene-late-');",
      `  writeFileSync(${JSON.stringify(marker)}, d);`,
      '});',
    ].join('\n'));
    const flags = needsStripFlag(process.versions.node) ? ['--experimental-strip-types'] : [];
    // 親の試験の環境変数（NODE_TEST_CONTEXT）を子へ渡さない。渡すと子は自分で試験を走らせず、親へ結果を返す形になる
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, [...flags, '--no-warnings', '--test', join(box, 'child.test.ts')], { encoding: 'utf8', env });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const made = (await readFile(marker, 'utf8')).trim();
    assert.ok(made.includes('aas-hygiene-late-'), made);
    const left = await stat(made).then(() => true, () => false);
    assert.equal(left, false, `後から読み込んだ試験の作業場が残った: ${made}`);
  }
});

test('**片づけた後に、後の `after`（サーバーの止め際の保存）が作り直しても、終わりに片づく**', async () => {
  const { writeFile, stat } = await import('node:fs/promises');
  const { spawnSync } = await import('node:child_process');
  const { pathToFileURL } = await import('node:url');
  const { needsStripFlag } = await import('../src/core/node-flags.ts');
  const box = await tempDir('aas-hygiene-probe-');
  const marker = join(box, 'made.txt');
  const tmpUrl = pathToFileURL(join(here, 'tmp.ts')).href;
  await writeFile(join(box, 'child.test.ts'), [
    "import { test, after } from 'node:test';",
    "import { writeFileSync, mkdirSync } from 'node:fs';",
    "import { join } from 'node:path';",
    `import { tempDir } from ${JSON.stringify(tmpUrl)};`,
    'let dir = "";',
    // tmp.ts の after より後に走る。止め際の保存と同じく、同じ場所を作り直して書く
    "after(() => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'idle.json'), '{}'); });",
    "test('make', async () => {",
    "  dir = await tempDir('aas-hygiene-rewrite-');",
    `  writeFileSync(${JSON.stringify(marker)}, dir);`,
    '});',
  ].join('\n'));
  const flags = needsStripFlag(process.versions.node) ? ['--experimental-strip-types'] : [];
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, [...flags, '--no-warnings', '--test', join(box, 'child.test.ts')], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const made = (await readFile(marker, 'utf8')).trim();
  assert.equal(await stat(made).then(() => true, () => false), false, `作り直された作業場が残った: ${made}`);
});
