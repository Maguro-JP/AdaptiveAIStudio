/**
 * 裏の仕事のパネル。流れではなく、いまの状態だけが並ぶ。
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
  const body = createNode('div');
  PANELS.jobs!(body, { on: (type: string, fn: (e: unknown) => void) => { if (type === 'jobs') handlers.push(fn); } });
  return { body, emit: (jobs: unknown[]) => { for (const fn of handlers) fn({ type: 'jobs', jobs }); } };
}

describe('裏の仕事のパネル', () => {
  test('名前は「裏の仕事」', () => { assert.equal(TITLES.jobs, '裏の仕事'); });

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
    await until(() => body.text.includes('裏で動いているものはありません'), '空と言う');
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
});
