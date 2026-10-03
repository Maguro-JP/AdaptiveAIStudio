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

async function sendFrom(current: string | null, opts: { status?: number; whileWaiting?: () => void; ctx?: Record<string, unknown> } = {}): Promise<Record<string, unknown>> {
  const bodies: Record<string, unknown>[] = [];
  (globalThis as { fetch?: unknown }).fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).includes('/api/send')) {
      bodies.push(JSON.parse(String(init?.body)));
      opts.whileWaiting?.();
      await new Promise((r) => setTimeout(r, 20));
    }
    return Response.json({ accepted: true, conversationId: 'c20260101-000000-0001' }, { status: opts.status ?? 202 });
  }) as unknown as typeof fetch;
  const ctx: Record<string, unknown> = { on: () => {}, onState: () => {}, focusInput: () => {}, conversationId: () => current, ...opts.ctx };
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
  await new Promise((r) => setTimeout(r, 60)); // 返事を受け取るところまで
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
  test('返事を待つ間に別の会話を選んでも、送った会話へ引き戻さない', async () => {
    let current: string | null = 'c20260101-000000-0007';
    const adopted: unknown[] = [];
    await sendFrom(null, {
      ctx: { conversationId: () => current, adopt: (id: unknown) => adopted.push(id) },
      whileWaiting: () => { current = 'c20260101-000000-0008'; },
    });
    assert.deepEqual(adopted, [null], `前の会話へ引き戻した: ${JSON.stringify(adopted)}`);
  });
  test('トップから送ったときは、決まった会話を受け取る（対）', async () => {
    const adopted: unknown[] = [];
    await sendFrom(null, { ctx: { adopt: (id: unknown) => adopted.push(id) } });
    assert.deepEqual(adopted, ['c20260101-000000-0001']);
  });
  test('見ていた会話が無い（404）なら、トップへ戻す口を呼ぶ', async () => {
    const gone: unknown[] = [];
    await sendFrom('c20260101-000000-0007', { status: 404, ctx: { conversationGone: (id: unknown) => gone.push(id) } });
    assert.deepEqual(gone, ['c20260101-000000-0007']);
  });
});
