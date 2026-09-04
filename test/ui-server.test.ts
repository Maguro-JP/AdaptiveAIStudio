import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';

// 配置や記録の置き場を、試験専用の場所へ移してから読み込む。
const dir = await tempDir('aas-ui-');
process.env.AAS_STATE_DIR = dir;

const { UiServer } = await import('../src/ui/server.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');

let base = '';
let server: InstanceType<typeof UiServer>;

before(async () => {
  server = new UiServer({ config: DEFAULT_CONFIG, port: 0 });
  base = await server.start();
});

after(async () => { await server.stop(); });

const json = async (r: Response): Promise<any> => r.json();

const get = (path: string) => fetch(base.replace(/\/$/, '') + path);
const post = (path: string, body: unknown) => fetch(base.replace(/\/$/, '') + path, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const put = (path: string, body: unknown) => fetch(base.replace(/\/$/, '') + path, {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

describe('画面を配る', () => {
  test('入口が出る', async () => {
    const r = await get('/');
    assert.equal(r.status, 200);
    assert.ok((await r.text()).includes('AdaptiveAIStudio'));
  });

  test('置き場の外は読ませない', async () => {
    const r = await get('/../../package.json');
    assert.ok(r.status === 403 || r.status === 404, `読めてしまった: ${r.status}`);
  });

  test('無い物は 404', async () => {
    assert.equal((await get('/nope.js')).status, 404);
  });
});

describe('配置の受け渡し', () => {
  test('最初は既定の配置が返る', async () => {
    const r = await json(await get('/api/layout'));
    assert.ok(r.layout.panels.length > 0);
    assert.ok(r.presets.length > 0);
    assert.ok(r.kinds.includes('conversation'));
  });

  test('壊れた配置を送っても、直して保存する', async () => {
    const r = await json(await put('/api/layout', {
      panels: [{ id: 'a', kind: '未来の機能' }], root: { type: 'panel', panel: 'いない' },
    }));
    assert.ok(r.repairs.length > 0, '直したことを黙っている');
    assert.equal(r.layout.panels[0].kind, 'note');

    // 保存されたものを読み直しても、もう直すところが無い
    const again = await json(await get('/api/layout'));
    assert.deepEqual(again.repairs, []);
    assert.deepEqual(again.layout, r.layout);
  });

  test('読めない中身でも既定に落ちる（例外にしない）', async () => {
    const r = await fetch(base.replace(/\/$/, '') + '/api/layout', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: 'これはJSONではない',
    });
    assert.equal(r.status, 200);
    assert.ok((await json(r)).layout.panels.length > 0);
  });

  test('用意された配置に切り替えられる', async () => {
    const r = await json(await post('/api/layout/preset', { id: 'watch' }));
    assert.equal(r.layout.id, 'watch');
  });

  test('知らない配置を頼まれても既定に落ちる', async () => {
    const r = await json(await post('/api/layout/preset', { id: '無い配置' }));
    assert.ok(r.layout.panels.length > 0);
  });
});

describe('見た目の受け渡し', () => {
  test('最初は既定の見た目が返る', async () => {
    const r = await json(await get('/api/theme'));
    assert.ok(r.themes.length >= 2, '選べる見た目が少なすぎる');
    assert.ok(r.vars['--bg'], '画面へ流す形になっていない');
    assert.ok(r.tokens.includes('accent'));
  });

  test('CSS を抜け出す値は保存しない', async () => {
    const r = await json(await put('/api/theme', {
      base: 'slate', tokens: { accent: 'red; } body { display:none } .x{color:red' },
    }));
    assert.notEqual(r.theme.tokens.accent, 'red; } body { display:none } .x{color:red');
    assert.ok(r.repairs.some((x: { detail: string }) => x.detail.includes('accent')));
    // 流す形にも出ない
    assert.ok(!String(r.vars['--accent'] ?? '').includes('}'));
  });

  test('変えたところだけ保存され、読み直しても残る', async () => {
    await put('/api/theme', { base: 'slate', tokens: { accent: '#ff8800' } });
    const again = await json(await get('/api/theme'));
    assert.equal(again.theme.tokens.accent, '#ff8800');
    assert.deepEqual(again.repairs, []);
  });

  test('用意された見た目に切り替えられる', async () => {
    const r = await json(await post('/api/theme/preset', { id: 'cyber' }));
    assert.equal(r.theme.id, 'cyber');
    assert.equal(r.theme.scheme, 'dark');
  });

  test('知らない見た目を頼まれても既定に落ちる', async () => {
    const r = await json(await post('/api/theme/preset', { id: '無い色' }));
    assert.ok(r.theme.tokens.bg);
  });

  test('配置と見た目は別々に持つ（色を変えても配置は動かない）', async () => {
    const before = await json(await get('/api/layout'));
    await post('/api/theme/preset', { id: 'paper' });
    const after = await json(await get('/api/layout'));
    assert.deepEqual(after.layout, before.layout);
  });
});

describe('材料', () => {
  test('人員と記憶が返る', async () => {
    const s = await json(await get('/api/state'));
    assert.ok(s.roles.length > 0);
    assert.ok(Array.isArray(s.memory));
    assert.ok(s.roles.some((r: { codename: string }) => r.codename === 'SMITH'));
  });
});

describe('承認', () => {
  test('空の指示は受け取らない', async () => {
    assert.equal((await post('/api/send', { text: '   ' })).status, 400);
  });

  test('終わった承認に答えても壊れない', async () => {
    const r = await post('/api/approve', { id: 'a999', approved: true });
    assert.equal(r.status, 404);
  });

  test('動いていなくても中断は受け付ける', async () => {
    assert.equal((await post('/api/abort', {})).status, 200);
  });
});

describe('見てから走り出すまでを塞ぐ', () => {
  // 「同時に5つ押したら4つ断られる」を書いたが、**走らせるたびに結果が
  // 変わった**（モデルが無いときは支度がすぐ終わり、後から来たものも
  // 通る。それは正しい振る舞い）。時間に依る検査は置かない。
  // いまここで見られるのは「一つだけなら断らない」ところまで。
  test('一つだけなら、断られない', async () => {
    const r = await post('/api/send', { text: 'こんにちは' });
    assert.notEqual(r.status, 409, '一つしか来ていないのに断っている');
  });
});

describe('画面から立ち上げ直す', () => {
  test('入口が起こし直せないときは、そう言って断る', async () => {
    // この試験の server は onRestart を持たない。
    const r = await post('/api/restart', {});
    assert.equal(r.status, 501);
  });

  test('頼まれたら返事をしてから止める側を呼ぶ', async () => {
    let called = 0;
    const s = new UiServer({ config: DEFAULT_CONFIG, port: 0, relaunches: true, onRestart: () => { called++; } });
    const b = await s.start();
    try {
      const r = await fetch(`${b}api/restart`, { method: 'POST' });
      const body = await json(r);
      assert.equal(r.status, 200);
      assert.equal(body.relaunches, true);
      // 返事の時点ではまだ呼ばない。押した側に返事が届く前に止めない。
      assert.equal(called, 0);
      await new Promise((res) => setTimeout(res, 400));
      assert.equal(called, 1, '止める側が呼ばれていない');
    } finally { await s.stop(); }
  });

  test('起こし直してもらえないなら、そう伝える（対）', async () => {
    const s = new UiServer({ config: DEFAULT_CONFIG, port: 0, onRestart: () => {} });
    const b = await s.start();
    try {
      const body = await json(await fetch(`${b}api/restart`, { method: 'POST' }));
      assert.equal(body.relaunches, false);
    } finally { await s.stop(); }
  });
});

describe('よその頁から口を叩かせない', () => {
  test('Origin がよそなら、中身を読む前に断る', async () => {
    const r = await fetch(base.replace(/\/$/, '') + '/api/send', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', origin: 'https://evil.example' },
      body: JSON.stringify({ text: 'rm -rf /' }),
    });
    assert.equal(r.status, 403);
  });

  test('自分の頁からは通る（対）', async () => {
    const r = await fetch(base.replace(/\/$/, '') + '/api/tasks', {
      headers: { origin: base.replace(/\/$/, ''), 'sec-fetch-site': 'same-origin' },
    });
    assert.equal(r.status, 200);
  });
});

describe('本文を際限なく抱えない', () => {
  test('大きすぎる JSON は 413', async () => {
    const { MAX_JSON_BODY } = await import('../src/ui/server.ts');
    const big = JSON.stringify({ text: 'a'.repeat(MAX_JSON_BODY + 1024) });
    const r = await fetch(base.replace(/\/$/, '') + '/api/send', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: big,
    }).catch(() => undefined);
    // 途中で切るので、fetch 側が先に落ちることもある。落ちなければ 413。
    if (r) assert.equal(r.status, 413);
  });

  test('ふつうの大きさは受け取る（対）', async () => {
    const r = await post('/api/send', { text: 'a'.repeat(100_000) });
    assert.notEqual(r.status, 413);
  });
});

