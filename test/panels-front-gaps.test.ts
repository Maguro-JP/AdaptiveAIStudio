/**
 * パネルの JS の不具合（58 回目の調査）。
 *
 * - `/planner` のような名前のコマンドを、段取りの口へ頭を削って送った
 * - 作り直した直後に別の会話を選ぶと、遅れて返った前の会話の中身で欄を上書きした
 * - 文字のドラッグまで既定を取り消し、選んだ文字を欄へ落とせなかった
 * - 文字と絵が一緒に来る貼り付け（Office から写す）を、絵の添付にした
 * - 「忘れる」「いま考えさせる」を、返事を待つ間に二度押せた（描き直しで押せるボタンに戻った）
 *
 * タブに隠れたパネルの「経過」の時計が止まったままになる件は、時計を待つ試験になるので書いていない（確かめていない）。
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
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function conversation(ctx: Record<string, unknown>, answer: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  const urls: string[] = [];
  (globalThis as { fetch?: unknown }).fetch = (async (url: string, init?: RequestInit) => { urls.push(String(url)); return answer(String(url), init); }) as unknown as typeof fetch;
  const body = createNode('div');
  PANELS.conversation!(body, { on: () => {}, onState: () => {}, focusInput: () => {}, ...ctx });
  return { body, urls };
}

describe('会話の欄', () => {
  test('**`/planner` は段取りではなく、そのまま送る**', async () => {
    const sent: { url: string; body: unknown }[] = [];
    const { body } = conversation({ conversationId: () => null }, (url, init) => {
      if (url.includes('/api/send') || url.includes('/api/plan')) sent.push({ url, body: JSON.parse(String(init?.body)) });
      return Response.json({ accepted: true, conversationId: 'c20260101-000000-0001' }, { status: 202 });
    });
    find((n) => n.tagName === 'textarea', body)!.value = '/planner 直して';
    (find((n) => n.tagName === 'form', body) as unknown as { onsubmit: (e: unknown) => void }).onsubmit({ preventDefault: () => undefined });
    await until(() => sent.length > 0, '送っていない');
    assert.match(sent[0]!.url, /\/api\/send/, '段取りの口へ送った');
    assert.equal((sent[0]!.body as { text: string }).text, '/planner 直して');
  });

  test('**取っている間に別の会話を選んだら、前の会話の中身を描かない**', async () => {
    let current = 'c20260101-000000-0007';
    // 描く口（showHistory）はパネルが自分で差すので、欄に出たかで見る
    const { body } = conversation({ conversationId: () => current }, async (url) => {
      if (url.includes('/api/conversations/messages')) {
        await settle(50);
        return Response.json({ messages: [{ role: 'user', content: '前の会話の中身' }] });
      }
      return Response.json({});
    });
    await settle(10);
    current = 'c20260101-000000-0008';
    await settle(100);
    assert.doesNotMatch(body.text, /前の会話の中身/, '選び直した後に、前の会話の中身を描いた');
  });

  test('選び直さなければ、作り直した会話の中身を描く（対）', async () => {
    const { body } = conversation({ conversationId: () => 'c20260101-000000-0007' }, async (url) => {
      if (url.includes('/api/conversations/messages')) return Response.json({ messages: [{ role: 'user', content: '前の会話の中身' }] });
      return Response.json({});
    });
    await until(() => /前の会話の中身/.test(body.text), '作り直した会話の中身を描いていない');
  });

  test('**文字のドラッグは取り消さない。ファイルは受ける（対）**', () => {
    const { body } = conversation({ conversationId: () => null }, () => Response.json({}));
    const wrap = find((n) => n.className === 'chat', body) as unknown as { ondrop: (e: unknown) => void };
    let prevented = 0;
    wrap.ondrop({ preventDefault: () => { prevented += 1; }, dataTransfer: { types: ['text/plain'], files: [] } });
    assert.equal(prevented, 0, '文字のドラッグの既定を取り消した');
    wrap.ondrop({ preventDefault: () => { prevented += 1; }, dataTransfer: { types: ['Files'], files: [] } });
    assert.equal(prevented, 1);
  });

  test('**文字も来ている貼り付けは、文字として貼る**', () => {
    const { body } = conversation({ conversationId: () => null }, () => Response.json({}));
    const input = find((n) => n.tagName === 'textarea', body) as unknown as { onpaste: (e: unknown) => void };
    let prevented = 0;
    const file = { name: 'image.png', type: 'image/png', size: 10 };
    input.onpaste({ preventDefault: () => { prevented += 1; }, clipboardData: { files: [file], getData: () => 'a\tb' } });
    assert.equal(prevented, 0, '文字の貼り付けを絵の添付にした');
  });
});

describe('二度押し', () => {
  test('**「忘れる」は、返事を待つ間に二度送らない**', async () => {
    let deletes = 0;
    (globalThis as { fetch?: unknown }).fetch = (async (_url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') { deletes += 1; await settle(50); return Response.json({ forgotten: true, title: 'x' }); }
      return Response.json({});
    }) as unknown as typeof fetch;
    (globalThis as { alert?: unknown }).alert = () => undefined;
    let render!: (s: unknown) => void;
    const body = createNode('div');
    PANELS.memory!(body, { onState: (fn: (s: unknown) => void) => { render = fn; } });
    render({ memory: [{ id: 'm1', kind: 'fact', title: '覚え', confirms: 1, at: 1 }], memorySize: 1, memorySkipped: 0, memoryForgotten: [] });
    const drop = find((n) => n.tagName === 'button' && n.textContent === '忘れる', body)!;
    void drop.onclick!();
    void drop.onclick!();
    await settle(100);
    assert.equal(deletes, 1, `二度送った: ${deletes}`);
  });

  test('**「いま考えさせる」は、描き直しても送っている間は押せない**', async () => {
    let thinks = 0;
    (globalThis as { fetch?: unknown }).fetch = (async (url: string) => {
      if (String(url).includes('/api/think')) { thinks += 1; await settle(150); return Response.json({}, { status: 202 }); }
      return Response.json({ open: [], duties: [], due: [], idle: {}, spent: '0', dropped: 0 });
    }) as unknown as typeof fetch;
    let redraw!: (s: unknown) => void;
    const body = createNode('div');
    PANELS.proposals!(body, { on: () => undefined, onState: (fn: (s: unknown) => void) => { redraw = fn; } });
    const button = () => find((n) => n.tagName === 'button' && n.textContent === 'いま考えさせる', body);
    await until(() => button() !== undefined, 'ボタンが出ない', { timeoutMs: 5000 });
    void button()!.onclick!();
    redraw({});
    await until(() => button() !== undefined, '描き直しで出ない', { timeoutMs: 5000 });
    await settle(30);
    assert.equal(button()!.disabled, true, '描き直したら、送っている最中なのに押せるボタンに戻った');
    void button()!.onclick!();
    await settle(250);
    assert.equal(thinks, 1, `二度送った: ${thinks}`);
  });
});
