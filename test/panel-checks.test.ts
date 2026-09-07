/**
 * 画面の「点検」板。
 *
 * cmd の窓でしかできなかったものを、ここへ移した。
 * **移した先が動かないなら、移していないのと同じ**なので、
 * 描けているか・押せているか・流れてきたものを出せているかを見る。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, createNode, type StubNode } from './dom-stub.ts';

installDom();
const { PANELS, TITLES } = await import('../src/ui/web/panels.js') as {
  PANELS: Record<string, (body: StubNode, ctx: unknown) => void>;
  TITLES: Record<string, string>;
};

const TASKS = {
  tasks: [
    { id: 'doctor', name: 'この環境を見てもらう' },
    { id: 'test', name: '検査を回す' },
  ],
  running: null,
};

/** 板を描いて、落ち着くまで待つ。出来事は手で流せるようにして返す。 */
async function draw(taskAnswer: unknown = TASKS, postStatus = 200) {
  const posts: unknown[] = [];
  (globalThis as { fetch?: unknown }).fetch = (async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)));
      return postStatus === 200
        ? Response.json({ started: 'doctor' })
        : Response.json({ error: '回しています' }, { status: postStatus });
    }
    return Response.json(taskAnswer);
  }) as unknown as typeof fetch;

  const handlers = new Map<string, ((e: unknown) => void)[]>();
  const body = createNode('div');
  PANELS.checks!(body, {
    on: (type: string, fn: (e: unknown) => void) => {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type)!.push(fn);
    },
  });
  await new Promise((r) => setTimeout(r, 20));
  const emit = (type: string, e: unknown) => {
    for (const fn of handlers.get(type) ?? []) fn(e);
  };
  return { body, posts, emit };
}

/** 板の中から、押せるものを名前で探す。 */
function button(body: StubNode, text: string): StubNode | undefined {
  const found: StubNode[] = [];
  const walk = (n: StubNode) => {
    if (n.tagName === 'button' && n.textContent === text) found.push(n);
    for (const c of n.children) walk(c);
  };
  walk(body);
  return found[0];
}

describe('点検の板', () => {
  test('回せるものが並ぶ', async () => {
    const { body } = await draw();
    assert.ok(button(body, 'この環境を見てもらう'), 'doctor のボタンが無い');
    assert.ok(button(body, '検査を回す'), '検査のボタンが無い');
    assert.equal(TITLES.checks, '診断');
  });

  test('押すと、その名前で頼む', async () => {
    const { body, posts } = await draw();
    await button(body, 'この環境を見てもらう')!.onclick!();
    assert.deepEqual(posts, [{ name: 'doctor' }]);
  });

  test('流れてきたものを、そのまま出す', async () => {
    const { body, emit } = await draw();
    emit('task', { name: 'doctor', text: 'ok  Node.js\n' });
    emit('task', { name: 'doctor', text: 'ok  設定\n' });
    assert.match(body.text, /ok {2}Node\.js/);
    assert.match(body.text, /ok {2}設定/);
  });

  test('終わったことを言う。黙って戻らない', async () => {
    const { body, emit } = await draw();
    emit('taskDone', { name: 'doctor', code: 0 });
    assert.match(body.text, /終わりました/);
  });

  test('終了コードが立っていたら、その数を出す', async () => {
    const { body, emit } = await draw();
    emit('taskDone', { name: 'test', code: 3 });
    assert.match(body.text, /終了コード 3/);
  });

  test('始められなかったら、理由を出す', async () => {
    const { body } = await draw(TASKS, 409);
    await button(body, '検査を回す')!.onclick!();
    await new Promise((r) => setTimeout(r, 10));
    assert.match(body.text, /回しています/);
  });
});
