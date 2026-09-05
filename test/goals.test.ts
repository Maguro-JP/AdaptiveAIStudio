/**
 * 段取り — 落ちたら、その段をもっと小さく割り直す。
 *
 * ここまでは、落ちたら**同じ大きさで挑み直して**、三回やって諦めていた。
 * 通らなかったものを、もう一度そのまま渡しても通らない。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { Goals, progressOf, isSettled, SPLIT_AFTER } from '../src/core/goals.ts';

async function store(): Promise<{ g: Goals; path: string }> {
  const dir = await tempDir('aas-goals-');
  const path = join(dir, 'goals.jsonl');
  return { g: new Goals(path), path };
}

describe('段取りを立てて、一段ずつ進む', () => {
  test('前から順に出す', async () => {
    const { g } = await store();
    const goal = await g.open('src を直して', ['読む', '直す', '試す']);
    assert.equal((await g.next(goal.id))?.instruction, '読む');
    await g.succeed(goal.id, goal.steps[0]!.id);
    assert.equal((await g.next(goal.id))?.instruction, '直す');
  });

  test('置き場に残る。窓を閉じても続きから', async () => {
    const { g, path } = await store();
    const goal = await g.open('x', ['あ', 'い']);
    await g.succeed(goal.id, goal.steps[0]!.id);
    const again = new Goals(path);
    assert.equal((await again.next(goal.id))?.instruction, 'い');
  });

  test('全部済んだら、次は無い', async () => {
    const { g } = await store();
    const goal = await g.open('x', ['あ']);
    await g.succeed(goal.id, goal.steps[0]!.id);
    assert.equal(await g.next(goal.id), undefined);
    const after = (await g.list())[0]!;
    assert.equal(isSettled(after), true);
  });
});

describe('落ちたら、割り直す', () => {
  test('一度目は、そのままもう一度', async () => {
    // 届かなかっただけ、ということがある。一度で決めつけない。
    const { g } = await store();
    const goal = await g.open('x', ['直す']);
    const r = await g.fail(goal.id, goal.steps[0]!.id);
    assert.equal(r.do, 'retry');
    // まだ次に出てくること（脇へ置かない）。
    assert.equal((await g.next(goal.id))?.id, goal.steps[0]!.id);
  });

  test('二度目で、割り直せと言う', async () => {
    const { g } = await store();
    const goal = await g.open('x', ['直す']);
    for (let i = 0; i < SPLIT_AFTER - 1; i += 1) await g.fail(goal.id, goal.steps[0]!.id);
    const r = await g.fail(goal.id, goal.steps[0]!.id);
    assert.equal(r.do, 'split');
  });

  test('割り直した段は、元の段のすぐ後ろに入る', async () => {
    // 前でも末尾でもない。順番が意味を持つ（読んでから書く、が
    // 入れ替わると通らない）。
    const { g } = await store();
    const goal = await g.open('x', ['直す', '試す']);
    await g.split(goal.id, goal.steps[0]!.id, ['読む', '1行だけ直す']);
    const after = (await g.list())[0]!;
    assert.deepEqual(
      after.steps.map((s) => `${s.instruction}:${s.state}`),
      ['直す:split', '読む:pending', '1行だけ直す:pending', '試す:pending'],
    );
    assert.equal((await g.next(goal.id))?.instruction, '読む');
  });

  test('割った先が駄目なら、塞がったとして脇へ置く', async () => {
    // 際限なく割ると、意味の無い断片になる。
    const { g } = await store();
    const goal = await g.open('x', ['直す']);
    await g.fail(goal.id, goal.steps[0]!.id);
    await g.fail(goal.id, goal.steps[0]!.id);
    const [child] = await g.split(goal.id, goal.steps[0]!.id, ['読む']);
    await g.fail(goal.id, child!.id);
    const r = await g.fail(goal.id, child!.id);
    assert.equal(r.do, 'block', `際限なく割っている: ${JSON.stringify(r)}`);
  });

  test('一段が塞がっても、次の段へ進む', async () => {
    // 止めると、独立して進められる残りまで道連れになる。
    const { g } = await store();
    const goal = await g.open('x', ['駄目な段', '進める段']);
    await g.block(goal.id, goal.steps[0]!.id);
    assert.equal((await g.next(goal.id))?.instruction, '進める段');
  });
});

describe('進み具合', () => {
  test('割られた段は、二重に数えない', async () => {
    const { g } = await store();
    const goal = await g.open('x', ['直す', '試す']);
    await g.split(goal.id, goal.steps[0]!.id, ['読む', '書く']);
    const after = (await g.list())[0]!;
    const p = progressOf(after);
    assert.equal(p.total, 3, `二重に数えている: ${JSON.stringify(p)}`);
    assert.equal(p.left, 3);
  });

  test('塞がったものは、もう手を付けないものとして数える', async () => {
    const { g } = await store();
    const goal = await g.open('x', ['あ', 'い']);
    await g.succeed(goal.id, goal.steps[0]!.id);
    await g.block(goal.id, goal.steps[1]!.id);
    const after = (await g.list())[0]!;
    assert.deepEqual(progressOf(after), { done: 1, blocked: 1, left: 0, total: 2 });
    assert.equal(isSettled(after), true);
  });
});

describe('壊れても、読める分で進む', () => {
  test('壊れた行は捨てる', async () => {
    const { g, path } = await store();
    const goal = await g.open('x', ['あ']);
    await writeFile(path, '{"t":"state","goalId":"欠け', { flag: 'a' });
    await g.succeed(goal.id, goal.steps[0]!.id);
    assert.equal(await g.next(goal.id), undefined);
  });

  test('閉じたものは出てこない', async () => {
    const { g } = await store();
    const goal = await g.open('x', ['あ']);
    await g.close(goal.id);
    assert.deepEqual(await g.list(), []);
  });
});

/**
 * 提案を溜めすぎない。
 *
 * 提案は暇なときに勝手に増える。**上限が無かったので、放っておくと
 * 際限なく溜まる**（500 件で 877KB。画面にも全部並ぶ）。
 * 人が選べる数を超えたものは、見てもらえないのと同じ。
 */
