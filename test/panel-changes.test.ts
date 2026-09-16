/**
 * 「変更したファイル」のパネルは、作り直しても消えない。
 *
 * 差分を DOM とパネルの中の Map にしか持っていなかった。パネルを一枚出し入れする、
 * 設定→配置で型を変える、パネルの × を押す、のどれでも `render()` が全部を
 * 作り直すので中身が消え、そのうえ「まだ何も書き換えていません。」と
 * **事実と違うこと**を出していた。塊ごと・行ごとに戻す道はこのパネルから入るので、
 * 直したものに辿り着けなくなる。記録のパネルと同じく、本体が持って配る。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, createNode, type StubNode } from './dom-stub.ts';
import { until } from './until.ts';

installDom();
const { PANELS } = await import('../src/ui/web/panels.js') as {
  PANELS: Record<string, (body: StubNode, ctx: unknown) => void>;
};

interface Change { path: string; diff: string; added: number; removed: number; created: boolean }

/** パネルを開く。`/api/changes` は `past` を返す。叩いた先も控える。 */
function open(past: Change[]) {
  const asked: string[] = [];
  (globalThis as { fetch?: unknown }).fetch = (async (url: string) => {
    asked.push(String(url));
    return Response.json({ files: past });
  }) as unknown as typeof fetch;
  const handlers = new Map<string, Array<(e: unknown) => void>>();
  const body = createNode('div');
  PANELS.changes!(body, {
    on: (type: string, fn: (e: unknown) => void) => {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type)!.push(fn);
    },
  });
  const emit = (type: string, event: unknown) => {
    for (const fn of handlers.get(type) ?? []) fn({ event });
  };
  const text = () => dump(body);
  return { body, emit, asked, text };
}

/** パネルの中の文字を、全部つなげる。 */
function dump(node: StubNode): string {
  let out = node.textContent ?? '';
  for (const c of node.children) out += ` ${dump(c)}`;
  return out;
}

describe('変更したファイルのパネル', () => {
  test('**開いたら、本体が持っている差分を取り直す**', async () => {
    const { asked, text } = open([{
      path: 'src/a.ts', diff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-x\n+y', added: 1, removed: 1, created: false,
    }]);
    assert.ok(asked.some((u) => u.includes('/api/changes')), `取り直していない: ${asked.join(', ')}`);
    await until(() => dumpHas(text(), 'src/a.ts'), '取り直した差分が並ぶ');
    assert.ok(!dumpHas(text(), 'まだ何も書き換えていません'),
      `直したものが在るのに「何も書き換えていません」と出している: ${text()}`);
  });

  test('本体に何も無ければ、これまでどおり「まだ何も」と出す（対）', async () => {
    const { text } = open([]);
    await until(() => dumpHas(text(), 'まだ何も書き換えていません'), '案内が出る');
  });

  test('取り直したあとに届いた分も、重ねずに並ぶ', async () => {
    const { emit, text } = open([{
      path: 'src/a.ts', diff: '@@ -1 +1 @@\n-x\n+y', added: 1, removed: 1, created: false,
    }]);
    await until(() => dumpHas(text(), 'src/a.ts'), '取り直しが終わる');
    emit('session', { type: 'diff', path: 'src/b.ts', diff: '@@ -1 +1 @@\n-a\n+b', added: 1, removed: 0, created: true });
    await until(() => dumpHas(text(), 'src/b.ts'), '届いた分も並ぶ');
    assert.ok(dumpHas(text(), 'src/a.ts'), `取り直した分が消えている: ${text()}`);
    assert.ok(dumpHas(text(), '2 ファイル'), `件数が合っていない: ${text()}`);
  });
});

function dumpHas(text: string, want: string): boolean {
  return text.includes(want);
}

/**
 * 会話のパネルも、作り直したら自分で取り直す。
 *
 * 流し込む側（`ctx.showHistory`）を呼ぶのは「頁を開いた最初の一回」と
 * 「横の一覧から会話を選んだとき」だけだった。パネルを一枚出し入れすると
 * `render()` が全部を作り直すので、**話している途中でも画面から消える。**
 * 本体には残っているので、頁を読み直すまで戻らない。
 */
describe('会話のパネル', () => {
  function openChat(id: string | undefined, messages: unknown[]) {
    // 会話のパネルは音声の口を見る。stub には無いので、空で置いておく。
    (globalThis as { window?: unknown }).window = globalThis;
    const asked: string[] = [];
    (globalThis as { fetch?: unknown }).fetch = (async (url: string) => {
      asked.push(String(url));
      if (String(url).includes('/api/conversations/messages')) return Response.json({ messages });
      return Response.json({});
    }) as unknown as typeof fetch;
    const body = createNode('div');
    PANELS.conversation!(body, {
      on: () => undefined,
      onState: () => undefined,
      conversationId: () => id,
    });
    return { body, asked, text: () => dump(body) };
  }

  test('**作り直されたら、残してあるやり取りを取り直す**', async () => {
    const { asked, text } = openChat('c-1', [
      { role: 'user', content: 'MARKER-123 と答えて' },
      { role: 'assistant', content: 'MARKER-123' },
    ]);
    await until(() => asked.some((u) => u.includes('/api/conversations/messages')), '取り直しにいく');
    await until(() => text().includes('MARKER-123'), '残してあるやり取りが並ぶ');
  });

  test('見ている会話が無ければ、取りに行かない（対）', async () => {
    const { asked } = openChat(undefined, []);
    await new Promise((r) => { setTimeout(r, 50); });
    assert.ok(!asked.some((u) => u.includes('/api/conversations/messages')),
      `会話が無いのに取りに行った: ${asked.join(', ')}`);
  });
});
