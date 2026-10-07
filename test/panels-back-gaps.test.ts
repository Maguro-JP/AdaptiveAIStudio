/**
 * パネルの JS の後半の不具合（59 回目の調査）。
 *
 * - 点検のパネルを作り直すと、本体で回っている点検の止めるボタンが隠れた
 * - 閉じたエディタの場所と選択を、送るたびに付け続けた（見えない欄を書き換える口も残った）
 * - 戻した結果の一言が、先に配られる差分の描き直しで見えなかった
 * - メモに打った直後にパネルを作り直すと、最後に打った分が抜けた
 * - エディタの探すで、先頭の当たりから「前へ」を押しても末尾へ回らなかった
 * - 本体を立ち上げ直すと、番号が数え直されてログが一行も出なかった
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, createNode, type StubNode } from './dom-stub.ts';
import { until } from './until.ts';

installDom();
(globalThis as { window?: unknown }).window = {};
const { PANELS } = await import('../src/ui/web/panels.js') as {
  PANELS: Record<string, (body: StubNode, ctx: unknown, spec?: unknown) => void>;
};

const find = (want: (n: StubNode) => boolean, n: StubNode): StubNode | undefined => {
  if (want(n)) return n;
  for (const c of n.children) { const got = find(want, c); if (got) return got; }
  return undefined;
};
const button = (body: StubNode, label: string) => find((n) => n.tagName === 'button' && n.textContent === label, body);
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function withHandlers() {
  const handlers = new Map<string, Array<(e: unknown) => void>>();
  return {
    on: (type: string, fn: (e: unknown) => void) => { if (!handlers.has(type)) handlers.set(type, []); handlers.get(type)!.push(fn); },
    emit: (type: string, e: unknown) => { for (const fn of handlers.get(type) ?? []) fn(e); },
  };
}

describe('点検', () => {
  test('**作り直したパネルでも、回っている点検の止めるボタンを出す**', async () => {
    (globalThis as { fetch?: unknown }).fetch = (async () => Response.json({ tasks: [{ id: 'test', name: 'テストを回す' }], running: ['test'] })) as unknown as typeof fetch;
    const body = createNode('div');
    PANELS.checks!(body, { on: () => undefined });
    await until(() => button(body, 'テストを回す') !== undefined, '点検の一覧が出ない');
    assert.equal(button(body, '止める')!.hidden, false, '回っているのに、止めるボタンが隠れている');
    assert.equal(button(body, 'テストを回す')!.disabled, true);
  });
});

function editor(disk: Record<string, string>) {
  (globalThis as { fetch?: unknown }).fetch = (async (url: string) => {
    const path = decodeURIComponent(String(url).split('path=')[1] ?? '');
    return disk[path] === undefined ? Response.json({ error: '無い' }, { status: 404 }) : Response.json({ path, content: disk[path], stamp: disk[path] });
  }) as unknown as typeof fetch;
  let gen = 1;
  const h = withHandlers();
  const body = createNode('div');
  const ctx: Record<string, unknown> = { on: h.on, onDiscard: () => undefined, gen: () => gen };
  PANELS.editor!(body, ctx);
  return { body, ctx, discard: () => { gen += 1; } };
}

describe('エディタ', () => {
  test('**閉じたエディタの場所は、もう送らない**', async () => {
    localStorage.clear();
    const { body, ctx, discard } = editor({ 'a.ts': 'one\n' });
    (ctx.openFile as (p: string) => void)('a.ts');
    await until(() => find((n) => n.tagName === 'textarea', body)!.value === 'one\n', 'ファイルが開く');
    assert.ok((ctx.editorNow as () => unknown)(), '前提: 開いている間は場所を言う');
    discard();
    assert.equal((ctx.editorNow as () => unknown)(), null, '閉じたエディタの場所を送り続けた');
    assert.equal((ctx.applyPatch as (p: unknown) => boolean)({ path: 'a.ts', from: 0, to: 0, text: 'one', replace: 'two' }), false, '閉じたエディタの欄を書き換えた');
  });

  test('**先頭の当たりで「前へ」を押すと、末尾の当たりへ回る**', async () => {
    localStorage.clear();
    const { body, ctx } = editor({ 'b.ts': 'ab ab' });
    (ctx.openFile as (p: string) => void)('b.ts');
    const area = () => find((n) => n.tagName === 'textarea', body)!;
    await until(() => area().value === 'ab ab', 'ファイルが開く');
    find((n) => n.className === 'find-q', body)!.value = 'ab';
    area().selectionStart = 0;
    area().selectionEnd = 2;
    button(body, '前へ')!.onclick!();
    assert.equal(area().selectionStart, 3, '先頭から前へ回らなかった');
  });
});

describe('メモ', () => {
  test('**作り直す前に、まだ送っていない分を送る**', async () => {
    const saved: string[] = [];
    const discards: Array<() => void> = [];
    const body = createNode('div');
    PANELS.note!(body, { saveNote: async (_id: string, text: string) => { saved.push(text); return true; }, onDiscard: (fn: () => void) => discards.push(fn) }, { id: 'n1', options: { text: '' } });
    const area = find((n) => n.tagName === 'textarea', body)!;
    area.value = '最後に打った分';
    area.fire('input');
    for (const fn of discards) fn();
    await settle();
    assert.deepEqual(saved, ['最後に打った分'], '作り直す前に送らなかった');
    await settle(700);
    assert.equal(saved.length, 1, '同じ分を二度送った');
  });
});

describe('ログ', () => {
  test('**本体が数え直したら、新しい行を出す**', async () => {
    (globalThis as { fetch?: unknown }).fetch = (async () => Response.json({ lines: [] })) as unknown as typeof fetch;
    const h = withHandlers();
    const body = createNode('div');
    PANELS.log!(body, { on: h.on });
    await settle();
    h.emit('log', { seq: 5, level: 'info', text: '前の本体' });
    h.emit('log', { seq: 1, level: 'info', text: '立ち上げ直した本体' });
    assert.match(body.text, /立ち上げ直した本体/, '数え直した後の行を捨てた');
  });
});

describe('変更したファイル', () => {
  test('**戻した結果の一言は、先に配られた差分で描き直しても見える**', async () => {
    const h = withHandlers();
    const diff = '--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,1 @@\n-one\n+two\n';
    (globalThis as { fetch?: unknown }).fetch = (async (url: string) => {
      if (String(url).includes('/api/revert')) {
        // 本体は返事より先に差分を配る
        h.emit('session', { event: { type: 'diff', path: 'a.ts', diff: '--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,1 @@\n-two\n+one\n', added: 1, removed: 1 } });
        return Response.json({ reverted: true, added: 1, removed: 1 });
      }
      return Response.json({ files: [] });
    }) as unknown as typeof fetch;
    (globalThis as { confirm?: unknown }).confirm = () => true;
    const body = createNode('div');
    PANELS.changes!(body, { on: h.on });
    h.emit('session', { event: { type: 'diff', path: 'a.ts', diff, added: 1, removed: 1, created: false } });
    const box = find((n) => n.tagName === 'details', body) as unknown as { open: boolean; ontoggle: () => void };
    box.open = true;
    box.ontoggle();
    const revert = find((n) => n.tagName === 'button' && /戻す/.test(n.textContent), body);
    assert.ok(revert, '前提: 戻すボタンが無い');
    await revert!.onclick!();
    await settle(30);
    assert.match(body.text, /戻しました/, '戻した結果の一言が見えない');
  });
});
