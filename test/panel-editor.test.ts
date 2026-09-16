/**
 * エディタのパネルを、押して動かす。
 *
 * ここまでエディタの試験は、`panels.js` の中に決まった文字が在るかを
 * 見るだけだった。文字が在ることは、押したときに動くことを言わない。
 *
 * 実際に、保存したあとの「保存しました（+2 -1）」が消えていた。
 * 手で保存すると本体が差分を全員へ配り、配られた写しでこのパネルが
 * 同じファイルを読み直して、出ている言葉を上書きしていた。
 * 書けたのか、何行変わったのかが画面から消える。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, createNode, type StubNode } from './dom-stub.ts';
import { until } from './until.ts';

installDom();
const { PANELS } = await import('../src/ui/web/panels.js') as {
  PANELS: Record<string, (body: StubNode, ctx: unknown) => void>;
};

/** パネルを開く。ファイルの中身は `disk` が返し、叩いた先と PUT を控える。 */
function open(disk: Record<string, string>) {
  const asked: Array<{ url: string; method: string; body?: unknown }> = [];
  (globalThis as { fetch?: unknown }).fetch = (async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body) as { path: string; content: string } : undefined;
    asked.push({ url: String(url), method, body });
    if (method === 'PUT') {
      disk[body!.path] = body!.content;
      return Response.json({ saved: true, path: body!.path, added: 1, removed: 1 });
    }
    const path = decodeURIComponent(String(url).split('path=')[1] ?? '');
    const content = disk[path];
    if (content === undefined) return Response.json({ error: '無い' }, { status: 404 });
    return Response.json({ path, content });
  }) as unknown as typeof fetch;

  const handlers = new Map<string, Array<(e: unknown) => void>>();
  const body = createNode('div');
  const ctx: Record<string, unknown> = {
    on: (type: string, fn: (e: unknown) => void) => {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type)!.push(fn);
    },
  };
  PANELS.editor!(body, ctx);
  const emit = (type: string, event: unknown) => {
    for (const fn of handlers.get(type) ?? []) fn({ event });
  };
  /** パネルの中を、種類で探す。 */
  const find = (want: (n: StubNode) => boolean): StubNode => {
    const walk = (n: StubNode): StubNode | undefined => {
      if (want(n)) return n;
      for (const c of n.children) { const got = walk(c); if (got) return got; }
      return undefined;
    };
    const got = walk(body);
    assert.ok(got, '見つからない');
    return got;
  };
  return {
    emit, asked, ctx,
    area: () => find((n) => n.tagName === 'textarea'),
    state: () => find((n) => n.className.includes('editor-state')),
    save: () => find((n) => n.tagName === 'button'),
  };
}

describe('エディタのパネル', () => {
  test('**保存したあと、自分の書き込みの写しで言葉が消えない**', async () => {
    const disk = { 'a.txt': 'one\n' };
    const { emit, ctx, area, state, save } = open(disk);
    (ctx.openFile as (p: string) => void)('a.txt');
    await until(() => area().value === 'one\n', 'ファイルが開く');

    // 直して、保存を押す。
    area().value = 'two\n';
    area().fire('input');
    assert.equal(save().disabled, false, '直したのに保存が押せない');
    save().onclick!();
    await until(() => /保存しました/.test(state().textContent), '保存したと出る');
    assert.match(state().textContent, /\+1 -1/);
    assert.equal(disk['a.txt'], 'two\n', '書けていない');

    // 本体が配る差分（自分の書き込みの写し）が届く。
    emit('session', { type: 'diff', path: 'a.txt', diff: '@@ -1 +1 @@\n-one\n+two', added: 1, removed: 1, created: false });
    // 読み直しは非同期なので、届いたあとに入る隙を作ってから見る。
    await new Promise((r) => setTimeout(r, 30));
    assert.match(state().textContent, /保存しました/,
      `自分の写しで「保存しました」が消えている: ${state().textContent}`);
  });

  /**
   * 保存していない直しを、黙って捨てないこと。
   *
   * 横の一覧で別のファイルを押すと、読み直した中身をそのまま欄へ入れていた。
   * **確認も警告も無く、書いていたものが消える。**よそからの書き換えには
   * `!dirty()` の番が在るのに、人が別のファイルを開く道には無かった。
   */
  test('**別のファイルを開いても、保存していない直しは消えない**', async () => {
    const disk = { 'a.txt': 'aaa\n', 'b.txt': 'bbb\n' };
    const { ctx, area, state } = open(disk);
    const openFile = ctx.openFile as (p: string) => void;
    openFile('a.txt');
    await until(() => area().value === 'aaa\n', 'a.txt が開く');

    // まだ保存していない直し。
    area().value = 'まだ保存していない大事な直し\n';
    area().fire('input');
    assert.match(state().textContent, /直しています/);

    // 横の一覧で b.txt を押す。
    openFile('b.txt');
    await until(() => area().value === 'bbb\n', 'b.txt が開く');

    // a.txt へ戻ると、直しが返ってくる。
    openFile('a.txt');
    await until(() => area().value === 'まだ保存していない大事な直し\n',
      `保存していない直しが消えた: ${area().value}`);
    assert.match(state().textContent, /戻しました/, state().textContent);
    assert.equal(disk['a.txt'], 'aaa\n', '勝手に保存している');
  });

  test('よそで書き換わったら、読み直して入れ替える（対）', async () => {
    const disk = { 'a.txt': 'one\n' };
    const { emit, ctx, area, state } = open(disk);
    (ctx.openFile as (p: string) => void)('a.txt');
    await until(() => area().value === 'one\n', 'ファイルが開く');

    // モデルが書き換えた形。中身が変わっているので、入れ替える。
    disk['a.txt'] = 'model\n';
    emit('session', { type: 'diff', path: 'a.txt', diff: '@@ -1 +1 @@\n-one\n+model', added: 1, removed: 1, created: false });
    await until(() => area().value === 'model\n', 'よその書き換えを読み直す');
    assert.match(state().textContent, /保存してあります/, state().textContent);
  });
});