describe('使う GGUF を画面から決める', () => {
  /**
   * **書き先を先に逃がす。**AAS_CONFIG を立てずに保存を呼ぶと、
   * 走らせた場所の aas.config.json、つまり開発中の作業コピーに書き込む。
   * 実際にそうなり、画面が使ってもいないモデル名を出し続けた。
   */
  let prev: string | undefined;
  before(async () => {
    prev = process.env.AAS_CONFIG;
    process.env.AAS_CONFIG = join(await tempDir('aas-cfgw-'), 'aas.config.json');
  });
  after(() => {
    if (prev === undefined) delete process.env.AAS_CONFIG; else process.env.AAS_CONFIG = prev;
  });

  test('名前に道を混ぜたものは断る', async () => {
    const r = await put('/api/config', { kind: 'inproc', modelsDir: '', model: '../x.gguf' });
    assert.equal(r.status, 400);
  });
  test('置き場の中の名前なら通り、読み出しに出る（対）', async () => {
    const r = await put('/api/config', { kind: 'inproc', modelsDir: '', model: 'b.gguf' });
    assert.equal(r.status, 200);
    const c = await json(await get('/api/config'));
    assert.equal(c.model, 'b.gguf');
  });
});

describe('暇なときの一回分', () => {
  test('モデルが無ければ MISSING、その後しばらくは HELD', async () => {
    const { tempDir: td } = await import('./tmp.ts');
    const models = await td('aas-idle-');
    const s = new UiServer({
      config: { ...DEFAULT_CONFIG, runtime: { kind: 'inproc', modelsDir: models } } as typeof DEFAULT_CONFIG,
      port: 0,
    });
    await s.start();
    try {
      const session = await s.session();
      assert.equal(await s.idleTick(session), 'MISSING');
      // 30秒ごとに「置き場に無い」を作らない。
      assert.equal(await s.idleTick(session), 'HELD');
    } finally { await s.stop(); }
  });
});

