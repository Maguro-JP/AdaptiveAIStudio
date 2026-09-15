import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { tempDir } from './tmp.ts';
import { join } from 'node:path';
import { inspectDependencies, describeDependencies } from '../src/agent/dependencies.ts';

async function make(files: Record<string, string>): Promise<string> {
  const dir = await tempDir('aas-deps-');
  for (const [path, body] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, body, 'utf8');
  }
  return dir;
}

describe('手元を数える', () => {
  test('宣言と、実際に入っている版を突き合わせる', async () => {
    const root = await make({
      'package.json': JSON.stringify({
        dependencies: { alpha: '^1.0.0' },
        devDependencies: { beta: '~2.0.0' },
      }),
      'node_modules/alpha/package.json': JSON.stringify({ version: '1.4.2' }),
    });
    const r = await inspectDependencies(root);
    const alpha = r.deps.find((d) => d.name === 'alpha')!;
    const beta = r.deps.find((d) => d.name === 'beta')!;
    assert.equal(alpha.declared, '^1.0.0');
    assert.equal(alpha.installed, '1.4.2');
    assert.equal(alpha.dev, false);
    assert.equal(beta.dev, true);
    assert.equal(beta.installed, undefined, '入れていないことも事実として残す');
  });

  test('宣言が無くても落ちない', async () => {
    const r = await inspectDependencies(await make({ 'readme.md': 'hi' }));
    assert.deepEqual(r.deps, []);
    assert.equal(r.manifest, undefined);
    assert.ok(r.runtime.startsWith('node '));
  });

  test('壊れた package.json でも落ちない', async () => {
    const r = await inspectDependencies(await make({ 'package.json': '{壊れている' }));
    assert.deepEqual(r.deps, []);
  });

  test('要求している環境を拾う', async () => {
    const r = await inspectDependencies(await make({
      'package.json': JSON.stringify({ engines: { node: '>=22' } }),
    }));
    assert.deepEqual(r.engines, { node: '>=22' });
  });

  test('node 以外の宣言があることも見る', async () => {
    const r = await inspectDependencies(await make({
      'package.json': '{}', 'requirements.txt': 'flask', 'go.mod': 'module x',
    }));
    assert.deepEqual(r.others.sort(), ['go.mod', 'requirements.txt']);
  });

  test('壊れた node_modules は無視する', async () => {
    const root = await make({
      'package.json': JSON.stringify({ dependencies: { alpha: '^1.0.0' } }),
      'node_modules/alpha/package.json': 'これはJSONではない',
    });
    const r = await inspectDependencies(root);
    assert.equal(r.deps[0]!.installed, undefined);
  });
});

describe('外へ出る前の下書き', () => {
  const report = {
    manifest: 'package.json',
    runtime: 'node 22.0.0',
    engines: { node: '>=22' },
    others: [],
    deps: Array.from({ length: 20 }, (_, i) => ({
      name: `pkg${i}`, declared: '^1.0.0', installed: '1.0.0', dev: false,
    })),
  };

  test('数えた事実が入る', () => {
    const out = describeDependencies(report);
    assert.ok(out.includes('node 22.0.0'));
    assert.ok(out.includes('pkg0'));
    assert.ok(out.includes('>=22'));
  });

  test('長すぎる一覧は切る（文脈を食い潰さない）', () => {
    const out = describeDependencies(report, 5);
    assert.ok(out.includes('他 15 件'));
    assert.equal(out.includes('pkg9'), false);
  });

  test('どこへ訊きに行くかまで書く', () => {
    const out = describeDependencies(report);
    assert.ok(out.includes('registry.npmjs.org'));
    assert.ok(out.includes('osv.dev'));
  });

  test('一件だけ選べと言う。全部調べさせない', () => {
    const out = describeDependencies(report);
    assert.ok(out.includes('一つだけ'));
    assert.ok(out.includes('全部を調べようとしないこと'));
  });

  test('依存が無いときは、無いと言う', () => {
    const out = describeDependencies({ deps: [], runtime: 'node 22', others: [] });
    assert.ok(out.includes('見つかりませんでした'));
  });

  test('行き先は、外へ出る口が許している場所だけ', async () => {
    const { DEFAULT_ALLOWED_HOSTS } = await import('../src/agent/tools/network.ts');
    const out = describeDependencies(report);
    for (const m of out.matchAll(/https:\/\/([a-z0-9.-]+)/g)) {
      assert.ok(DEFAULT_ALLOWED_HOSTS.includes(m[1]!),
        `許可されていない行き先を勧めている: ${m[1]}`);
    }
  });
});
