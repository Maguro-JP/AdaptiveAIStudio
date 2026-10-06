/**
 * 82 回目の不具合調査（画面の JS）の分。
 *
 * - 会話を切り替えたら、前の会話で読み戻していた状態を持ち越さず、下から見せる
 * - 添付を渡している途中に送らない（添付なしで届き、次の依頼に付いていった）
 *
 * スクロールを滑らかに動かさない件・配置の JSON と色選びのダイアログの Esc は、ブラウザの振る舞いなのでここでは確かめていない。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, createNode, type StubNode } from './dom-stub.ts';
import { until } from './until.ts';

installDom();
(globalThis as { window?: unknown }).window = {};
const { PANELS } = await import('../src/ui/web/panels.js') as {
  PANELS: Record<string, (body: StubNode, ctx: unknown) => void>;
};

const find = (want: (n: StubNode) => boolean, n: StubNode): StubNode | undefined => {
  if (want(n)) return n;
  for (const c of n.children) { const got = find(want, c); if (got) return got; }
  return undefined;
};

function conversation(answer: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  const urls: string[] = [];
  (globalThis as { fetch?: unknown }).fetch = (async (url: string, init?: RequestInit) => { urls.push(String(url)); return answer(String(url), init); }) as unknown as typeof fetch;
  const body = createNode('div');
  const ctx: Record<string, unknown> = { on: () => {}, onState: () => {}, focusInput: () => {}, conversationId: () => null };
  PANELS.conversation!(body, ctx);
  return { body, urls, ctx };
}

describe('会話を切り替えたとき', () => {
  test('**前の会話で読み戻していても、新しい会話は下から見せる**', async () => {
    const { body, ctx } = conversation(() => Response.json({}));
    const log = find((n) => n.className.split(/\s+/).includes('log'), body) as StubNode & {
      scrollTop: number; scrollHeight: number; clientHeight: number; onscroll: () => void;
    };
    assert.ok(log, '会話の欄が無い');
    // 前の会話で上へ読み戻した
    log.scrollHeight = 1000; log.clientHeight = 100; log.scrollTop = 0;
    log.onscroll();
    // 別の会話を描く
    (ctx.showHistory as (m: unknown[]) => void)([{ role: 'user', content: 'こんにちは' }, { role: 'assistant', content: 'はい' }]);
    assert.equal(log.scrollTop, 1000, `途中の位置から開いた: ${log.scrollTop}`);
  });
});

describe('添付を渡している途中', () => {
  test('**渡し終えるまで送らない。打った文は欄に残す**', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const sent: string[] = [];
    const { body } = conversation(async (url) => {
      if (url.includes('/api/attach')) {
        await gate;
        return Response.json({ id: 'a1', name: 'big.png', kind: 'image', bytes: 2048 });
      }
      if (url.includes('/api/send')) { sent.push(url); return Response.json({ accepted: true }, { status: 202 }); }
      return Response.json({});
    });
    const zone = find((n) => typeof (n as StubNode & { ondrop?: unknown }).ondrop === 'function', body) as StubNode & { ondrop: (e: unknown) => void };
    zone.ondrop({ preventDefault: () => undefined, dataTransfer: { files: [{ name: 'big.png', size: 10 }] } });
    await until(() => find((n) => n.className.includes('pending'), body) !== undefined, '渡している途中の札が出ない');
    const input = find((n) => n.tagName === 'textarea', body)! as StubNode & { value: string };
    input.value = 'この画像を見て';
    (find((n) => n.tagName === 'form', body) as unknown as { onsubmit: (e: unknown) => void }).onsubmit({ preventDefault: () => undefined });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(sent.length, 0, '添付を渡し終える前に送った');
    assert.equal(input.value, 'この画像を見て', '打った文を消した');
    release();
  });
});
