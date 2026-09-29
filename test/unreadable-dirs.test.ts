/**
 * フォルダの中を見られない・ファイルを見られないのを、「空」「無い」「変わらない」と取り違えない。
 *
 *   ・会話の捨て場（trash/）を見られないと、消した後に来た書き足しを元の場所へ書いて切れ端の会話を作り、
 *     戻すときは本物が在るのに「もう無い」と返していた
 *   ・戻り先のフォルダを見られないと、「その戻り先はもう無い」と言っていた
 *   ・作業場の記録で、前後とも見られないファイルを「変わらない」と数え、外のツールが書いた回を確かめずに済ませていた
 *   ・テストを減らさない規則が、読めないテストファイルを「新しいファイル」と読んで素通しにしていた
 *
 * 読めなさは fs/promises の関数をその道だけ失敗させて作る（権限に頼らない。root でも同じ結果になる）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, readdir as listDir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tempDir } from './tmp.ts';
import { Conversations } from '../src/core/conversations.ts';
import { UndoStore } from '../src/core/undo.ts';
import { workspaceStamp, stampChanges } from '../src/agent/workspace-stamp.ts';
import { testProtection } from '../src/harness/builtin-rules.ts';

const require = createRequire(import.meta.url);
const fsp = require('node:fs/promises') as typeof import('node:fs/promises');

/** fs/promises の `name` を、`path` のときだけ EACCES で失敗させて `fn` を回す。 */
async function failing<T>(name: 'readFile' | 'readdir' | 'stat', path: string, fn: () => Promise<T>): Promise<T> {
  const real = fsp[name] as (...a: unknown[]) => Promise<unknown>;
  (fsp as Record<string, unknown>)[name] = ((p: unknown, ...rest: unknown[]) => p === path
    ? Promise.reject(Object.assign(new Error(`EACCES: ${name} failed`), { code: 'EACCES' }))
    : real(p, ...rest)) as never;
  syncBuiltinESMExports();
  try {
    return await fn();
  } finally {
    (fsp as Record<string, unknown>)[name] = real;
    syncBuiltinESMExports();
  }
}

describe('会話の捨て場を見られないとき', () => {
  test('消した後に来た書き足しで、元の場所に切れ端の会話を作らない', async () => {
    const dir = join(await tempDir('aas-trash-unreadable-'), 'conv');
    const c = new Conversations(dir);
    const { id } = await c.create();
    await c.remove(id);
    await assert.rejects(failing('readdir', join(dir, 'trash'), () => c.append(id, [{ role: 'user', content: '遅れて届いた' }])));
    assert.deepEqual((await listDir(dir)).filter((n) => n.endsWith('.jsonl')), [], '見出しの無い切れ端の会話を作った');
  });

  test('戻すとき、本物が在るのに「もう無い」と返さない', async () => {
    const dir = join(await tempDir('aas-trash-unreadable-restore-'), 'conv');
    const c = new Conversations(dir);
    const { id } = await c.create();
    await c.remove(id);
    await assert.rejects(failing('readdir', join(dir, 'trash'), () => c.restore(id)));
    assert.deepEqual(await c.restore(id), { id }, '読めるようになっても戻せない');
  });

  test('まだ一度も消していない（捨て場が無い）ときは、今までどおり書き足せる', async () => {
    const dir = join(await tempDir('aas-trash-absent-'), 'conv');
    const c = new Conversations(dir);
    await c.append('c-new', [{ role: 'user', content: 'はじめて' }]);
    assert.ok((await listDir(dir)).includes('c-new.jsonl'));
  });
});

describe('戻り先のフォルダを見られないとき', () => {
  test('「もう無い」ではなく「読めない」と言う', async () => {
    const root = await tempDir('aas-undo-dir-unreadable-');
    const state = await tempDir('aas-undo-dir-unreadable-state-');
    const dir = join(state, 'undo');
    const undo = new UndoStore(root, dir);
    await writeFile(join(root, 'a.txt'), 'v1\n');
    await undo.begin('一回目');
    undo.capture('a.txt', 'v1\n');
    await writeFile(join(root, 'a.txt'), 'v2\n');
    const point = (await undo.end())!;
    await assert.rejects(failing('readdir', dir, () => undo.restore(point.id)), /戻り先のフォルダを読めません/);
  });

  test('フォルダがまだ無いときは、今までどおり空の一覧', async () => {
    const root = await tempDir('aas-undo-dir-absent-');
    const undo = new UndoStore(root, join(await tempDir('aas-undo-dir-absent-state-'), 'undo'));
    assert.deepEqual(await undo.list(), []);
  });
});

describe('作業場の記録で見られないファイル', () => {
  test('前後とも見られなくても、「変わらない」と数えない', async () => {
    const root = join(await tempDir('aas-stamp-unreadable-'), 'repo');
    await mkdir(root, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
    await writeFile(join(root, 'new.txt'), 'a\n');
    const abs = join(root, 'new.txt');
    const before = await failing('stat', abs, () => workspaceStamp(root));
    const after = await failing('stat', abs, () => workspaceStamp(root));
    assert.ok(before && after);
    assert.deepEqual(stampChanges(before, after), ['new.txt'], '見られないのを「変わらない」と読んだ');
  });
});

describe('テストを減らさない規則で読めないテストファイル', () => {
  test('新しいファイルと読んで素通しにしない', async () => {
    const root = await tempDir('aas-protect-unreadable-');
    await mkdir(join(root, 'test'), { recursive: true });
    const abs = join(root, 'test', 'x.test.ts');
    await writeFile(abs, "test('あ', () => {});\ntest('い', () => {});\n");
    const r = await failing('readFile', abs, async () => testProtection.pre!(
      { id: '1', name: 'write_file', args: { path: 'test/x.test.ts', content: "test('あ', () => {});\n" } },
      { root, history: [], instruction: '' } as never,
    ));
    assert.equal(r.kind, 'deny', `読めないテストファイルへの書き込みを素通しにした: ${JSON.stringify(r)}`);
  });

  test('本当に新しいテストファイルは、今までどおり通す', async () => {
    const root = await tempDir('aas-protect-new-');
    const r = await testProtection.pre!(
      { id: '1', name: 'write_file', args: { path: 'test/y.test.ts', content: "test('う', () => {});\n" } },
      { root, history: [], instruction: '' } as never,
    );
    assert.equal(r.kind, 'allow');
  });
});
