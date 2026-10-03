/**
 * 外のツール（MCP）で作業場が変わったことを、会話のパネルが言う。
 *
 * 出来事（`outsideChanged`）を足しても、画面の側が受けなければ黙って捨てられる。
 * 三つの形（変わった・比べられない・書く手前で見つけた）を、それぞれ言い分けているかを見る。
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
  const sent: Array<{ url: string; method?: string; body?: unknown }> = [];
  (globalThis as { fetch?: unknown }).fetch = (async (url: string, init?: { method?: string; body?: string }) => {
    sent.push({ url, method: init?.method, body: init?.body ? JSON.parse(init.body) : undefined });
    return Response.json({});
  }) as unknown as typeof fetch;
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
  const emit = (event: unknown) => {
    for (const fn of handlers.get('session') ?? []) fn({ event });
  };
  return { emit, text: () => body.text, body, sent };
}

describe('外のツールで作業場が変わったことを言う', () => {
  test('変わったファイルを挙げ、一度だけ確かめると言う', () => {
    const t = open();
    t.emit({ type: 'outsideChanged', paths: ['a.txt', 'b.txt'] });
    assert.match(t.text(), /外のツールが作業場を変えました（a\.txt, b\.txt）/);
    assert.match(t.text(), /一度だけ確かめます/);
  });

  test('多いときは、頭の 5 件と残りの件数', () => {
    const t = open();
    t.emit({ type: 'outsideChanged', paths: ['1', '2', '3', '4', '5', '6', '7'] });
    assert.match(t.text(), /1, 2, 3, 4, 5 ほか 2 件/);
  });

  test('比べられなかったら、比べられないと言い、確かめたとは言わない', () => {
    const t = open();
    t.emit({ type: 'outsideChanged', paths: undefined });
    assert.match(t.text(), /比べられませんでした/);
    assert.match(t.text(), /確かめは回していません/);
    assert.equal(t.body.buttons().filter((b) => /了解/.test(b.textContent ?? '')).length, 0, '了解できないのに口を出している');
  });

  test('了解できる警告には「了解」の口があり、押すと本体へ送る', async () => {
    const t = open();
    t.emit({ type: 'outsideChanged', paths: undefined, ackable: 'outside-uncomparable' });
    const ok = t.body.buttons().find((b) => /了解/.test(b.textContent ?? ''));
    assert.ok(ok, '了解の口が無い');
    await ok.onclick!();
    // パネルは作り直しのときに待っている承認も読みに行く（`/api/approvals`）。送ったものだけを見る
    assert.deepEqual(t.sent.filter((s) => s.url !== '/api/approvals').map((s) => [s.url, s.method, s.body]),
      [['/api/acks', 'POST', { id: 'outside-uncomparable' }]]);
    assert.match(ok.textContent ?? '', /了解しました/);
    assert.match(ok.textContent ?? '', /また出せます/, '取り消せることを言っていない');
  });

  test('覚えている作業前を使うなら、そう言う', () => {
    const t = open();
    t.emit({ type: 'outsideChanged', paths: ['a.txt'], beforeBaseline: true, remembered: true });
    assert.match(t.text(), /この回より前に測った結果を使います/);
    assert.ok(!/直させます/.test(t.text()));
  });

  test('戻せなかった分を、巻き戻しの知らせに添える', () => {
    const t = open();
    t.emit({ type: 'rolledBack', paths: ['a.txt'], notRestored: ['big.bin'] });
    assert.match(t.text(), /変更を巻き戻しました: a\.txt/);
    assert.match(t.text(), /戻せなかった: big\.bin/);
  });

  test('書く手前で見つけたなら、直させると言う', () => {
    const t = open();
    t.emit({ type: 'outsideChanged', paths: ['FAIL'], beforeBaseline: true });
    assert.match(t.text(), /外のツールが先に作業場を変えました（FAIL）/);
    assert.match(t.text(), /今回の作業のものとして直させます/);
    assert.ok(!/一度だけ確かめます/.test(t.text()), '書く手前の形なのに、一度だけと言っている');
  });
});
