/**
 * 画面の JS の不具合（24 回目の調査）。
 *
 * - 戻り先の時刻は、今日でなければ日付も出す（日本時間）
 * - 「探す」で、空にして押した後・次の検索を始めた後に、前の結果を足さない
 * - 提案の札は、描き直しをまたいで開いたまま・断られた理由も残す・伝えている間は押せない
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, createNode, type StubNode } from './dom-stub.ts';
import { until } from './until.ts';

installDom();
const { PANELS } = await import('../src/ui/web/panels.js') as {
  PANELS: Record<string, (body: StubNode, ctx: unknown) => void>;
};
const { undoWhen } = await import('../src/ui/web/undo-scope.js') as unknown as { undoWhen: (at: number, now?: number) => string };

const dump = (n: StubNode): string => {
  let out = n.textContent ?? '';
  for (const c of n.children) out += ` ${dump(c)}`;
  return out;
};
const find = (root: StubNode, want: (n: StubNode) => boolean): StubNode | undefined => {
  if (want(root)) return root;
  for (const c of root.children) { const got = find(c, want); if (got) return got; }
  return undefined;
};

describe('戻り先の時刻', () => {
  // 2026-10-04 14:00 JST
  const NOW = Date.UTC(2026, 9, 4, 5, 0);
  test('**今日なら時刻だけ、今日でなければ月日も、年が違えば年も出す**（日本時間）', () => {
    assert.equal(undoWhen(NOW - 60 * 60 * 1000, NOW), '13:00');
    assert.equal(undoWhen(NOW - 3 * 86_400_000, NOW), '10/1 14:00');
    assert.equal(undoWhen(Date.UTC(2025, 11, 31, 14, 0), NOW), '2025/12/31 23:00');
  });
  test('**日本時間の日付で分ける**（UTC では前の日でも、日本時間で今日なら時刻だけ）', () => {
    // 2026-10-04 00:30 JST は UTC では 10/3
    assert.equal(undoWhen(Date.UTC(2026, 9, 3, 15, 30), NOW), '00:30');
  });
});

describe('探す', () => {
  test('**空にして押したら、前の検索の結果を出さない**', async () => {
    (globalThis as { fetch?: unknown }).fetch = (async () => {
      await new Promise((r) => setTimeout(r, 80));
      return Response.json({ hits: [{ path: 'src/old.ts', line: 1, text: 'foo' }] });
    }) as unknown as typeof fetch;
    const body = createNode('div');
    PANELS.search!(body, { on: () => undefined });
    const q = find(body, (n) => (n.className ?? '').includes('search-q'))!;
    const go = find(body, (n) => n.textContent === '探す' && typeof n.onclick === 'function')!;
    q.value = 'foo';
    go.onclick!();
    q.value = '';
    go.onclick!();
    await new Promise((r) => setTimeout(r, 250));
    assert.ok(!dump(body).includes('src/old.ts'), `前の結果が出た: ${dump(body)}`);
    assert.ok(dump(body).includes('探す文字を入れてください'));
  });
});

describe('提案の札', () => {
  function open(refuse: boolean) {
    let onState: (() => void) | undefined;
    (globalThis as { fetch?: unknown }).fetch = (async (url: string) => {
      if (String(url).includes('/api/proposals')) {
        return Response.json({ open: [{ id: 'p1', kind: 'bug', title: '直すこと', rationale: '理由' }], spent: '0', dropped: 0, due: [] });
      }
      return refuse ? Response.json({ error: 'いま作業中です' }, { status: 409 }) : Response.json({ ok: true });
    }) as unknown as typeof fetch;
    const body = createNode('div');
    PANELS.proposals!(body, { on: () => undefined, onState: (fn: () => void) => { onState = fn; } });
    return { body, redraw: () => onState?.() };
  }
  const card = (body: StubNode) => find(body, (n) => (n.className ?? '').includes('proposal') && n.tagName === 'details');

  test('**開いて読んでいた札は、描き直しても閉じない**', async () => {
    const t = open(false);
    await until(() => card(t.body) !== undefined, '札が出る', { timeoutMs: 5000 });
    const box = card(t.body)! as StubNode & { open?: boolean; ontoggle: () => void };
    box.open = true;
    box.ontoggle();
    t.redraw();
    await until(() => card(t.body) !== undefined && card(t.body) !== box, '描き直す', { timeoutMs: 5000 });
    assert.equal((card(t.body) as StubNode & { open?: boolean }).open, true);
  });

  test('**断られた理由は、描き直しても残る**', async () => {
    const t = open(true);
    await until(() => card(t.body) !== undefined, '札が出る', { timeoutMs: 5000 });
    const yes = find(t.body, (n) => n.textContent === 'やってもらう' && typeof n.onclick === 'function')!;
    yes.onclick!();
    await until(() => dump(t.body).includes('いま作業中です'), '理由が出る', { timeoutMs: 5000 });
    t.redraw();
    await new Promise((r) => setTimeout(r, 1800)); // 断られた後の描き直し（1.5 秒）も待つ
    assert.ok(dump(t.body).includes('いま作業中です'), `理由が消えた: ${dump(t.body)}`);
  });
});
