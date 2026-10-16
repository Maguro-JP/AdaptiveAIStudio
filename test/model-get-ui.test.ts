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
async function press(id: string, hf: Awaited<ReturnType<typeof fakeHf>>, models: string, opts: { sessions?: boolean } = {}) {
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
      ...(opts.sessions ? { providers: [] } : {}),
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
    // 取る前に本体を組んでおく（モデルが無いので候補は 0 件）
    const before = opts.sessions ? await server.session() : undefined;

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
    const after = opts.sessions ? await server.session() : undefined;
    return { status, said, done, config, before, after };
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
describe('取り終えたら、使えるようになる（DECISIONS 10-11、123 回目）', () => {
  test('候補が 0 件のまま組んだ本体は、取り終えたら組み直す', async () => {
    const models = await tempDir('aas-getui-rebuild-');
    const hf = await fakeHf();
    try {
      const got = await press('だれかの/しらない-GGUF', hf, models, { sessions: true });
      assert.ok(got.done, `終わりの合図が来ない: ${got.said.join(' / ')}`);
      assert.equal(got.before?.candidates.length, 0, 'この試験の前提（取る前は候補が 0 件）が崩れた');
      assert.notEqual(got.after, got.before, '候補が 0 件の本体を使い続けている（立ち上げ直すまで使えない）');
      // 取ったモデルが候補に入るかは、ここでは見られない（偽の配布元の中身は頭だけ GGUF で、モデルとしては読めない）
    } finally { await hf.close(); }
  });
});

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

describe('取ってこられなかったときに、行き止まりにしない', () => {
  /**
   * 一覧の名前は**版が上がると変わる**（`unsloth/Qwen3.5-4B-GGUF` のような
   * 個別の名前を持っている以上、いつか必ず腐る）。腐った日に利用者にできる
   * ことが無いと、そこで詰まる。
   *
   * この作りは元から「GGUF を1つ置くだけ」で動く。落とせなかったときは、
   * **選び方と保存先**を言う。名前を覚えてもらうのではなく、選び方を
   * 覚えてもらえば、名前が変わっても困らない。
   * 別のリポジトリ が同じ理由で個別のファイル名を書かず、選び方だけ書いている。
   */
  test('**落とせなかったら、手で置く道を案内する**', async () => {
    // 一覧を返す口が 404。名前が腐った日と同じ形。
    const hf = await fakeHf({ listStatus: 404 });
    const models = await tempDir('aas-getui-models-');
    try {
      const { said } = await press('qwen3.5-4b', hf, models);
      const all = said.join('\n');
      assert.match(all, /取ってこられませんでした/, all.slice(-300));
      assert.match(all, /手で置く/, `手で置く道を案内していない: ${all.slice(-400)}`);
      assert.match(all, /Q4_K_M/, `選び方を言っていない: ${all.slice(-400)}`);
      assert.match(all, /保存先:/, `どこへ置くのか言っていない: ${all.slice(-400)}`);
      // 保存先は、設定で選んだ場所（落とす先と同じ）。既定の場所を言うと、そこへ置いても一覧に出ない
      const where = all.split('\n').find((l) => l.includes('保存先:'));
      assert.ok(where?.includes(models), `保存先が落とす先と違う: ${where}`);
    } finally { await hf.close(); }
  });
});

describe('取っている間に、二つ目を始めない', () => {
  /**
   * 断らずに始めていたので、二度押すと同じ `.part` へ二本が書き、先に終わった方が名前を付け替えると、もう一本は
   * 「GGUF として読めませんでした」で失敗と言っていた（取れているのに）。
   */
  test('取っている間の二つ目は 409 で断り、一本だけが置かれる', async () => {
    const hf = await fakeHf();
    // 一覧を返すのを遅らせて、取っている間を作る（遅れは決めた長さ）
    const slow = (async (u: string | URL, init?: RequestInit) => {
      await new Promise((r) => setTimeout(r, 800));
      return hf.fetchImpl(u, init);
    }) as typeof fetch;
    const models = await tempDir('aas-getui-twice-models-');
    const home = await tempDir('aas-getui-twice-home-');
    const prev = { home: process.env.AAS_HOME, state: process.env.AAS_STATE_DIR, cfg: process.env.AAS_CONFIG };
    process.env.AAS_HOME = home;
    process.env.AAS_STATE_DIR = join(home, 'state');
    process.env.AAS_CONFIG = join(home, 'aas.config.json');
    const { UiServer } = await import('../src/ui/server.ts');
    const { DEFAULT_CONFIG } = await import('../src/config.ts');
    const server = new UiServer({
      port: 0,
      modelFetch: slow,
      config: { ...DEFAULT_CONFIG, runtime: { kind: 'inproc', modelsDir: models }, agent: { root: home, approval: 'auto' }, initiative: { enabled: false } } as never,
    });
    const base = (await server.start()).replace(/\/$/, '');
    try {
      const post = () => fetch(`${base}/api/models/get`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'org/some-model-GGUF' }),
      });
      const first = await post();
      assert.equal(first.status, 202, await first.text());
      const second = await post();
      assert.equal(second.status, 409, `取っている間に二つ目を始めた: ${second.status} ${await second.text()}`);
      // 終わるまで待つ（取っている状態が外れる）
      const until = Date.now() + 30_000;
      for (;;) {
        const st = await (await fetch(`${base}/api/models`)).json() as { fetching?: { state?: string } | null };
        if (st.fetching?.state !== 'running') break;
        if (Date.now() > until) throw new Error('終わらない');
        await new Promise((r) => setTimeout(r, 100));
      }
      const placed = (await readdir(models)).filter((n) => n.endsWith('.gguf'));
      assert.equal(placed.length, 1, `置かれたもの: ${JSON.stringify(await readdir(models))}`);
    } finally {
      await server.stop().catch(() => undefined);
      await hf.close();
      if (prev.home === undefined) delete process.env.AAS_HOME; else process.env.AAS_HOME = prev.home;
      if (prev.state === undefined) delete process.env.AAS_STATE_DIR; else process.env.AAS_STATE_DIR = prev.state;
      if (prev.cfg === undefined) delete process.env.AAS_CONFIG; else process.env.AAS_CONFIG = prev.cfg;
    }
  });
});

