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
async function draw(taskAnswer: unknown = TASKS, postStatus = 200, onDelete: () => Promise<Response> = async () => Response.json({ stopped: [] })) {
  const posts: unknown[] = [];
  (globalThis as { fetch?: unknown }).fetch = (async (url: string, init?: RequestInit) => {
    if (init?.method === 'DELETE') return onDelete();
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

  test('止められなかったら、そう言う（繋がらない・断られた）', async () => {
    const down = await draw(TASKS, 200, async () => { throw new TypeError('Failed to fetch'); });
    await button(down.body, 'この環境を見てもらう')!.onclick!();
    await button(down.body, '止める')!.onclick!();
    assert.match(down.body.text, /止められませんでした（Failed to fetch）/);
    // 点検が終わって止める口が消えたら、止められなかった知らせも残さない
    down.emit('taskDone', { name: 'doctor', code: 0 });
    assert.doesNotMatch(down.body.text, /止められませんでした/);

    const refused = await draw(TASKS, 200, async () => Response.json({ error: '本体が止められませんでした' }, { status: 500 }));
    await button(refused.body, 'この環境を見てもらう')!.onclick!();
    await button(refused.body, '止める')!.onclick!();
    assert.match(refused.body.text, /本体が止められませんでした/);
  });

  test('本体で動いていなかった分は、実行中のまま残さない', async () => {
    const { body } = await draw(TASKS, 200, async () => Response.json({ stopped: [] }));
    const doctor = button(body, 'この環境を見てもらう')!;
    await doctor.onclick!();
    assert.equal(doctor.disabled, true);
    await button(body, '止める')!.onclick!();
    assert.equal(doctor.disabled, false, '押せるように戻っていない');
    assert.match(body.text, /もう動いていませんでした: この環境を見てもらう/);
    assert.doesNotMatch(body.text, /実行中/);
  });

  test('止める返事を待つ間に終わった分は、「終わりました」のまま', async () => {
    let answer!: (r: Response) => void;
    const { body, emit } = await draw(TASKS, 200, () => new Promise<Response>((r) => { answer = r; }));
    await button(body, 'この環境を見てもらう')!.onclick!();
    const stopping = button(body, '止める')!.onclick!();
    emit('taskDone', { name: 'doctor', code: 0 });
    answer(Response.json({ stopped: [] }));
    await stopping;
    assert.match(body.text, /終わりました: この環境を見てもらう/);
    assert.doesNotMatch(body.text, /もう動いていませんでした/);
  });

  test('始まりを頼んでいる途中の分は、止める答えに無くても実行中のまま', async () => {
    let started!: (r: Response) => void;
    const { body } = await draw(TASKS, 200, async () => Response.json({ stopped: [] }));
    const inner = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => (init?.method === 'POST'
      ? new Promise<Response>((r) => { started = r; })
      : inner(url, init))) as typeof fetch;
    const doctor = button(body, 'この環境を見てもらう')!;
    const starting = doctor.onclick!();
    await button(body, '止める')!.onclick!();
    assert.equal(doctor.disabled, true, '始まりの返事の前に、押せるように戻した');
    assert.doesNotMatch(body.text, /もう動いていませんでした/);
    started(Response.json({ started: 'doctor' }));
    await starting;
  });

  test('止めた分は、終わりの知らせが来るまで実行中のまま', async () => {
    const { body, emit } = await draw(TASKS, 200, async () => Response.json({ stopped: ['doctor'] }));
    const doctor = button(body, 'この環境を見てもらう')!;
    await doctor.onclick!();
    await button(body, '止める')!.onclick!();
    assert.equal(doctor.disabled, true);
    assert.doesNotMatch(body.text, /止められませんでした|もう動いていませんでした/);
    emit('taskDone', { name: 'doctor', code: 143 });
    assert.equal(doctor.disabled, false);
  });
});