describe('記憶に載らない GGUF', () => {
  test('送る前に止めて、理由を返す', async () => {
    const { tempDir: td } = await import('./tmp.ts');
    const { open } = await import('node:fs/promises');
    const { join: j } = await import('node:path');
    const models = await td('aas-huge-');
    // 中身の無い（疎な）1TB。場所は食わない。大きさだけが本物。
    const fh = await open(j(models, 'huge.gguf'), 'w');
    await fh.truncate(1024 ** 4);
    await fh.close();
    const s = new UiServer({
      config: { ...DEFAULT_CONFIG, runtime: { kind: 'inproc', modelsDir: models } } as typeof DEFAULT_CONFIG,
      port: 0,
    });
    const b = (await s.start()).replace(/\/$/, '');
    try {
      const r = await fetch(`${b}/api/send`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'x' }),
      });
      assert.equal(r.status, 503);
      assert.match(((await r.json()) as { error: string }).error, /大きすぎます/);
      // 置き場の一覧でも、読む前に分かる。
      const prev = process.env.AAS_CONFIG;
      process.env.AAS_CONFIG = j(models, 'aas.config.json');
      try {
        await (await fetch(`${b}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind: 'inproc', modelsDir: models }) })).json();
        const c = await (await fetch(`${b}/api/config`)).json() as { gguf: { ref: string; tooBig: string | null }[] };
        assert.ok(c.gguf.find((g) => g.ref === 'huge.gguf')?.tooBig, '一覧に「載らない」が付いていない');
      } finally { if (prev === undefined) delete process.env.AAS_CONFIG; else process.env.AAS_CONFIG = prev; }
    } finally { await s.stop(); }
  });
});

describe('名前だけ .gguf の別物', () => {
  test('先頭に印が無ければ、読みに行かずに理由を返す', async () => {
    const { tempDir: td } = await import('./tmp.ts');
    const { writeFile: wf } = await import('node:fs/promises');
    const { join: j } = await import('node:path');
    const models = await td('aas-notgguf-');
    await wf(j(models, 'page.gguf'), '<!doctype html><title>Access denied</title>');
    const s = new UiServer({
      config: { ...DEFAULT_CONFIG, runtime: { kind: 'inproc', modelsDir: models } } as typeof DEFAULT_CONFIG,
      port: 0,
    });
    const b = (await s.start()).replace(/\/$/, '');
    try {
      const r = await fetch(`${b}/api/send`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'x' }),
      });
      assert.equal(r.status, 503);
      assert.match(((await r.json()) as { error: string }).error, /GGUF として読めません/);
      // 一覧でも分かる。本物の印があるものには付かない（対）。
      await wf(j(models, 'real.gguf'), 'GGUF');
      const prev = process.env.AAS_CONFIG;
      process.env.AAS_CONFIG = j(models, 'aas.config.json');
      try {
        await fetch(`${b}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind: 'inproc', modelsDir: models }) });
        const c = await (await fetch(`${b}/api/config`)).json() as { gguf: { ref: string; notGguf: boolean }[] };
        assert.equal(c.gguf.find((g) => g.ref === 'page.gguf')?.notGguf, true);
        assert.equal(c.gguf.find((g) => g.ref === 'real.gguf')?.notGguf, false);
      } finally { if (prev === undefined) delete process.env.AAS_CONFIG; else process.env.AAS_CONFIG = prev; }
    } finally { await s.stop(); }
  });
});

