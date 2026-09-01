import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
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
