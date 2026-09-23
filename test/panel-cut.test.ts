/**
 * 会話のパネルが、切ったぶんを黙って隠さないこと。
 *
 * 検証に失敗したときの出力は末尾 12 行だけを出していた。本体は 40 行まで
 * 持っているので、**最初に落ちた所が上にあると、それが見えないまま**
 * 「これで全部」に見える。指摘の場所も 5 件で切っていて、同じ形だった。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, createNode, type StubNode } from './dom-stub.ts';

installDom();
(globalThis as { window?: unknown }).window = {};
const { PANELS } = await import('../src/ui/web/panels.js') as {
  PANELS: Record<string, (body: StubNode, ctx: unknown) => void>;
};

function open() {
  (globalThis as { fetch?: unknown }).fetch = (async () => Response.json({})) as unknown as typeof fetch;
  const handlers = new Map<string, Array<(e: unknown) => void>>();
  const body = createNode('div');
  PANELS.conversation!(body, {
    on: (type: string, fn: (e: unknown) => void) => {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type)!.push(fn);
    },
    onState: () => {},
    focusInput: () => {},
  });
  const emit = (type: string, event: unknown) => {
    for (const fn of handlers.get(type) ?? []) fn({ event });
  };
  return { body, emit, text: () => body.text };
}

describe('切ったぶんを、黙って隠さない', () => {
  test('**検証の出力を切ったら、何行隠したかを言う**', () => {
    const t = open();
    const digest = Array.from({ length: 40 }, (_, i) => `行${i}`).join('\n');
    t.emit('session', { type: 'verify', event: { type: 'failed', round: 1, digest } });
    const text = t.text();
    assert.match(text, /前の 28 行は出していません/, `切ったことを言っていない: ${text.slice(0, 200)}`);
    // 末尾は出ている。頭は出ていない。
    assert.ok(text.includes('行39'), '末尾が出ていない');
    assert.ok(!text.includes('行0\n') && !text.includes('行0行'), '切っていない');
  });

  test('短い出力では、何も言わない（対）', () => {
    const t = open();
    t.emit('session', { type: 'verify', event: { type: 'failed', round: 1, digest: '行A\n行B' } });
    const text = t.text();
    assert.ok(!text.includes('出していません'), `切っていないのに言っている: ${text.slice(0, 200)}`);
    assert.ok(text.includes('行A'), '中身が出ていない');
  });

  test('**指摘の場所を切ったら、何か所隠したかを言う**', () => {
    const t = open();
    t.emit('planEvent', {
      type: 'accepted',
      report: {
        verdict: 'needsHuman',
        members: [{ state: 'done' }],
        verified: 'passed',
        changed: [],
        concerns: [{
          severity: 'block', reason: 'ここが危ない',
          where: Array.from({ length: 9 }, (_, i) => `a${i}.ts:1`),
        }],
      },
    });
    const text = t.text();
    assert.ok(text.includes('ここが危ない'), `指摘そのものが出ていない: ${text.slice(0, 300)}`);
    assert.ok(text.includes('a0.ts:1') && text.includes('a4.ts:1'), '場所が 5 件出ていない');
    assert.ok(!text.includes('a5.ts:1'), '5 件で切っていない');
    assert.match(text, /ほかに 4 か所/, `切ったことを言っていない: ${text.slice(0, 300)}`);
  });
});
