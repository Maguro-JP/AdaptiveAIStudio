/**
 * 「実行中のタスク」のパネル。
 *
 * 頼まれた件を分けたものと、裏で動いているもの（取得・点検・報告）を**一枚**に出す。
 * 分けて二枚にしていたら、画面に同じ意味の札が二つ並んだ（実機）。
 * 流れではなく、いまの状態だけを並べる。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, createNode, type StubNode } from './dom-stub.ts';
import { until } from './until.ts';

installDom();
const { PANELS, TITLES } = await import('../src/ui/web/panels.js') as {
  PANELS: Record<string, (body: StubNode, ctx: unknown) => void>;
  TITLES: Record<string, string>;
};

function open(initial: unknown[]) {
  (globalThis as { fetch?: unknown }).fetch = (async (url: string) => {
    assert.ok(String(url).includes('/api/jobs'), `知らない先を叩いた: ${url}`);
    return Response.json({ jobs: initial });
  }) as unknown as typeof fetch;
  const handlers: Array<(e: unknown) => void> = [];
  const plans: Array<(e: unknown) => void> = [];
  const body = createNode('div');
  PANELS.plan!(body, {
    on: (type: string, fn: (e: unknown) => void) => {
      if (type === 'jobs') handlers.push(fn);
      if (type === 'planEvent') plans.push(fn);
    },
  });
  return {
    body,
    emit: (jobs: unknown[]) => { for (const fn of handlers) fn({ type: 'jobs', jobs }); },
    emitPlan: (event: unknown) => { for (const fn of plans) fn({ type: 'planEvent', event }); },
  };
}

describe('実行中のタスクのパネル', () => {
  test('名前は「実行中のタスク」', () => { assert.equal(TITLES.plan, '実行中のタスク'); });

  /**
   * 「実行中のタスク」と「裏の仕事」で二枚あった。どちらも「いま動いているもの」で、
   * 画面には同じ意味の札が並ぶだけだった。**一枚に畳んだので、もう出さない。**
   */
  test('**「裏の仕事」は無くなった**', () => {
    assert.equal(TITLES.jobs, undefined, 'まだ札が二枚ある');
    assert.equal(PANELS.jobs, undefined);
  });

  test('開いたら本体から取り、仕事ごとに一行、進み具合と最新の一言を出す', async () => {
    const { body } = open([
      { kind: 'fetch', id: 'x', title: 'モデルを取ってくる: x', state: 'running', detail: '27%  5.71GB / 20.61GB  18.2MB/秒  残り 14:00', progress: { pct: 27 }, startedAt: new Date(Date.now() - 65_000).toISOString() },
      { kind: 'task', id: 'doctor', title: '点検: この環境を見てもらう', state: 'running', detail: '回しています', startedAt: new Date().toISOString() },
    ]);
    await until(() => body.text.includes('モデルを取ってくる: x'), '描かれる');
    assert.match(body.text, /27%  5\.71GB/);
    assert.match(body.text, /1 分 \d+ 秒 経過/, '経った時間が出ない');
    assert.match(body.text, /点検: この環境を見てもらう/);
    const fill = body.children[0]!.children.find((r) => r.className.includes('job'))!.children.find((c) => c.className === 'job-bar')!.children[0]!;
    assert.equal(fill.style.width, '27%');
  });

  test('状態が流れてきたら、並べ直す（前の行は残さない）', async () => {
    const { body, emit } = open([]);
    await until(() => body.text.includes('動いているものはありません'), '空と言う');
    emit([{ kind: 'fetch', id: 'x', title: 'モデルを取ってくる: x', state: 'done', detail: '用意できました: x' }]);
    assert.match(body.text, /✓/);
    assert.match(body.text, /用意できました: x/);
    assert.ok(!body.text.includes('ありません'));
    emit([]);
    assert.match(body.text, /ありません/);
  });

  test('失敗は ✗ と理由', async () => {
    const { body } = open([{ kind: 'fetch', id: 'x', title: 'モデルを取ってくる: x', state: 'failed', detail: '取ってこられませんでした: 403' }]);
    await until(() => body.text.includes('✗'), '失敗と出る');
    assert.match(body.text, /403/);
  });

  /**
   * 二枚に分けていたので、頼んだ件を見ながら取得の進み具合を見る、ができなかった。
   * **どちらも「いま動いているもの」**なので、同じ一枚に並べる。
   */
  test('**分けた件と、裏の仕事が、同じ一枚に並ぶ**', async () => {
    const { body, emitPlan } = open([
      { kind: 'fetch', id: 'x', title: 'モデルを取ってくる: x', state: 'running', progress: { pct: 40 } },
    ]);
    await until(() => body.text.includes('モデルを取ってくる: x'), '裏の仕事が出る');
    emitPlan({
      type: 'planned',
      plan: { items: [{ id: 't1', roleId: 'worker', instruction: 'README を直す' }] },
    });
    assert.match(body.text, /README を直す/, '分けた件が出ない');
    assert.match(body.text, /モデルを取ってくる: x/, '件を出したら裏の仕事が消えた');
  });

  test('件だけのときも、裏の仕事だけのときも、空とは言わない（対）', async () => {
    const { body, emitPlan } = open([]);
    await until(() => body.text.includes('動いているものはありません'), '空と言う');
    emitPlan({
      type: 'planned',
      plan: { items: [{ id: 't1', roleId: 'worker', instruction: 'README を直す' }] },
    });
    assert.ok(!body.text.includes('ありません'), '件が在るのに空と言っている');
  });
});
