/**
 * 承認の札を、押して動かす。
 *
 * ここは押した時点で「許可」に書き換えていた。送った先が断っても（10 分で
 * 切れたあとは 404）、画面だけが「許可」になる。モデルには「拒否しました」が
 * 渡っているので、**画面と、実際に起きたことが割れる。**
 *
 * 塊のチェックも、押し場所によって効いたり効かなかったりした。「この依頼は以降
 * 訊かない」を押すと塊の番号を送らず、本体は全文を書く。**外したはずの塊まで
 * 書かれる。**
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

/** 2 か所を直す差分（塊のチェックが出る形）。 */
const DIFF = [
  '--- a/a.txt', '+++ b/a.txt',
  '@@ -1,3 +1,3 @@', ' one', '-two', '+TWO', ' three',
  '@@ -10,3 +10,3 @@', ' ten', '-eleven', '+ELEVEN', ' twelve',
].join('\n');

function draw(reply: (url: string) => Promise<Response>) {
  const handlers = new Map<string, Array<(e: unknown) => void>>();
  const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
  (globalThis as { fetch?: unknown }).fetch = (async (url: string, init?: { body?: string }) => {
    sent.push({ url: String(url), body: init?.body ? JSON.parse(init.body) as Record<string, unknown> : {} });
    return reply(String(url));
  }) as unknown as typeof fetch;
  const ctx: Record<string, unknown> = {
    on: (type: string, fn: (e: unknown) => void) => {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type)!.push(fn);
    },
    onState: () => {}, focusInput: () => {},
  };
  const body = createNode('div');
  PANELS.conversation!(body, ctx);
  const emit = (type: string, ev: unknown) => { for (const fn of handlers.get(type) ?? []) fn(ev); };
  const find = (want: (n: StubNode) => boolean): StubNode | undefined => {
    const walk = (n: StubNode): StubNode | undefined => {
      if (want(n)) return n;
      for (const c of n.children) { const got = walk(c); if (got) return got; }
      return undefined;
    };
    return walk(body);
  };
  const card = () => find((n) => n.className === 'ask')!;
  const press = (label: string) => {
    const got = find((n) => n.tagName === 'button' && n.textContent === label);
    assert.ok(got, `「${label}」が無い`);
    got!.onclick!();
  };
  const ticks = () => {
    const out: StubNode[] = [];
    // 会話の欄も input なので、塊のチェック（checkbox）だけを拾う。
    const walk = (n: StubNode) => {
      if (n.tagName === 'input' && (n as { type?: string }).type === 'checkbox') out.push(n);
      for (const c of n.children) walk(c);
    };
    walk(body);
    return out;
  };
  emit('approval', { id: 'a1', request: { kind: 'write', path: 'a.txt', diff: DIFF, created: false } });
  /** 出ている承認の箱の数。 */
  const asks = () => {
    let n = 0;
    const walk = (x: StubNode) => { if (x.className === 'ask') n++; for (const c of x.children) walk(c); };
    walk(body);
    return n;
  };
  /** 承認の答えとして送ったもの（パネルは作り直しのときに待っている承認も読みに行くので、それは除く）。 */
  const answers = () => sent.filter((x) => x.url.endsWith('/api/approve'));
  return { card, press, ticks, sent, answers, body, emit, asks, ctx };
}

