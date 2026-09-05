/**
 * 画面から押して、モデルが置かれるまで。
 *
 * ここまで確かめていたのは `installModel` 単体だけで、**画面から押す道は
 * 誰も通していなかった。**利用者が最初にやるのはそこなので、
 * そこが繋がっていなければ「何も起きない」に見える。
 *
 * 本物の配布元は使わない（落とせない場所があり、数GBかかる）。
 * 偽の配布元を手元に立てて、同じ道を通す。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';

/** GGUF の顔をした、小さな中身。頭の4文字だけが見られる。 */
function ggufBody(size = 4096): Buffer {
  const buf = Buffer.alloc(size);
  buf.write('GGUF');
  return buf;
}

/** 偽の配布元。`plan` で「一覧に何を返すか」を決める。 */
async function fakeHf(opts: { listStatus?: number; files?: string[] } = {}) {
  const files = opts.files ?? ['model-Q4_K_M.gguf'];
  const srv = createServer((req, res) => {
    if (req.url?.startsWith('/api/models/')) {
      if (opts.listStatus && opts.listStatus !== 200) {
        res.writeHead(opts.listStatus, { 'content-type': 'application/json' });
        return res.end('{}');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ siblings: files.map((f) => ({ rfilename: f })) }));
    }
    const body = ggufBody();
    res.writeHead(200, { 'content-length': String(body.length) });
    res.end(body);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address() as AddressInfo;
  return {
    fetchImpl: ((u: string | URL, init?: RequestInit) =>
      fetch(String(u).replace('https://huggingface.co', `http://127.0.0.1:${port}`), init)) as typeof fetch,
    close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }),
  };
}

/** 画面を立てて、出来事を集めながら押す。 */
async function press(id: string, hf: Awaited<ReturnType<typeof fakeHf>>, models: string) {
  const { UiServer } = await import('../src/ui/server.ts');
  const { DEFAULT_CONFIG } = await import('../src/config.ts');
  const home = await tempDir('aas-getui-home-');
  const prev = { home: process.env.AAS_HOME, state: process.env.AAS_STATE_DIR, cfg: process.env.AAS_CONFIG };
  process.env.AAS_HOME = home;
  process.env.AAS_STATE_DIR = join(home, 'state');
  process.env.AAS_CONFIG = join(home, 'aas.config.json');

  const server = new UiServer({
    port: 0,
    modelFetch: hf.fetchImpl,
    config: {
      ...DEFAULT_CONFIG,
      runtime: { kind: 'inproc', modelsDir: models },
      agent: { root: home, approval: 'auto' },
      initiative: { enabled: false },
    } as never,
  });
  const base = (await server.start()).replace(/\/$/, '');
  const said: string[] = [];
  try {
    const ac = new AbortController();
    const events = await fetch(`${base}/api/events`, { signal: ac.signal });
    const reader = events.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';

    const r = await fetch(`${base}/api/models/get`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    const status = r.status;

    // 終わりの合図（用意できました／取ってこられませんでした）まで待つ。
    const until = Date.now() + 30_000;
    let done = false;
    while (Date.now() < until && !done) {
      const step = await Promise.race([
        reader.read(),
        new Promise<{ value?: Uint8Array }>((res) => setTimeout(() => res({ value: undefined }), 300)),
      ]);
      if (step.value) buf += dec.decode(step.value, { stream: true });
      done = /用意できました|取ってこられませんでした/.test(buf);
    }
    ac.abort();
    for (const m of buf.matchAll(/"text":"((?:[^"\\]|\\.)*)"/g)) said.push(JSON.parse(`"${m[1]}"`));
    // 画面の「読み直す」が見に行く先。取ってきたものが、ここに出るはず。
    const config = await fetch(`${base}/api/config`)
      .then((x) => x.json() as Promise<{ gguf?: Array<{ ref?: string }> }>)
      .catch(() => undefined);
    return { status, said, done, config };
  } finally {
    await server.stop().catch(() => undefined);
    if (prev.home === undefined) delete process.env.AAS_HOME; else process.env.AAS_HOME = prev.home;
    if (prev.state === undefined) delete process.env.AAS_STATE_DIR; else process.env.AAS_STATE_DIR = prev.state;
    if (prev.cfg === undefined) delete process.env.AAS_CONFIG; else process.env.AAS_CONFIG = prev.cfg;
  }
}

/**
 * カタログの名前が古かったときの逃げ道。
 *
 * 配布元の名前の付け方は変わるし、こちらが書いた見当（AVAILABLE_MODELS）が
 * 実在するかは**確かめられていない**。外れた時点で利用者が詰むのが
 * いちばん悪い。**打ち込む道が本当に通るか**を、押して確かめる。
 * ここまで、入力欄が在ることしか見ていなかった。
 */
