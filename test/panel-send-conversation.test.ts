/**
 * 送りの欄は、送る会話の名前を本文に載せる（null はトップ＝新しい会話）。
 *
 * 本体の「見ている会話」は別のタブや見回りが書き換えるので、送り先は送った画面が言う（`test/send-names-conversation.test.ts`）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, createNode, type StubNode } from './dom-stub.ts';

installDom();
(globalThis as { window?: unknown }).window = {};
const { PANELS } = await import('../src/ui/web/panels.js') as {
  PANELS: Record<string, (body: StubNode, ctx: unknown) => void>;
};

async function sendFrom(current: string | null): Promise<Record<string, unknown>> {
  const bodies: Record<string, unknown>[] = [];
  (globalThis as { fetch?: unknown }).fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).includes('/api/send')) bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ accepted: true, conversationId: 'c20260101-000000-0001' }, { status: 202 });
  }) as unknown as typeof fetch;
  const ctx: Record<string, unknown> = { on: () => {}, onState: () => {}, focusInput: () => {}, conversationId: () => current };
  const body = createNode('div');
  PANELS.conversation!(body, ctx);
  const find = (want: (n: StubNode) => boolean, n: StubNode = body): StubNode | undefined => {
    if (want(n)) return n;
    for (const c of n.children) { const got = find(want, c); if (got) return got; }
    return undefined;
  };
  find((n) => n.tagName === 'textarea')!.value = '直してください';
  const form = find((n) => n.tagName === 'form')!;
  ((form as unknown as { onsubmit: (e: { preventDefault(): void }) => void }).onsubmit)({ preventDefault: () => undefined });
  for (let i = 0; i < 50 && bodies.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(bodies.length, 1, '送っていない');
  return bodies[0]!;
}

describe('送りの欄が、送る会話を言う', () => {
  test('開いている会話の名前を載せる', async () => {
    assert.equal((await sendFrom('c20260101-000000-0007')).conversationId, 'c20260101-000000-0007');
  });
  test('トップからなら null（新しい会話）', async () => {
    const sent = await sendFrom(null);
    assert.ok('conversationId' in sent);
    assert.equal(sent.conversationId, null);
  });
});
