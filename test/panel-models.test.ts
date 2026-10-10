/**
 * 画面の「モデル」板。
 *
 * 端末でしかモデルを用意できない状態だと、画面から使う人は
 * モデルを持てないまま止まる。だから板から用意も乗り換えもできるようにした。
 * ここはその板が、取ってきた内容をちゃんと出しているかの検査。
 *
 * 本物のブラウザは使わない。使えない環境では回せなくなり、
 * 回せない検査は無いのと同じになるため。必要な分だけの DOM を用意する。
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, createNode, type StubNode } from './dom-stub.ts';

installDom();
const { PANELS } = await import('../src/ui/web/panels.js') as {
  PANELS: Record<string, (body: StubNode, ctx: unknown) => void>;
};

const ANSWER = {
  runtime: 'ollama',
  installed: [{ ref: 'qwen3.5:9b', sizeBytes: 6.6 * 1024 ** 3 }],
  modelsDir: '/models',
  llamaServer: null,
  catalog: [
    { id: 'qwen3.5-4b', note: '最小構成', approxGB: 2.5, ref: 'qwen3.5:4b' },
    { id: 'qwen3.6-coding-35b', note: 'コード向け', approxGB: 22, ref: 'qwen3.6:35b-a3b-coding-nvfp4' },
  ],
};

/** 板を描いて、落ち着くまで待つ。 */
async function draw(answers: Record<string, unknown> = {}) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  (globalThis as { fetch?: unknown }).fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    calls.push({
      url: u,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const key = Object.keys(answers).find((k) => u.includes(k));
    const payload = key ? answers[key] : (u.includes('/api/models/newer') ? { findings: [] } : ANSWER);
    if (payload instanceof Error) throw payload;
    // 断られた返事（`{ status, body }` で渡す）
    const refused = payload as { refusedWith?: number; body?: unknown };
    if (typeof refused?.refusedWith === 'number') return Response.json(refused.body ?? {}, { status: refused.refusedWith });
    return Response.json(payload);
  }) as unknown as typeof fetch;

  const body = createNode('div');
  PANELS.models!(body, { onState: () => {} });
  await new Promise((r) => setTimeout(r, 20));
  return { body, calls };
}

describe('Ollama のときに、在るものを「ありません」と言わない', () => {
  /**
   * **保存先に .gguf を入れても、Ollama のときは一つも出なかった。**
   *
   * 画面は「まだありません。下から取ってこられます。」とだけ出す。落として
   * 置いた人には、何が起きているのか分からない（ブラウザでしか
   * 落とせないので、置く道がいちばん使われる）。しかも押し場所は
   * 「置いたものを読み直す」のままで、押しても何も変わらない。
   */
  test('**保存先に .gguf が在るなら、そう言って、切り替え先も言う**', async () => {
    const { body } = await draw({
      '/api/models': { ...ANSWER, runtime: 'ollama', installed: [], localGguf: 2 },
    });
    const said = body.text;
    assert.match(said, /Ollama には入っていません/, `何の一覧かを言っていない: ${said.slice(0, 200)}`);
    assert.match(said, /\.gguf が 2 件/, `保存先に在ることを言っていない: ${said.slice(0, 200)}`);
    assert.match(said, /中で読む/, `切り替え先を言っていない: ${said.slice(0, 200)}`);
    assert.doesNotMatch(said, /まだありません。下から取ってこられます。/, '在るのに「ありません」と言っている');
  });

  test('保存先にも無いなら、これまでどおり（対）', async () => {
    const { body } = await draw({
      '/api/models': { ...ANSWER, runtime: 'ollama', installed: [], localGguf: 0 },
    });
    assert.match(body.text, /まだありません。下から取ってこられます。/);
  });

  test('**押し場所の名前は、動かし方に合わせる**', async () => {
    // Ollama は保存先の .gguf を使わない。「置いたものを読み直す」と出していると、
    // 押しても何も変わらず、壊れていると読まれる。
    const ollama = await draw({ '/api/models': { ...ANSWER, runtime: 'ollama', installed: [], localGguf: 0 } });
    assert.ok(ollama.body.buttons().some((b) => b.textContent === '⟳ 一覧を取り直す'),
      `Ollama で名前が合っていない: ${ollama.body.buttons().map((b) => b.textContent).join('|')}`);
    const inproc = await draw({ '/api/models': { ...ANSWER, runtime: 'inproc', installed: [] } });
    assert.ok(inproc.body.buttons().some((b) => b.textContent === '⟳ 置いたものを読み直す'),
      `中で読む で名前が合っていない: ${inproc.body.buttons().map((b) => b.textContent).join('|')}`);
  });
});

describe('モデルの道は、開ける・コピーできる', () => {
  test('道が返っていれば、名前の隣に「開く」「コピー」が出て、開くは /api/open に道を渡す', async () => {
    const { body, calls } = await draw({
      '/api/models': { ...ANSWER, runtime: 'inproc', installed: [{ ref: 'a.gguf', sizeBytes: 1024 ** 3, path: '/models/a.gguf' }] },
      '/api/open': { opened: '/models/a.gguf' },
    });
    const opens = body.buttons().filter((b) => b.textContent === '開く');
    // 保存先の分と、モデル一つの分。
    assert.ok(opens.length >= 2, `開くが ${opens.length} 個`);
    const forModel = opens.find((b) => b.title.includes('/models/a.gguf'));
    assert.ok(forModel, '開くの先がモデルの道ではない');
    await forModel!.onclick!();
    await new Promise((r) => setTimeout(r, 5));
    const posted = calls.find((c) => c.url.includes('/api/open'));
    assert.ok(posted, '/api/open を叩いていない');
    assert.deepEqual(posted!.body, { path: '/models/a.gguf' });
  });

  test('道が無い（Ollama）なら、モデルの隣には出さない（対）', async () => {
    const { body } = await draw();
    const opens = body.buttons().filter((b) => b.textContent === '開く');
    assert.ok(opens.every((b) => !b.title.includes('qwen3.5:9b')), 'Ollama の名前に開くを付けている');
  });
});

