/**
 * 記憶のパネルの「忘れる」と「戻す」。
 *
 * 前は画面が最後に忘れた一件だけを手元に持っていたので、続けて二つ忘れると一つ目を戻せず、パネルを開き直すと戻す口ごと消えた。
 * 本体が持っている分（`memoryForgotten`、新しい順）を並べ、どれでも戻せることを見る。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, createNode, type StubNode } from './dom-stub.ts';

installDom();
const { PANELS } = await import('../src/ui/web/panels.js') as {
  PANELS: Record<string, (body: StubNode, ctx: unknown) => void>;
};

interface Entry { id: string; kind: string; title: string; confirms: number; at: number }
const entry = (id: string, title: string, at: number): Entry => ({ id, kind: 'fact', title, confirms: 1, at });

interface Item { id: string; title: string; kind: string; at: number }

/** パネルを描く。本体の返事は試験が決める。送ったものと、出した警告を返す。 */
function draw(memory: Entry[], memoryForgotten: Item[] = [], answer: (method: string, url: string, body: unknown) => Response = (m, u, b) => (
  m === 'DELETE'
    ? Response.json({ id: new URL(u, 'http://x').searchParams.get('id'), title: memory.find((e) => e.id === new URL(u, 'http://x').searchParams.get('id'))?.title, forgotten: true })
    : Response.json({ id: (b as { id: string }).id, restored: true })
)) {
  const sent: { method: string; url: string; body: unknown }[] = [];
  const alerts: string[] = [];
  (globalThis as { fetch?: unknown }).fetch = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    sent.push({ method: init?.method ?? 'GET', url, body });
    return answer(init?.method ?? 'GET', url, body);
  }) as unknown as typeof fetch;
  (globalThis as { alert?: unknown }).alert = (t: string) => { alerts.push(t); };
  let render!: (s: unknown) => void;
  const body = createNode('div');
  PANELS.memory!(body, { onState: (fn: (s: unknown) => void) => { render = fn; } });
  const state = { memory, memorySize: memory.length, memorySkipped: 0, memoryForgotten };
  render(state);
  return { body, sent, alerts, render: (s: Partial<typeof state>) => render({ ...state, ...s }) };
}

function buttons(body: StubNode, text: string): StubNode[] {
  const found: StubNode[] = [];
  const walk = (n: StubNode) => {
    if (n.tagName === 'button' && n.textContent === text) found.push(n);
    for (const c of n.children) walk(c);
  };
  walk(body);
  return found;
}

/** 行の文（題）を持つ「忘れる」を押す。一覧の行は [種類, 題, 効き, 忘れる]。 */
function forgetButtonOf(body: StubNode, title: string): StubNode {
  let hit: StubNode | undefined;
  const walk = (n: StubNode) => {
    if (n.children.some((c) => c.textContent === title) && n.children.some((c) => c.tagName === 'button' && c.textContent === '忘れる')) {
      hit = n.children.find((c) => c.tagName === 'button' && c.textContent === '忘れる');
    }
    for (const c of n.children) walk(c);
  };
  walk(body);
  assert.ok(hit, `「${title}」の忘れる口が無い`);
  return hit;
}

const settle = () => new Promise((r) => setTimeout(r, 5));

