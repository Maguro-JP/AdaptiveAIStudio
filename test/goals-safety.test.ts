/**
 * 段取りの記録で、段取りを取り違える・数え落とす・一覧ごと止まる・溜まり続ける形を止める。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, appendFile, writeFile, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { createRequire, syncBuiltinESMExports } from 'node:module';
const require = createRequire(import.meta.url);
import { Goals, COMPACT_AFTER_LINES } from '../src/core/goals.ts';

async function goals(name: string) {
  const dir = await tempDir(`aas-goals-${name}-`);
  const path = join(dir, 'goals.jsonl');
  return { g: new Goals(path), path, dir };
}

describe('段取りの記録', () => {
  test('**同じミリ秒に二つ立てても、名前がぶつからない**', async () => {
    const { g } = await goals('same-ms');
    const at = 1_800_000_000_000;
    // 乱数 2 桁（1296 通り）のままなら、200 件でほぼ必ずぶつかる（50 件では 6 割でしか落ちなかった）。
    const made = await Promise.all(Array.from({ length: 200 }, (_, i) => g.open(`依頼 ${i}`, ['読む'], at)));
    assert.equal(new Set(made.map((x) => x.id)).size, 200, '名前がぶつかった');
    assert.equal((await g.list()).length, 200, '後の段取りが前のものを置き換えた');
  });

  test('**形の違う行（null・goal の無い行・steps の無い段取り）で、一覧ごと止まらない**', async () => {
    const { g, path } = await goals('shape');
    const goal = await g.open('依頼', ['読む', '直す']);
    await appendFile(path, 'null\n{"t":"goal"}\n{"t":"goal","goal":{"id":"x","request":"r","createdAt":"2026"}}\n{"t":"state","goalId":"' + goal.id + '"}\n');
    const list = await g.list();
    assert.deepEqual(list.map((x) => x.id), [goal.id]);
    assert.equal((await g.next(goal.id))?.instruction, '読む');
  });

  test('**同じ段が並んで二回落ちたら、二回と数える**', async () => {
    const { g } = await goals('fail-race');
    const goal = await g.open('依頼', ['直す']);
    const step = goal.steps[0]!;
    const [a, b] = await Promise.all([g.fail(goal.id, step.id), g.fail(goal.id, step.id)]);
    assert.deepEqual([a.attempts, b.attempts].sort(), [1, 2], '並んだ二回を一回と数えた');
    const now = (await g.list())[0]!.steps[0]!;
    assert.equal(now.attempts, 2);
  });

  test('**閉じた段取りが溜まったら、開いているものだけで畳む。割り直しと状態は残す**', async () => {
    const { g, path } = await goals('compact');
    const keep = await g.open('残す依頼', ['読む', '直す', '確かめる']);
    await g.succeed(keep.id, keep.steps[0]!.id);
    await g.fail(keep.id, keep.steps[1]!.id);
    await g.fail(keep.id, keep.steps[1]!.id);
    await g.split(keep.id, keep.steps[1]!.id, ['型を見る', '一行直す']);
    const before = (await g.list()).find((x) => x.id === keep.id)!;
    // 閉じた段取りの行を、畳む行数を超えるまで積む。
    const lines: string[] = [];
    for (let i = 0; lines.length <= COMPACT_AFTER_LINES; i += 1) {
      const id = `gold${i}`;
      lines.push(JSON.stringify({ t: 'goal', goal: { id, request: `古い ${i}`, createdAt: new Date(i).toISOString(), steps: [] } }));
      lines.push(JSON.stringify({ t: 'close', goalId: id }));
    }
    await appendFile(path, `${lines.join('\n')}\n`);
    const ino = (await stat(path)).ino;
    const added = await g.open('新しい依頼', ['読む']);
    const text = await readFile(path, 'utf8');
    assert.ok(text.trim().split('\n').length <= 2, `畳んでいない: ${text.trim().split('\n').length} 行`);
    assert.notEqual((await stat(path)).ino, ino, 'その場で上書きした（一時ファイルから置き換えていない）');
    assert.ok((await readdir(join(path, '..'))).every((n) => !n.endsWith('.tmp')), '一時ファイルが残った');
    const after = await g.list();
    assert.deepEqual(after.map((x) => x.id), [keep.id, added.id]);
    assert.deepEqual(after[0], before, '畳んだら、割り直しか状態が変わった');
    assert.equal((await g.next(keep.id))?.instruction, '型を見る');
  });

  test('**知らない状態・負の回数の行で、段取りを「終えた」にしない**', async () => {
    const { g, path } = await goals('state-value');
    const goal = await g.open('依頼', ['直す']);
    const stepId = goal.steps[0]!.id;
    await appendFile(path, [
      { t: 'state', goalId: goal.id, stepId, state: 'DONE', attempts: 0 },
      { t: 'state', goalId: goal.id, stepId, state: 'split', attempts: 0 },
      { t: 'state', goalId: goal.id, stepId, state: 'pending', attempts: -5 },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n');
    assert.equal((await g.next(goal.id))?.id, stepId, '壊れた行で、手を付ける段が無くなった');
    assert.equal((await g.list())[0]!.steps[0]!.attempts, 0);
  });

  test('**畳めなくても、立てた段取りは立てたとして返す**', async () => {
    const { g, path } = await goals('compact-fails');
    const lines: string[] = [];
    for (let i = 0; lines.length <= COMPACT_AFTER_LINES; i += 1) {
      lines.push(JSON.stringify({ t: 'goal', goal: { id: `gold${i}`, request: `古い ${i}`, createdAt: new Date(i).toISOString(), steps: [] } }));
      lines.push(JSON.stringify({ t: 'close', goalId: `gold${i}` }));
    }
    await writeFile(path, `${lines.join('\n')}\n`);
    const fsp = require('node:fs/promises') as typeof import('node:fs/promises');
    const real = fsp.rename;
    (fsp as { rename: unknown }).rename = () => Promise.reject(Object.assign(new Error('busy'), { code: 'EPERM' }));
    syncBuiltinESMExports();
    let made;
    try {
      made = await g.open('新しい依頼', ['読む']);
    } finally {
      (fsp as { rename: unknown }).rename = real;
      syncBuiltinESMExports();
    }
    assert.ok((await g.list()).some((x) => x.id === made.id), '立てた段取りが無い');
    assert.ok((await readdir(join(path, '..'))).every((n) => !n.endsWith('.tmp')), '一時ファイルが残った');
  });

  test('**元の依頼がもうやり残しに無い段取りを閉じる。在るものは残す**', async () => {
    const { g } = await goals('retain');
    const keep = await g.open('続ける依頼', ['読む']);
    await g.open('取り消した依頼', ['読む']);
    assert.equal(await g.retain(new Set(['続ける依頼'])), 1);
    assert.deepEqual((await g.list()).map((x) => x.id), [keep.id]);
    assert.equal(await g.retain(new Set(['続ける依頼'])), 0, '二度目に閉じるものは無い');
  });

  test('畳む行数までは畳まない（対）', async () => {
    const { g, path } = await goals('no-compact');
    await writeFile(path, `${JSON.stringify({ t: 'goal', goal: { id: 'gx', request: 'r', createdAt: '2026-01-01T00:00:00.000Z', steps: [] } })}\n${JSON.stringify({ t: 'close', goalId: 'gx' })}\n`);
    const ino = (await stat(path)).ino;
    await g.open('依頼', ['読む']);
    assert.equal((await stat(path)).ino, ino);
    assert.equal((await readFile(path, 'utf8')).trim().split('\n').length, 3);
  });

  test('**記録を読めないとき、次の段を「無い」と取り違えない**（読めない＝投げる、無い＝空）', async () => {
    const { path } = await goals('unreadable-next');
    const writer = new Goals(path);
    const goal = await writer.open('依頼', ['読む', '直す']);
    const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    const g = new Goals(path, { read: () => Promise.reject(denied) });
    await assert.rejects(g.next(goal.id), /EACCES/, '読めないのに「段は残っていない」と返した');
    await assert.rejects(g.openGoals(), /EACCES/);
    // 見せるだけの一覧は、今までどおり空で返す
    assert.deepEqual(await g.list(), []);
    // 無いだけなら空（段取りが無い）
    const missing = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
    const none = new Goals(path, { read: () => Promise.reject(missing) });
    assert.equal(await none.next(goal.id), undefined);
    // 読めれば、残っている段を返す
    assert.equal((await writer.next(goal.id))?.instruction, '読む');
  });
});
