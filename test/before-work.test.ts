/**
 * 作業前の記録は、**外のツールがテストを消す前に**取る。
 *
 * テストの数を `changesFilesHere`（この場所のツール）の手前でだけ記録ていた。
 * 外のツール（MCP）が先にテストを消し、そのあと `write_file` を呼ぶと、
 * 記録した時点で既に減っているので、作業後に「減っていない」と読んでいた。
 *
 * ここでは本物のディレクトリで、消す → 書く、の順に通して見る。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BeforeWork } from '../src/agent/before-work.ts';
import { snapshotTests, compareTests, type TestSnapshot } from '../src/agent/test-integrity.ts';
import { EXTERNAL_SEPARATOR } from '../src/agent/tools/write-kind.ts';

const OUTSIDE = `notes${EXTERNAL_SEPARATOR}delete`;

/** 一つ上まで自分のもの（`/tmp` 直下を見ない）。 */
let home: string;
before(async () => { home = await mkdtemp(join(tmpdir(), 'aas-before-work-')); });
after(async () => { await rm(home, { recursive: true, force: true }); });

let n = 0;
async function workspace(): Promise<string> {
  n += 1;
  const root = join(home, `ws${n}`, 'project');
  await mkdir(join(root, 'test'), { recursive: true });
  await writeFile(join(root, 'test', 'a.test.ts'), "test('one', () => {});\ntest('two', () => {});\n");
  return root;
}

function probe(root: string, enabled = true): { work: BeforeWork<TestSnapshot>; measures: () => number } {
  let measures = 0;
  const work = new BeforeWork<TestSnapshot>({
    enabled,
    snapshot: () => snapshotTests(root),
    measure: async () => { measures += 1; },
  });
  return { work, measures: () => measures };
}

describe('作業前の記録', () => {
  test('外のツールがテストを消してから書いても、消したことが分かる', async () => {
    const root = await workspace();
    const { work } = probe(root);

    await work.atToolStart(OUTSIDE);
    await rm(join(root, 'test', 'a.test.ts'));        // 外のツールが消した
    await work.atToolStart('write_file');              // そのあと、この場所で書く

    assert.ok(work.measured, '書く手前で作業前の成否を測っていない');
    const verdict = compareTests(work.tests!, await snapshotTests(root));
    assert.equal(verdict.ok, false, '消されたテストを見逃している');
    assert.match(verdict.reason ?? '', /a\.test\.ts/);
  });

  test('外のツールの手前では、重い方（テストを走らせる）を取らない', async () => {
    const root = await workspace();
    const { work, measures } = probe(root);
    await work.atToolStart(OUTSIDE);
    assert.equal(measures(), 0, '外のツールの手前でテストを走らせている（1ターンが伸びる）');
    assert.equal(work.measured, false);
    assert.equal(work.tests?.totalCases, 2, '軽い方（数）は記録していない');
  });

  test('読むだけのツールでは、何も記録しない', async () => {
    const root = await workspace();
    const { work, measures } = probe(root);
    await work.atToolStart('read_file');
    assert.equal(work.tests, undefined);
    assert.equal(measures(), 0);
  });

  test('記録は一度だけ。後から増えたテストを「前」にしない', async () => {
    const root = await workspace();
    const { work, measures } = probe(root);
    await work.atToolStart('write_file');
    await writeFile(join(root, 'test', 'b.test.ts'), "test('three', () => {});\n");
    await work.atToolStart('edit_file');
    await work.atToolStart(OUTSIDE);
    assert.equal(measures(), 1);
    assert.equal(work.tests?.totalCases, 2);
  });

  test('確かめを切っているなら、何も記録しない', async () => {
    const root = await workspace();
    const { work, measures } = probe(root, false);
    await work.atToolStart(OUTSIDE);
    await work.atToolStart('write_file');
    assert.equal(work.tests, undefined);
    assert.equal(measures(), 0);
    assert.equal(work.measured, false);
  });
});