describe('■ で取得を止める（DECISIONS 10-11、123 回目の残り）', () => {
  test('取得の途中で ■ を押すと止まり、止めたと言う', async () => {
    const { UiServer } = await import('../src/ui/server.ts');
    const { DEFAULT_CONFIG } = await import('../src/config.ts');
    // ゆっくり返す配布元（大きさを申告して、少しずつ出し続ける）
    const timers: NodeJS.Timeout[] = [];
    const srv = createServer((req, res) => {
      if (req.url?.startsWith('/api/models/')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ siblings: [{ rfilename: 'slow-Q4_K_M.gguf' }] }));
      }
      res.writeHead(200, { 'content-length': String(100 * 1024 * 1024) });
      res.write(ggufBody(1024));
      const t = setInterval(() => res.write(Buffer.alloc(1024)), 50);
      timers.push(t);
      res.on('close', () => clearInterval(t));
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const { port } = srv.address() as AddressInfo;
    const home = await tempDir('aas-getui-stop-');
    const prev = { home: process.env.AAS_HOME, state: process.env.AAS_STATE_DIR, cfg: process.env.AAS_CONFIG };
    process.env.AAS_HOME = home;
    process.env.AAS_STATE_DIR = join(home, 'state');
    process.env.AAS_CONFIG = join(home, 'aas.config.json');
    const server = new UiServer({
      port: 0,
      modelFetch: ((u: string | URL, init?: RequestInit) => fetch(String(u).replace('https://huggingface.co', `http://127.0.0.1:${port}`), init)) as typeof fetch,
      config: { ...DEFAULT_CONFIG, runtime: { kind: 'inproc', modelsDir: join(home, 'models') }, agent: { root: home, approval: 'auto' }, initiative: { enabled: false } } as never,
    });
    const base = (await server.start()).replace(/\/$/, '');
    try {
      const r = await fetch(`${base}/api/models/get`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'だれかの/おそい-GGUF' }) });
      assert.equal(r.status, 202);
      const state = async () => (await (await fetch(`${base}/api/jobs`)).text());
      const until = Date.now() + 15_000;
      while (Date.now() < until && !/running/.test(await state())) await new Promise((x) => setTimeout(x, 100));
      await fetch(`${base}/api/abort`, { method: 'POST' });
      let after = '';
      while (Date.now() < until) {
        after = await state();
        if (/取得を止めました/.test(after)) break;
        await new Promise((x) => setTimeout(x, 100));
      }
      assert.match(after, /取得を止めました/, `■ で止まっていない: ${after.slice(0, 300)}`);
    } finally {
      await server.stop().catch(() => undefined);
      for (const t of timers) clearInterval(t);
      srv.closeAllConnections(); await new Promise<void>((r) => srv.close(() => r()));
      if (prev.home === undefined) delete process.env.AAS_HOME; else process.env.AAS_HOME = prev.home;
      if (prev.state === undefined) delete process.env.AAS_STATE_DIR; else process.env.AAS_STATE_DIR = prev.state;
      if (prev.cfg === undefined) delete process.env.AAS_CONFIG; else process.env.AAS_CONFIG = prev.cfg;
    }
  });
});