describe('読まない画面に溜め続けない', () => {
  test('読まない相手は切られ、読む相手は残る', async () => {
    const { request } = await import('node:http');
    const url = new URL(base);
    // 読まない相手。応答を受け取っても一切読まない。
    const stuck = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      const req = request({ host: url.hostname, port: url.port, path: '/api/events' }, resolve);
      req.on('error', reject); req.end();
    });
    stuck.pause();
    // 読む相手。
    const ac = new AbortController();
    const reading = await fetch(`${base.replace(/\/$/, '')}/api/events`, { signal: ac.signal });
    const reader = reading.body!.getReader();
    const drain = (async () => { for (;;) { const { done } = await reader.read(); if (done) break; } })().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 200));
    const before = server.clientCount;
    assert.ok(before >= 2);
    // 溜め込ませる。4MB を優に超える量を流す。
    const big = 'あ'.repeat(64 * 1024);
    for (let i = 0; i < 200; i++) server.broadcast({ type: 'log', level: 'info', text: big });
    await new Promise((r) => setTimeout(r, 300));
    server.broadcast({ type: 'log', level: 'info', text: 'とどめ' });
    assert.ok(server.clientCount < before, `読まない相手が切られていない: ${before} → ${server.clientCount}`);
    ac.abort(); await drain; stuck.destroy();
  });
});

describe('情報に、外の道具の繋がり具合が出る', () => {
  test('mcp の行がある', async () => {
    const info = await json(await get('/api/info'));
    assert.equal(typeof info.mcp, 'string');
  });
});

describe('土台の声が、画面に届く', () => {
  test('読み込みの進み具合と警告が、画面の流れに出る', async () => {
    // ここに undefined を渡していたので、2GB を読む 30〜60秒のあいだ
    // 画面には一行も出なかった。**待っているのか固まっているのかが分からない。**
    // 「合う道具の呼び方が見つからない」という警告も、ここで消えていた。
    const models = await tempDir('aas-log-');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(models, 'm.gguf'), 'GGUF');

    const s = new UiServer({
      config: {
        ...DEFAULT_CONFIG,
        runtime: { kind: 'inproc', modelsDir: models, basePort: 0 },
      },
      port: 0,
      // 本物は用意できない。**言うべきことを言う所まで**を見る。
      inprocLoad: async () => ({
        getLlama: async () => ({
          loadModel: async (o: { onLoadProgress?: (d: number) => void }) => {
            o.onLoadProgress?.(0.5);
            return { createContext: async () => ({ getSequence: () => ({}), dispose: async () => {} }) };
          },
        }),
        LlamaChatSession: class {
          chatWrapper = { wrapperName: 'Llama2Chat' };
          setChatHistory() {}
          async prompt() { return ''; }
        },
      }),
    });
    const b = (await s.start()).replace(/\/$/, '');
    const ac = new AbortController();
    try {
      const stream = await fetch(`${b}/api/events`, { signal: ac.signal });
      const reader = stream.body!.getReader();
      let seen = '';
      const reading = (async () => {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          seen += new TextDecoder().decode(value);
          if (seen.includes('当てずっぽう')) break;
        }
      })();
      // 読ませる。ここで土台が立ち上がり、声が出る。
      await fetch(`${b}/api/models`);
      await fetch(`${b}/api/send`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'やあ' }),
      }).catch(() => undefined);
      await Promise.race([reading, new Promise((r) => setTimeout(r, 8000))]);
      assert.match(seen, /読み込み中 50%/, `進み具合が画面に出ていない: ${seen.slice(-300)}`);
      assert.match(seen, /当てずっぽう/, `警告が画面に出ていない: ${seen.slice(-300)}`);
    } finally { ac.abort(); await s.stop(); }
  });
});

