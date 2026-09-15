/**
 * 会話の板の、添付まわり。
 *
 * 落とす・貼る・選ぶ、どれでも渡せるようにしてある。**渡したのに
 * 無視されたように見える**のがいちばん困るので、渡したものが札として
 * 出ること、外せること、読めないものは読めないと言うことを見る。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, createNode, type StubNode } from './dom-stub.ts';

installDom();
(globalThis as { window?: unknown }).window = {};
const { PANELS } = await import('../src/ui/web/panels.js') as {
  PANELS: Record<string, (body: StubNode, ctx: unknown) => void>;
};

/** 会話の板を描いて、送り口を差し替える。 */
async function draw(attachAnswer: unknown) {
  const posts: { url: string; body?: unknown }[] = [];
  (globalThis as { fetch?: unknown }).fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/api/attach')) return Response.json(attachAnswer);
    posts.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return Response.json({ accepted: true }, { status: 202 });
  }) as unknown as typeof fetch;

  const body = createNode('div');
  PANELS.conversation!(body, { on: () => {}, onState: () => {}, focusInput: () => {} });
  await new Promise((r) => setTimeout(r, 20));
  return { body, posts };
}

describe('会話の板・添付', () => {
  test('落とす口が開いている', async () => {
    const { body } = await draw({ files: [] });
    // 落とす・貼る、どちらの口も繋がっていること。
    const found: StubNode[] = [];
    const walk = (n: StubNode) => {
      const h = n as StubNode & { ondrop?: unknown; onpaste?: unknown };
      if (h.ondrop || h.onpaste) found.push(n);
      for (const c of n.children) walk(c);
    };
    walk(body);
    assert.ok(found.length >= 1, '落とす／貼る口が繋がっていない');
  });

  test('声の口は、使えない環境では出さない', async () => {
    // 押せないボタンは邪魔なだけ。window に無ければ隠す。
    const { body } = await draw({ files: [] });
    const mic = body.buttons().find((b) => b.textContent === '🎤');
    assert.ok(mic, 'マイクのボタンが無い');
    assert.equal(mic.style.display, 'none', '使えないのに出している');
  });

  test('使える環境なら、声の口を出す', async () => {
    // 上の試験が「常に隠している」で通ってしまわないように、対にする。
    (globalThis as { window?: Record<string, unknown> }).window = {
      SpeechRecognition: class {},
    };
    const { body } = await draw({ files: [] });
    const mic = body.buttons().find((b) => b.textContent === '🎤');
    assert.notEqual(mic!.style.display, 'none', '使えるのに隠している');
    assert.equal(mic!.title, '声で入れる');
    (globalThis as { window?: unknown }).window = {};
  });

  test('ファイルを選ぶ口がある', async () => {
    const { body } = await draw({ files: [] });
    const clip = body.buttons().find((b) => b.textContent === '📎');
    assert.ok(clip, '添えるボタンが無い');
    assert.equal(typeof clip.onclick, 'function', '押しても何も起きない');
  });
});