describe('取ってくる先を、自分で打てる', () => {
  test('カタログに無い名前でも取れる', async () => {
    const models = await tempDir('aas-getui-repo-');
    const hf = await fakeHf();
    try {
      const got = await press('だれかの/しらない-GGUF', hf, models);
      assert.equal(got.status, 202, `受け取っていない: ${got.status}`);
      assert.ok(got.done, `終わりの合図が来ない: ${got.said.join(' / ')}`);
      const left = (await readdir(models)).filter((n) => n.endsWith('.gguf'));
      assert.equal(left.length, 1, `置かれていない: ${JSON.stringify(await readdir(models))}`);
    } finally { await hf.close(); }
  });

  test('.gguf の場所をそのまま貼っても取れる', async () => {
    const models = await tempDir('aas-getui-url-');
    const hf = await fakeHf();
    try {
      const got = await press('https://huggingface.co/x/y/resolve/main/model-Q4_K_M.gguf', hf, models);
      assert.ok(got.done, `終わりの合図が来ない: ${got.said.join(' / ')}`);
      assert.deepEqual(
        (await readdir(models)).filter((n) => n.endsWith('.gguf')),
        ['model-Q4_K_M.gguf'],
        '貼った名前で置かれていない',
      );
    } finally { await hf.close(); }
  });

  test('**頁の場所を貼ったら、そう言う**', async () => {
    // ファイルではなく配布元の頁を貼るのは、いちばんよくある間違い。
    // 番号だけ返すと、何が悪いのか分からない。
    const models = await tempDir('aas-getui-page-');
    const hf = await fakeHf();
    try {
      const got = await press('https://huggingface.co/x/y', hf, models);
      const bad = got.said.find((t) => t.includes('取ってこられませんでした'));
      assert.ok(bad, got.said.join(' / '));
      assert.ok(bad!.includes('.gguf'), `何を貼ればいいか言っていない: ${bad}`);
      assert.equal((await readdir(models)).filter((n) => n.endsWith('.gguf')).length, 0);
    } finally { await hf.close(); }
  });
});

describe('画面から押して、モデルが置かれる', () => {
  test('押したら、落ちて、置き場に入る', async () => {
    const models = await tempDir('aas-getui-models-');
    const hf = await fakeHf();
    try {
      const got = await press('qwen3.5-4b', hf, models);
      assert.equal(got.status, 202, `受け取っていない: ${got.status}`);
      assert.ok(got.done, `終わりの合図が来ない: ${got.said.join(' / ')}`);
      const left = (await readdir(models)).filter((n) => n.endsWith('.gguf'));
      assert.equal(left.length, 1, `置かれていない: ${JSON.stringify(await readdir(models))}`);
      assert.ok(got.said.some((t) => t.includes('用意できました')), got.said.join(' / '));
      // **置いただけで終わらせない。**「読み直す」が見に行く先に出ること。
      // 出なければ、取ってきたのに使えないのと同じ。
      assert.ok(
        got.config?.gguf?.some((m) => m.ref?.endsWith('.gguf')),
        `読み直しても出ない: ${JSON.stringify(got.config?.gguf)}`,
      );
    } finally { await hf.close(); }
  });

  test('**取れなかったときに、そこで終わらせない**', async () => {
    // 配布元の名前は変わる。変わったときに番号だけ出すと、そこで詰まる。
    const models = await tempDir('aas-getui-404-');
    const hf = await fakeHf({ listStatus: 404 });
    try {
      const got = await press('qwen3.5-4b', hf, models);
      assert.ok(got.done, '終わりの合図が来ない');
      const bad = got.said.find((t) => t.includes('取ってこられませんでした'));
      assert.ok(bad, got.said.join(' / '));
      // 次の一手が出ていること。**置き場に置くだけでよい**が一番確実。
      assert.ok(bad!.includes(models), `置き場を出していない: ${bad}`);
      assert.ok(bad!.includes("読み直す"), `拾い方を出していない: ${bad}`);
    } finally { await hf.close(); }
  });

  test('合う量子化が無ければ、あるものを並べて言う', async () => {
    const models = await tempDir('aas-getui-noquant-');
    const hf = await fakeHf({ files: ['model-Q8_0.gguf', 'README.md'] });
    try {
      const got = await press('qwen3.5-4b', hf, models);
      const bad = got.said.find((t) => t.includes('取ってこられませんでした'));
      assert.ok(bad, got.said.join(' / '));
      assert.ok(bad!.includes('Q8_0'), `あるものを出していない: ${bad}`);
    } finally { await hf.close(); }
  });
});