describe('作業場が無くても、開いた瞬間に赤を出さない', () => {
  test('一覧を読むときに、無ければ作る', async () => {
    // 入れた版の既定（根の下の work）は初回には無い。会話を始める前に
    // 横の板が一覧を読むので、そこで「そんな場所は無い」が出る。
    // **開いた瞬間に赤が出る**のが、いちばん印象が悪い。
    const home = await tempDir('aas-first-');
    const root = join(home, 'work');
    const s = new UiServer({
      config: { ...DEFAULT_CONFIG, agent: { root } },
      port: 0,
    });
    const b = (await s.start()).replace(/\/$/, '');
    try {
      const r = await fetch(`${b}/api/files`);
      // 中身は一度しか読めない。先に読んでから、それを使って言う。
      const body = await r.text();
      assert.equal(r.status, 200, `開いた瞬間に落ちている: ${body}`);
      const j = JSON.parse(body) as { root: string; entries: unknown[] };
      assert.equal(j.root, root);
      assert.deepEqual(j.entries, []);
    } finally { await s.stop(); }
  });
});

describe('起こし直してもらえないなら、止めない', () => {
  test('立ち上げ直しを押しても、口は生きている', async () => {
    // ここまでは、起こし直してもらえない入口でも止めていた。返事は
    // relaunches:false なのに**プロセスは死ぬ**。誰も起こさないので二度と
    // 戻らず、画面には接続できない旨だけが残る。
    const s = new UiServer({ config: DEFAULT_CONFIG, port: 0 });
    const b = (await s.start()).replace(/\/$/, '');
    try {
      const r = await fetch(`${b}/api/restart`, { method: 'POST' });
      assert.equal(r.status, 501);
      const body = await r.json() as { error: string };
      // 何をすればよいかまで言うこと。断るだけでは、次の一手が分からない。
      assert.match(body.error, /開き直/);
      // **まだ生きていること。**ここが要点。
      const after = await fetch(`${b}/api/info`);
      assert.equal(after.status, 200, '断ったのに死んでいる');
    } finally { await s.stop(); }
  });
});

describe('作業場は、保存したら効く', () => {
  test('立ち上げ直さずに、その場で変わる', async () => {
    // ここまで、設定ファイルに書き込むだけで**動いている側を直していなかった**。
    // 保存したのに画面は古い作業場を見たまま、しかも立ち上げ直しが要るとも
    // 言わない。「保存したのに変わらない」で終わる形だった。
    const { mkdir: md, writeFile: wf } = await import('node:fs/promises');
    const home = await tempDir('aas-wr-');
    const proj = join(home, 'proj');
    await md(proj, { recursive: true });
    await wf(join(proj, 'mine.txt'), 'x');

    const prev = process.env.AAS_CONFIG;
    process.env.AAS_CONFIG = join(home, 'aas.config.json');
    const s = new UiServer({ config: { ...DEFAULT_CONFIG }, port: 0 });
    const b = (await s.start()).replace(/\/$/, '');
    try {
      const r = await fetch(`${b}/api/config`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'inproc', modelsDir: '', workRoot: proj }),
      });
      const body = await r.json() as { workRootNow?: string };
      assert.equal(r.status, 200);
      // **返事に、いまどこを見ているかが入っていること。**
      // 入っていないと、効いたのかどうかを画面が確かめられない。
      assert.equal(body.workRootNow, proj, `効いていない: ${JSON.stringify(body)}`);

      // 立ち上げ直さずに、一覧が新しい作業場を指していること。
      const files = await (await fetch(`${b}/api/files`)).json() as {
        root: string; entries: { name: string }[];
      };
      assert.equal(files.root, proj, '保存したのに古い作業場を見ている');
      assert.ok(files.entries.some((e) => e.name === 'mine.txt'), '中身が出ていない');
    } finally {
      await s.stop();
      if (prev === undefined) delete process.env.AAS_CONFIG; else process.env.AAS_CONFIG = prev;
    }
  });

  test('無い場所を打っても保存はできる。ただし言う（対）', async () => {
    const home = await tempDir('aas-wr2-');
    const prev = process.env.AAS_CONFIG;
    process.env.AAS_CONFIG = join(home, 'aas.config.json');
    const s = new UiServer({ config: { ...DEFAULT_CONFIG }, port: 0 });
    const b = (await s.start()).replace(/\/$/, '');
    try {
      const r = await fetch(`${b}/api/config`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'inproc', modelsDir: '', workRoot: join(home, 'そんな場所は無い') }),
      });
      const body = await r.json() as { workNote?: string };
      assert.match(body.workNote ?? '', /見つかりません/, '打ち間違いを黙って通している');
    } finally {
      await s.stop();
      if (prev === undefined) delete process.env.AAS_CONFIG; else process.env.AAS_CONFIG = prev;
    }
  });
});