describe('承認の札', () => {
  test('**返事を見てから、押した結果を出す**', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const t = draw(async () => {
      await gate;
      return Response.json({ error: 'その承認は既に終わっています' }, { status: 404 });
    });
    t.press('許可');
    await until(() => t.card().text.includes('送っています'), '送っている、と出る');
    release();
    await until(() => !t.card().text.includes('送っています'), '返事が来る');
    assert.match(t.card().text, /送れませんでした/, `届いていないのに結果を出している: ${t.card().text}`);
    assert.ok(!t.card().text.includes('→ 許可'), `断られたのに「許可」と出している: ${t.card().text}`);
  });

  test('通ったときは、これまでどおり「許可」と出す（対）', async () => {
    const t = draw(async () => Response.json({ ok: true }));
    t.press('許可');
    await until(() => t.card().text.includes('→ 許可'), '許可と出る');
  });

  test('**チェックを外した塊は、「この依頼は以降訊かない」でも通さない**', async () => {
    const t = draw(async () => Response.json({ ok: true }));
    const ticks = t.ticks();
    assert.equal(ticks.length, 2, `塊のチェックが ${ticks.length} 個しか無い`);
    ticks[1]!.checked = false;
    t.press('この依頼は以降訊かない');
    await until(() => t.answers().length > 0, '送られる');
    const body = t.answers()[0]!.body;
    assert.deepEqual(body.hunks, [0], `外した塊まで通している: ${JSON.stringify(body)}`);
    assert.equal(body.all, true, '「以降訊かない」が伝わっていない');
    await until(() => t.card().text.includes('一部だけ許可'), '一部だけ通したと出る');
  });

  test('**チェックを全部外して「以降訊かない」は、拒否と同じ**', async () => {
    const t = draw(async () => Response.json({ ok: true }));
    for (const tick of t.ticks()) tick.checked = false;
    t.press('この依頼は以降訊かない');
    await until(() => t.answers().length > 0, '送られる');
    assert.equal(t.answers()[0]!.body.approved, false,
      `何も通さないのに許可として送っている: ${JSON.stringify(t.answers()[0]!.body)}`);
  });
});

/*
 * 同じ承認が二度届く道がある（開いたときの読み込みと、出来事の流れが切れて繋ぎ直したときの取り直し）。
 * 押せる箱を二つ出すと、片方を押してももう片方が残り、押すと「既に終わっています」で断られる
 */
describe('同じ承認は、押せる箱を二つ出さない', () => {
  const again = { id: 'a1', request: { kind: 'write', path: 'a.txt', diff: DIFF, created: false } };

  test('**まだ押せる箱が出ているなら、出し直さない**', () => {
    const t = draw(async () => Response.json({ ok: true }));
    t.emit('approval', again);
    (t.ctx.showApprovals as (w: unknown[]) => void)([again]);
    assert.equal(t.asks(), 1, `同じ承認の箱が ${t.asks()} 個出ている`);
  });

  test('**押して送れなかった箱は、その場で押し直せる**（本体がまだ待っている。出し直しを待たない）', async () => {
    let fail = true;
    const t = draw(async () => (fail ? Response.json({ error: '届きませんでした' }, { status: 500 }) : Response.json({ ok: true })));
    t.press('許可');
    await until(() => t.card().text.includes('送れませんでした'), '送れなかったと出る');
    // 出し直しが来ても、押せる箱を二つにしない
    t.emit('approval', again);
    assert.equal(t.asks(), 1, `同じ承認の箱が ${t.asks()} 個出ている`);
    fail = false;
    t.press('許可');
    await until(() => t.card().text.includes('→ 許可'), `押し直して届いていない: ${t.card().text}`);
    assert.equal(t.answers().length, 2);
  });

  test('承認がもう終わっている（404）なら、押し直す口は出さない（対）', async () => {
    const t = draw(async () => Response.json({ error: 'その承認は既に終わっています' }, { status: 404 }));
    t.press('許可');
    await until(() => t.card().text.includes('送れませんでした'), '送れなかったと出る');
    assert.ok(!t.card().children.some(function has(n: StubNode): boolean { return n.tagName === 'button' || n.children.some(has); }),
      '終わった承認に押す口を出した');
  });

  test('欄を描き直したら、待っている承認はまた出す（対）', () => {
    const t = draw(async () => Response.json({ ok: true }));
    (t.ctx.showHistory as (m: unknown[]) => void)([]);
    assert.equal(t.asks(), 0);
    t.emit('approval', again);
    assert.equal(t.asks(), 1, '描き直した後に、待っている承認を出していない');
  });
});

describe('会話を開いていなくても、待っている承認は出す', () => {
  test('**パネルを作り直したとき、トップでも待っている承認を取り直す**', async () => {
    const waiting = { id: 'b1', request: { kind: 'write', path: 'b.txt', diff: DIFF, created: false } };
    const t = draw(async (url) => url.includes('/api/approvals')
      ? Response.json({ approvals: [waiting], busy: true, planning: false })
      : Response.json({ ok: true }));
    // draw が出した a1 に加えて、取り直した b1 が出る
    await until(() => t.asks() === 2, `待っている承認を出していない（${t.asks()} 個）`);
  });
});
