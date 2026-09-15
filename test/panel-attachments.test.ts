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
import { until } from './until.ts';

installDom();
(globalThis as { window?: unknown }).window = {};
const { PANELS } = await import('../src/ui/web/panels.js') as {
  PANELS: Record<string, (body: StubNode, ctx: unknown) => void>;
};

/**
 * 会話のパネルを描いて、送り口を差し替える。
 *
 * `attachAnswer` は `/api/attach` の返事。関数を渡せば、要求ごとに
 * 別の返事をさせられる（一つ目は通し、二つ目は断る、など）。
 */
async function draw(
  attachAnswer: unknown | ((url: string, init?: RequestInit) => { body: unknown; status?: number }),
) {
  const posts: { url: string; method: string; body?: unknown }[] = [];
  (globalThis as { fetch?: unknown }).fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    if (u.includes('/api/attach')) {
      posts.push({ url: u, method });
      if (typeof attachAnswer === 'function') {
        const got = (attachAnswer as (url: string, init?: RequestInit) => { body: unknown; status?: number })(u, init);
        return Response.json(got.body, { status: got.status ?? 200 });
      }
      return Response.json(attachAnswer);
    }
    posts.push({ url: u, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return Response.json({ accepted: true }, { status: 202 });
  }) as unknown as typeof fetch;

  const body = createNode('div');
  PANELS.conversation!(body, { on: () => {}, onState: () => {}, focusInput: () => {} });
  await new Promise((r) => setTimeout(r, 20));
  return { body, posts };
}

/** 中を歩いて、条件に合う節を集める。 */
function all(root: StubNode, want: (n: StubNode) => boolean): StubNode[] {
  const out: StubNode[] = [];
  const walk = (n: StubNode) => {
    if (want(n)) out.push(n);
    for (const c of n.children) walk(c);
  };
  walk(root);
  return out;
}

/** 落とす所を探して、ファイルを落とす。 */
function drop(body: StubNode, files: { name: string }[]): void {
  const zone = all(body, (n) => typeof (n as StubNode & { ondrop?: unknown }).ondrop === 'function')[0];
  assert.ok(zone, '落とす口が繋がっていない');
  (zone as StubNode & { ondrop: (e: unknown) => void }).ondrop({
    preventDefault: () => undefined,
    dataTransfer: { files },
  });
}

/**
 * 添えたものの札。**渡している途中の札（pending）は数えない。**
 *
 * 数に入れていたので、「札が出た」が**渡している途中で満たされ**、
 * 大きさもまだ無いのに次へ進んでいた（この試験を書いたときにそうなった）。
 */
const chips = (body: StubNode) => all(body, (n) => {
  const cls = n.className.split(/\s+/);
  return cls.includes('attachment') && !cls.includes('pending');
});

describe('会話のパネル・添付', () => {
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

  /*
   * **渡したものが札として出るところまでを見る。**
   *
   * ここまでの試験は、口が繋がっていること・押し場所が在ることだけを見ていた。
   * 繋がっていても、渡したものが出なければ**渡したのに無視されたように見える**。
   * それがいちばん困る形なので、そこを見る。
   */
  test('**落としたものが、札として出る**', async () => {
    const { body, posts } = await draw({ id: 'a1', name: 'メモ.txt', kind: 'text', bytes: 2048 });
    drop(body, [{ name: 'メモ.txt' }]);
    await until(() => chips(body).some((c) => c.text.includes('メモ.txt')), '札が出る', { timeoutMs: 5000 });
    const chip = chips(body).find((c) => c.text.includes('メモ.txt'))!;
    assert.match(chip.text, /2KB/, `大きさを出していない: ${chip.text}`);
    assert.ok(posts.some((p) => p.url.includes('/api/attach') && p.method === 'POST'), '本体へ預けていない');
  });

  test('**× を押すと、札が消えて、本体からも外れる**', async () => {
    const { body, posts } = await draw({ id: 'a1', name: 'メモ.txt', kind: 'text', bytes: 2048 });
    drop(body, [{ name: 'メモ.txt' }]);
    await until(() => chips(body).some((c) => c.text.includes('メモ.txt')), '札が出る', { timeoutMs: 5000 });
    const x = chips(body).flatMap((c) => c.buttons()).find((b) => b.textContent === '×');
    assert.ok(x, '外す押し場所が無い');
    x.onclick!();
    assert.ok(!chips(body).some((c) => c.text.includes('メモ.txt')),
      `外したのに札が残っている: ${body.text}`);
    await until(() => posts.some((p) => p.method === 'DELETE' && p.url.includes('id=a1')),
      '本体からも外す', { timeoutMs: 5000 });
  });

  test('**読めないものは、読めないと言う**', async () => {
    // 黙って落とすと、渡したのに無視されたように見える。
    const { body } = await draw(() => ({ body: { error: 'これは読めません（画像を読めるモデルではありません）' }, status: 415 }));
    drop(body, [{ name: 'しゃしん.png' }]);
    await until(() => body.text.includes('これは読めません'), '読めないと言う', { timeoutMs: 5000 });
    assert.ok(body.text.includes('しゃしん.png'), `どれが読めないのかを言っていない: ${body.text}`);
    assert.deepEqual(chips(body).filter((c) => c.text.includes('しゃしん.png')), [],
      '読めなかったものを添えたことにしている');
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