describe('提案を溜めすぎない', () => {
  const make = (i: number) => ({
    kind: 'bug' as const, title: `見つけたもの${i}`, rationale: 'あ'.repeat(100),
    evidence: [`src/a${i}.ts`], suggestedAction: 'なおす', fingerprint: `f${i}`,
  });

  test('上限を超えたら、それ以上は溜めない', async () => {
    const { ProposalQueue, MAX_ITEMS } = await import('../src/agent/proposals.ts');
    const q = new ProposalQueue();
    for (let i = 0; i < MAX_ITEMS + 50; i += 1) q.add(make(i));
    assert.equal(q.all().length, MAX_ITEMS, `上限が効いていない: ${q.all().length}`);
  });

  test('落とすのは古い方から（新しい方が、いまの状況に近い）', async () => {
    const { ProposalQueue, MAX_ITEMS } = await import('../src/agent/proposals.ts');
    const q = new ProposalQueue();
    for (let i = 0; i < MAX_ITEMS + 10; i += 1) q.add(make(i));
    const titles = q.all().map((p) => p.title);
    assert.ok(!titles.includes('見つけたもの0'), '古いものが残っている');
    assert.ok(titles.includes(`見つけたもの${MAX_ITEMS + 9}`), '新しいものが落ちている');
  });

  test('**落とした数を数えている**（黙って消さない）', async () => {
    const { ProposalQueue, MAX_ITEMS } = await import('../src/agent/proposals.ts');
    const q = new ProposalQueue();
    for (let i = 0; i < MAX_ITEMS + 7; i += 1) q.add(make(i));
    assert.equal(q.dropped, 7, `数えていない: ${q.dropped}`);
  });
});
