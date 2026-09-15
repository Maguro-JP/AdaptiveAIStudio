/**
 * 提案のパネルは、落としたことを黙らない。
 *
 * 上限（200 件）で古い提案を落としている。数えて・保存して・読み直す所までは
 * 在ったのに、**画面に出す道が無かった。**出ないと、前に見た提案が消えたときに
 * 「忘れたのか、却下したのか」を切り分けられない。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, createNode, type StubNode } from './dom-stub.ts';
import { until } from './until.ts';

installDom();
const { PANELS } = await import('../src/ui/web/panels.js') as {
  PANELS: Record<string, (body: StubNode, ctx: unknown) => void>;
};

/** パネルを開く。`/api/proposals` はこの中身を返す。 */
function open(answer: Record<string, unknown>) {
  (globalThis as { fetch?: unknown }).fetch = (async () => Response.json(answer)) as unknown as typeof fetch;
  const body = createNode('div');
  PANELS.proposals!(body, {
    on: () => undefined,
    onState: () => undefined,
  });
  return { body, text: () => body.text };
}

describe('提案のパネル', () => {
  test('**落とした件数を出す**', async () => {
    const { text } = open({ open: [], duties: [], due: [], idle: {}, spent: '0', dropped: 7 });
    await until(() => /落としました/.test(text()), '落としたと出る', { timeoutMs: 5000 });
    assert.match(text(), /古い 7 件/);
  });

  test('落としていなければ、言わない（対）', async () => {
    const { text } = open({ open: [], duties: [], due: [], idle: {}, spent: '0', dropped: 0 });
    await until(() => /未処理の提案はありません/.test(text()), '一覧が出る', { timeoutMs: 5000 });
    assert.ok(!/落としました/.test(text()), `落としていないのに言っている: ${text()}`);
  });
});