describe('モデルの板', () => {
  test('ランタイムと手元のモデルを出す', async () => {
    const { body } = await draw();
    assert.match(body.text, /ランタイム/);
    assert.match(body.text, /ollama/);
    assert.match(body.text, /qwen3\.5:9b/, '手元のモデルが出ていない');
    assert.match(body.text, /6\.6GB/, '大きさが出ていない');
  });

  test('取ってこられるものを、押せる形で出す', async () => {
    const { body } = await draw();
    const labels = body.buttons().map((b) => b.textContent);
    assert.ok(labels.some((l) => l.includes('qwen3.5-4b')), labels.join(' / '));
    assert.ok(labels.some((l) => l.includes('約22GB')), '大きさを見せずに押させている');
  });

  test('押すと、その名前で取得を頼む', async () => {
    const { body, calls } = await draw();
    const get = body.buttons().find((b) => b.textContent.includes('qwen3.5-4b'))!;
    await get.onclick?.();
    await new Promise((r) => setTimeout(r, 10));

    const post = calls.find((c) => c.method === 'POST');
    assert.ok(post, '取得を頼んでいない');
    assert.equal(post.url.includes('/api/models/get'), true);
    assert.deepEqual(post.body, { id: 'qwen3.5-4b' });
  });

  test('llamacpp のときだけ llama-server の状態を出す', async () => {
    const withLlama = await draw({ '/api/models': { ...ANSWER, runtime: 'llamacpp', llamaServer: null } });
    assert.match(withLlama.body.text, /llama-server/);
    assert.match(withLlama.body.text, /未用意/);

    const ollama = await draw();
    assert.doesNotMatch(ollama.body.text, /llama-server/, 'Ollama なのに出している');
  });

  test('手元に無ければ、取ってこられると伝える', async () => {
    const { body } = await draw({ '/api/models': { ...ANSWER, installed: [] } });
    assert.match(body.text, /まだありません/);
  });

  test('新しい世代を確認できる', async () => {
    const { body } = await draw({
      '/api/models/newer': { findings: [{ current: 'qwen3.5', found: ['qwen3.6'] }] },
    });
    const check = body.buttons().find((b) => b.textContent.includes('新しい世代'))!;
    assert.ok(check, '確認するところが無い');
    await check.onclick?.();
    await new Promise((r) => setTimeout(r, 10));
    assert.match(check.textContent, /qwen3\.5 → qwen3\.6/);
  });

  test('**配布元に訊けなかった（502）のを、「新しい世代はありません」と言わない**', async () => {
    const { body } = await draw({
      '/api/models/newer': { refusedWith: 502, body: { error: 'fetch failed' } },
    });
    const check = body.buttons().find((b) => b.textContent.includes('新しい世代'))!;
    await check.onclick?.();
    await new Promise((r) => setTimeout(r, 10));
    assert.match(check.textContent, /訊けませんでした（fetch failed）/);
    assert.doesNotMatch(check.textContent, /ありません/);
  });

  test('新しいものが無ければ、無いと言う', async () => {
    const { body } = await draw();
    const check = body.buttons().find((b) => b.textContent.includes('新しい世代'))!;
    await check.onclick?.();
    await new Promise((r) => setTimeout(r, 10));
    assert.match(check.textContent, /ありません/);
  });

  test('状態を取れなくても、板が壊れない', async () => {
    const { body } = await draw({ '/api/models': new Error('down') });
    assert.match(body.text, /取れませんでした/);
  });
});

describe('取ってこられなかったことを、押した場所に出す', () => {
  /**
   * 失敗はログの板へ流すだけだった。押したのはモデルの板なので、
   * ログの板を開いていない人には**何も見えない**。押しても永久に何も
   * 起きないように見える。
   */
  test('**失敗した理由が、この板に出る**', async () => {
    const { body } = await draw({
      '/api/models': {
        ...ANSWER,
        fetching: {
          id: 'qwen3.5-4b',
          state: 'failed',
          message: '取ってこられませんでした: 配布元に断られました (403)。',
        },
      },
    });
    assert.match(body.text, /取ってこられませんでした/, '押した板に理由が出ていない');
    assert.match(body.text, /403/);
  });

  test('取っている最中も出る', async () => {
    const { body } = await draw({
      '/api/models': {
        ...ANSWER,
        fetching: { id: 'qwen3.5-4b', state: 'running', message: '一覧を調べます' },
      },
    });
    assert.match(body.text, /取得中/, '進んでいることが出ていない');
  });

  test('何も取っていなければ、何も出さない（対）', async () => {
    const { body } = await draw({ '/api/models': { ...ANSWER, fetching: null } });
    assert.doesNotMatch(body.text, /取ってこられませんでした|取得中/);
  });
});
