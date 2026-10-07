/**
 * 段取りと確かめの流れの不具合（50 回目の調査）。
 *
 * - 分け過ぎで切り捨てた作業が、一度も行われないまま「受け取りました」になっていた（`test/pm.test.ts` の分け過ぎの試験で見る）
 * - 送り口の確かめが、時間切れを落ちたものとして直させ続け、最後に落ちた扱いにしていた
 * - 数で書いた id と deps を黙って捨て、待つべき件が並んで走っていた
 * - 確かめ・裏取りの工程に、書ける役職が先に選ばれていた
 * - package.json の頭の BOM で、依存が「見つかりませんでした」になっていた
 * - 冗長実行で、勝った試みに「取り消し」の知らせを出していた
 *
 * 段取りの道の「落ちた回もテストの数を比べる」と「絶対の道を作業場からの道に直す」は、session の中の直しで、ここでは試験を書いていない。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { repairPlan, type PmContext } from '../src/agent/pm.ts';
import { verifyLoop, type VerifyEvent } from '../src/agent/verify.ts';
import { inspectDependencies, describeDependencies } from '../src/agent/dependencies.ts';
import { race, type RaceEvent } from '../src/agent/race.ts';

const ctx: PmContext = {
  lanes: [{ id: 'fast', candidates: ['a'], parallel: 2 }],
  roleIds: ['worker', 'tester', 'scout', 'librarian', 'reviewer'],
  fallbackRoleId: 'worker',
  maxItems: 8,
};

describe('計画の読み方', () => {
  test('**数で書いた id と deps も読み、待つ順を崩さない**', () => {
    const p = repairPlan({ items: [
      { id: 1, instruction: '調べる', roleId: 'scout' },
      { id: 2, instruction: '書く', roleId: 'worker', deps: [1] },
    ] }, '元の依頼', { ...ctx, secondPass: false });
    const write = p.items.find((t) => t.instruction === '書く')!;
    const look = p.items.find((t) => t.instruction === '調べる')!;
    assert.deepEqual(write.deps, [look.id], `待つ相手を捨てた: ${JSON.stringify(p.items)}`);
  });
});

describe('確かめ・裏取りの役職', () => {
  test('**調べた件の裏取りに、書ける役職を選ばない**', () => {
    const p = repairPlan({ items: [{ id: 'a', instruction: '調べる', roleId: 'scout' }] }, '元の依頼', {
      ...ctx,
      access: { worker: ['read', 'write'], tester: ['read', 'execute'], scout: ['read'], librarian: ['read', 'write'], reviewer: ['read'] },
    });
    const added = p.items.filter((t) => t.id !== 'a');
    assert.ok(added.length > 0, '前提: 裏取りが付いていない');
    for (const t of added) assert.notEqual(t.roleId, 'librarian', `書ける役職を裏取りに選んだ: ${t.roleId}`);
  });
});

describe('送り口の確かめ', () => {
  test('**時間切れは直させず、確かめられなかったとして終える**', { timeout: 60_000 }, async () => {
    const root = await tempDir('aas-plan-flow-verify-');
    await writeFile(join(root, 'slow.mjs'), 'setTimeout(() => {}, 60_000);\n');
    let fixes = 0;
    const events: VerifyEvent[] = [];
    const gen = verifyLoop(
      { command: `"${process.execPath}" slow.mjs`, root, maxRounds: 3, commandTimeoutMs: 500 },
      async () => { fixes += 1; },
      new AbortController().signal,
    );
    let step = await gen.next();
    while (!step.done) { events.push(step.value); step = await gen.next(); }
    assert.equal(fixes, 0, `時間切れを直させた（${fixes} 回）`);
    const gaveUp = events.find((e) => e.type === 'giveUp') as Extract<VerifyEvent, { type: 'giveUp' }> | undefined;
    assert.equal(gaveUp?.reason, 'unsure', `落ちた扱いにした: ${JSON.stringify(events.map((e) => e.type))}`);
  });
});

describe('依存の宣言', () => {
  test('**頭に BOM のある package.json も読む**', async () => {
    const root = await tempDir('aas-plan-flow-deps-');
    await writeFile(join(root, 'package.json'), '\uFEFF' + JSON.stringify({ dependencies: { left: '^1.0.0' } }));
    const r = await inspectDependencies(root);
    assert.deepEqual(r.deps.map((d) => d.name), ['left']);
  });

  test('**読めない package.json は「無い」と言わない**', async () => {
    const root = await tempDir('aas-plan-flow-deps-bad-');
    await writeFile(join(root, 'package.json'), '{ broken');
    const text = describeDependencies(await inspectDependencies(root));
    assert.doesNotMatch(text, /見つかりませんでした/);
    assert.match(text, /読めませんでした/);
  });
});

describe('冗長実行', () => {
  test('**勝った試みに「取り消し」の知らせを出さない**', async () => {
    const events: RaceEvent[] = [];
    // 負けと勝ちが同じ一巡で終わる（負けた側が先に解ける）
    const out = await race<string>([
      { label: 'lose', run: async () => 'bad' },
      { label: 'win', run: async () => 'good' },
    ], (r) => r === 'good', new AbortController().signal, (e) => events.push(e));
    assert.equal(out.winner?.label, 'win');
    const cancelled = events.filter((e) => e.type === 'cancel').map((e) => (e as { label: string }).label);
    assert.equal(cancelled.includes('win'), false, `勝った試みを取り消したと言った: ${cancelled.join(',')}`);
  });
});