describe('記憶のパネルの「戻す」', () => {
  test('**本体が持っている分を、最新は目の前に、それより前は畳んで並べる**', () => {
    const { body } = draw([entry('m1', '残っている覚え', 1)], [
      { id: 'm4', title: '三つ目', kind: 'fact', at: 30 },
      { id: 'm3', title: '二つ目', kind: 'fact', at: 20 },
      { id: 'm2', title: '一つ目', kind: 'fact', at: 10 },
    ]);
    assert.match(body.text, /「三つ目」を忘れました/);
    assert.match(body.text, /ほかにも 2 件戻せます/);
    assert.match(body.text, /「二つ目」/);
    assert.match(body.text, /「一つ目」/);
    assert.equal(buttons(body, '戻す').length, 3);
  });

  test('**続けて二つ忘れても、一つ目を戻せる**（戻した行は一覧の元の位置へ）', async () => {
    const memory = [entry('m3', '新しい覚え', 30), entry('m2', '真ん中の覚え', 20), entry('m1', '古い覚え', 10)];
    const { body, sent } = draw(memory);
    await forgetButtonOf(body, '真ん中の覚え').onclick!();
    await forgetButtonOf(body, '古い覚え').onclick!();
    assert.match(body.text, /「古い覚え」を忘れました/);
    assert.match(body.text, /ほかにも 1 件戻せます/);
    // 畳んだ側の「真ん中の覚え」を戻す
    const undo = buttons(body, '戻す');
    assert.equal(undo.length, 2);
    await undo[1]!.onclick!();
    await settle();
    const restore = sent.filter((x) => x.url === '/api/memory/restore');
    assert.deepEqual(restore.map((x) => x.body), [{ id: 'm2' }], '番号だけを送っていない');
    assert.match(body.text, /真ん中の覚え[\s\S]*忘れる/);
    assert.doesNotMatch(body.text, /ほかにも/);
    assert.match(body.text, /「古い覚え」を忘れました/, '戻していない方の口を消した');
    assert.ok(body.text.indexOf('新しい覚え') < body.text.lastIndexOf('真ん中の覚え'));
  });

  test('**開き直しても、本体が持っている分は戻せる**（画面の手元に写しが無くても）', async () => {
    const { body, sent, render } = draw([entry('m1', '残っている覚え', 1)], [{ id: 'm9', title: '前に忘れた覚え', kind: 'fact', at: 5 }]);
    await buttons(body, '戻す')[0]!.onclick!();
    await settle();
    assert.deepEqual(sent.at(-1)?.body, { id: 'm9' });
    assert.doesNotMatch(body.text, /前に忘れた覚え/, '戻したのに口が残っている');
    // 本体の知らせ（読み直し）で、戻した覚えが一覧に入る
    render({ memory: [entry('m9', '前に忘れた覚え', 5), entry('m1', '残っている覚え', 1)], memoryForgotten: [] });
    assert.match(body.text, /前に忘れた覚え[\s\S]*忘れる/);
  });

  test('押しても戻らない口（本体が戻せないと言った）は消し、戻せなかった理由を出す', async () => {
    const { body, alerts } = draw([], [{ id: 'm5', title: '古い代の覚え', kind: 'fact', at: 5 }],
      () => Response.json({ error: '忘れた後に記憶を読み直したので、戻せません', gone: true }, { status: 409 }));
    await buttons(body, '戻す')[0]!.onclick!();
    await settle();
    assert.deepEqual(alerts, ['忘れた後に記憶を読み直したので、戻せません']);
    assert.equal(buttons(body, '戻す').length, 0);
  });

  test('戻せなかったがもう一度押せるとき（保存の失敗）は、口を残して押せるように戻す', async () => {
    const { body, alerts } = draw([], [{ id: 'm5', title: '覚え', kind: 'fact', at: 5 }],
      () => Response.json({ error: '保存できなかったので、戻していません' }, { status: 500 }));
    const undo = buttons(body, '戻す')[0]!;
    await undo.onclick!();
    await settle();
    assert.equal(alerts.length, 1);
    assert.equal(undo.disabled, false);
    assert.equal(buttons(body, '戻す').length, 1);
  });

  test('「閉じる」で隠し、次に忘れたらまた出す', async () => {
    const { body } = draw([entry('m1', '覚え一', 1)], [{ id: 'm0', title: '前の覚え', kind: 'fact', at: 0 }]);
    await buttons(body, '閉じる')[0]!.onclick!();
    assert.doesNotMatch(body.text, /忘れました/);
    await forgetButtonOf(body, '覚え一').onclick!();
    assert.match(body.text, /「覚え一」を忘れました/);
    assert.match(body.text, /ほかにも 1 件戻せます/);
  });
});
