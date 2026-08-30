/**
 * 先読みの検証。
 * 待機中に状況把握を済ませ、依頼が来た瞬間に渡せることを確認する。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { tempDir } from './tmp.ts';
import { join } from 'node:path';
import { Prefetcher, describeSnapshot, type PrefetchEvent } from '../src/agent/prefetch.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function project(files: Record<string, string> = {}): Promise<string> {
  const root = await tempDir('aas-pf-');
  for (const [name, content] of Object.entries(files)) {
    const abs = join(root, name);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, content);
  }
  return root;
}

describe('先読み', () => {
  test('起動直後は待たずに戻り、裏で構築される', async () => {
    const root = await project({ 'a.ts': 'x', 'src/b.ts': 'y' });
    const p = new Prefetcher(root);

    const t = Date.now();
    p.start();
    assert.ok(Date.now() - t < 10, 'start が待っている');

    const snap = await p.snapshot();
    assert.ok(snap);
    assert.ok(snap.files.includes('a.ts'));
    assert.ok(snap.files.includes('src/b.ts'));
  });

  test('完了後の取得は即座に返る', async () => {
    const root = await project({ 'a.ts': 'x' });
    const p = new Prefetcher(root);
    p.start();
    await p.snapshot();

    const t = Date.now();
    const again = await p.snapshot();
    assert.ok(Date.now() - t < 5, '2回目に待ちが発生している');
    assert.ok(again);
  });

  test('peek は完了前なら undefined を返す（待たない）', async () => {
    const root = await project({ 'a.ts': 'x' });
    const p = new Prefetcher(root);
    assert.equal(p.peek(), undefined);
    p.start();
    await p.snapshot();
    assert.ok(p.peek());
  });

  test('start していなければ snapshot は undefined', async () => {
    const root = await project();
    assert.equal(await new Prefetcher(root).snapshot(), undefined);
  });

  test('node_modules などは索引しない', async () => {
    const root = await project({
      'a.ts': 'x',
      'node_modules/junk.js': 'noise',
      'dist/out.js': 'built',
    });
    const p = new Prefetcher(root);
    p.start();
    const snap = (await p.snapshot())!;
    assert.ok(snap.files.includes('a.ts'));
    assert.equal(snap.files.some((f) => f.includes('node_modules')), false);
    assert.equal(snap.files.some((f) => f.includes('dist/')), false);
  });

  test('package.json からテストコマンドを推定する', async () => {
    const root = await project({
      'package.json': JSON.stringify({ scripts: { test: 'vitest', build: 'tsc' } }),
    });
    const p = new Prefetcher(root);
    p.start();
    const snap = (await p.snapshot())!;
    assert.equal(snap.kind, 'Node.js');
    assert.equal(snap.commands.test, 'npm test');
    assert.equal(snap.commands.build, 'npm run build');
    assert.equal(snap.commands.lint, undefined);
  });

  test('壊れた package.json でも他の検出は続く', async () => {
    const root = await project({ 'package.json': '{ broken', 'a.ts': 'x' });
    const p = new Prefetcher(root);
    p.start();
    const snap = (await p.snapshot())!;
    assert.equal(snap.kind, 'Node.js');
    assert.ok(snap.files.includes('a.ts'));
  });

  test('他の言語のプロジェクトも判別する', async () => {
    for (const [file, kind, testCmd] of [
      ['Cargo.toml', 'Rust', 'cargo test'],
      ['go.mod', 'Go', 'go test ./...'],
      ['pyproject.toml', 'Python', 'pytest'],
    ] as const) {
      const root = await project({ [file]: '' });
      const p = new Prefetcher(root);
      p.start();
      const snap = (await p.snapshot())!;
      assert.equal(snap.kind, kind);
      assert.equal(snap.commands.test, testCmd);
    }
  });

  test('直近に更新されたファイルが新しい順に並ぶ', async () => {
    const root = await project({ 'old.ts': 'x' });
    await sleep(20);
    await writeFile(join(root, 'new.ts'), 'y');

    const p = new Prefetcher(root);
    p.start();
    const snap = (await p.snapshot())!;
    assert.equal(snap.recentFiles[0]?.path, 'new.ts');
  });

  test('読めないディレクトリでも落ちず、空の結果を返す', async () => {
    const p = new Prefetcher('/nonexistent/project');
    p.start();
    const snap = await p.snapshot();
    assert.ok(snap, '先読みの失敗で undefined になっている');
    assert.deepEqual(snap.files, []);
  });

  test('invalidate すると作り直される', async () => {
    const root = await project({ 'a.ts': 'x' });
    const p = new Prefetcher(root);
    p.start();
    const first = (await p.snapshot())!;

    await writeFile(join(root, 'b.ts'), 'z');
    p.invalidate();
    const second = (await p.snapshot())!;

    assert.equal(first.files.includes('b.ts'), false);
    assert.ok(second.files.includes('b.ts'), '作り直されていない');
  });

  test('進捗イベントが届く', async () => {
    const root = await project({ 'a.ts': 'x' });
    const events: PrefetchEvent[] = [];
    const p = new Prefetcher(root, (e) => events.push(e));
    p.start();
    await p.snapshot();
    assert.ok(events.some((e) => e.type === 'start' && e.task === 'index'));
    assert.ok(events.some((e) => e.type === 'done' && e.task === 'commands'));
  });
});

describe('要約', () => {
  test('着手に必要な情報が含まれる', async () => {
    const root = await project({
      'package.json': JSON.stringify({ scripts: { test: 'vitest' } }),
      'src/app.ts': 'x',
    });
    const p = new Prefetcher(root);
    p.start();
    const text = describeSnapshot((await p.snapshot())!);

    assert.match(text, /Node\.js/);
    assert.match(text, /npm test/);
    assert.match(text, /src\/app\.ts/);
    assert.match(text, /調べ直す必要はありません/);
  });

  test('何も取得できていなければ空文字（余計な指示を混ぜない）', () => {
    assert.equal(describeSnapshot({
      files: [], recentFiles: [], commands: {}, builtAt: Date.now(), ready: [],
    }), '');
  });
});

describe('上限つきの待機', () => {
  test('構築中でも完成すれば返る', async () => {
    const root = await project({ 'a.ts': 'x' });
    const p = new Prefetcher(root);
    p.start();
    // peek はまだ undefined でも、少し待てば取れる
    assert.equal(p.peek(), undefined);
    const snap = await p.snapshotWithin(3000);
    assert.ok(snap, '待っても取れていない');
    assert.ok(snap.files.includes('a.ts'));
  });

  test('上限を超えたら諦める（依頼を待たせない）', async () => {
    const root = await project({ 'a.ts': 'x' });
    const p = new Prefetcher(root);
    p.start();
    const t = Date.now();
    await p.snapshotWithin(1);
    assert.ok(Date.now() - t < 60, `上限を超えて待っている: ${Date.now() - t}ms`);
  });

  test('諦めた後も裏で構築は続き、次回は使える', async () => {
    const root = await project({ 'a.ts': 'x' });
    const p = new Prefetcher(root);
    p.start();
    await p.snapshotWithin(1);
    const later = await p.snapshotWithin(3000);
    assert.ok(later?.files.includes('a.ts'));
  });

  test('start していなければ待たずに undefined', async () => {
    const root = await project();
    const t = Date.now();
    assert.equal(await new Prefetcher(root).snapshotWithin(5000), undefined);
    assert.ok(Date.now() - t < 50);
  });
});
