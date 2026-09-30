/**
 * 作っているものを見る口。
 *
 * 見えることより、**操作用の口と混ざらないこと**を確かめる。
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { tempDir } from './tmp.ts';
import { until } from './until.ts';
import { PreviewServer, inject, listing, RELOAD_SNIPPET, hiddenRequest } from '../src/ui/preview.ts';

async function site(files: Record<string, string>): Promise<string> {
  const root = await tempDir('aas-preview-');
  for (const [name, body] of Object.entries(files)) {
    const abs = join(root, name);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, body, 'utf8');
  }
  return root;
}

const servers: PreviewServer[] = [];
after(() => { for (const s of servers) s.stop(); });

async function serve(root: string): Promise<string> {
  const s = new PreviewServer({ root, watch: false });
  servers.push(s);
  return s.start();
}

/**
 * 見ている人へ、読み直せと伝わるところまでを見る。
 *
 * ここまで確かめていたのは、**差し込む文字が入っていること**だけだった。
 * 差し込んだ先が繋ぐ `/__reload` と、書き換えを見て知らせる所は、
 * 一度も動かしていない。このパネルの売りが「書き換えたら勝手に読み直す」なので、
 * 見張りが黙っていても、こちらでは分からないままになる。
 *
 * 開いた口は必ず閉じる（閉じないと、落ちる代わりに試験が終わらなくなる）。
 */
async function listen(url: string): Promise<{ lines: string[]; close(): void }> {
  const ac = new AbortController();
  const lines: string[] = [];
  const r = await fetch(`${url}__reload`, { signal: ac.signal });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') ?? '', /text\/event-stream/);
  void (async () => {
    const reader = r.body!.getReader();
    const dec = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        if (value) for (const l of dec.decode(value, { stream: true }).split('\n')) if (l) lines.push(l);
      }
    } catch { /* 閉じた */ }
  })();
  return { lines, close: () => ac.abort() };
}

describe('書き換えを見て、読み直せと伝える', () => {
  test('**繋いだ相手へ、伝わる**', async () => {
    const s = new PreviewServer({ root: await site({ 'index.html': '<h1>あ</h1>' }), watch: false });
    servers.push(s);
    const url = await s.start();
    const seen = await listen(url);
    try {
      await until(() => seen.lines.some((l) => l.startsWith(':')), '繋がった合図が来る', { timeoutMs: 5000 });
      s.notify();
      await until(() => seen.lines.some((l) => l === 'data: change'), '読み直せと伝わる', { timeoutMs: 5000 });
    } finally { seen.close(); s.stop(); }
  });

  /**
   * **画面のプレビューは、出所が `null` で来る。**
   *
   * 埋め込みは sandbox 付き（`allow-same-origin` は付けない）ので、中のページの
   * 出所は `null` になる。差し込んだ読み直しはここへ繋ぎに来るが、CORS で弾かれて
   * **一度も繋がらないまま毎秒やり直していた**（本物のブラウザで確かめた。
   * 書き換えても映りが変わらず、コンソールがエラーで埋まる）。
   */
  test('**出所が違っても、読み直しの口は受ける**', async () => {
    const s = new PreviewServer({ root: await site({ 'index.html': '<h1>あ</h1>' }), watch: false });
    servers.push(s);
    const url = await s.start();
    const ac = new AbortController();
    try {
      const r = await fetch(new URL('/__reload', url), {
        headers: { origin: 'null', accept: 'text/event-stream' }, signal: ac.signal,
      });
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('access-control-allow-origin'), '*',
        '出所が null の埋め込みから繋げない（読み直しが一度も効かない）');
    } finally { ac.abort(); s.stop(); }
  });

  test('ファイルを配る方には、誰からでも、を付けない（対）', async () => {
    // 作業場のファイルそのものは、よそから読めてはいけない。
    const s = new PreviewServer({ root: await site({ 'index.html': '<h1>あ</h1>' }), watch: false });
    servers.push(s);
    const url = await s.start();
    try {
      const r = await fetch(new URL('/index.html', url));
      assert.equal(r.headers.get('access-control-allow-origin'), null,
        'ファイルを誰からでも読めるようにしている');
    } finally { s.stop(); }
  });

  test('**ファイルを書き換えたら、見張りが拾って伝える**', async () => {
    const root = await site({ 'index.html': '<h1>あ</h1>' });
    const s = new PreviewServer({ root });
    servers.push(s);
    const url = await s.start();
    const seen = await listen(url);
    try {
      await until(() => seen.lines.some((l) => l.startsWith(':')), '繋がった合図が来る', { timeoutMs: 5000 });
      await writeFile(join(root, 'index.html'), '<h1>い</h1>', 'utf8');
      await until(() => seen.lines.some((l) => l === 'data: change'), '書き換えが伝わる', { timeoutMs: 10_000 });
    } finally {
      /*
       * **見ているのをやめたら、その場で止める。**
       *
       * まとめの時計（80ms）が後から鳴って、閉じた相手へ書きに行く。
       * 後片づけ（`after`）まで生かしておくと、仮のフォルダが消えた後に
       * 見張りが音を上げることもある。試験の終わりを、ここで閉じる。
       */
      seen.close();
      s.stop();
    }
  });

  test('.git や node_modules の中は、拾わない（対）', async () => {
    const root = await site({ 'index.html': '<h1>あ</h1>', 'node_modules/x/p.js': 'a' });
    const s = new PreviewServer({ root });
    servers.push(s);
    const url = await s.start();
    const seen = await listen(url);
    try {
      await until(() => seen.lines.some((l) => l.startsWith(':')), '繋がった合図が来る', { timeoutMs: 5000 });
      await writeFile(join(root, 'node_modules/x/p.js'), 'b', 'utf8');
      // 拾わないことは「来ない」で見る。まとめる間（80ms）より十分長く待つ。
      await new Promise((r) => setTimeout(r, 600));
      assert.deepEqual(seen.lines.filter((l) => l === 'data: change'), [],
        '中身と関係ない所で読み直させている');
      // 見張り自体は生きている（対）。ここが死んでいたら、上は黙っていても通る。
      await writeFile(join(root, 'index.html'), '<h1>う</h1>', 'utf8');
      await until(() => seen.lines.some((l) => l === 'data: change'), '中身の書き換えは伝わる', { timeoutMs: 10_000 });
    } finally { seen.close(); s.stop(); }
  });

  /**
   * 別の名前で渡された作業場でも、見張れること。
   *
   * Windows の CI で、この試験のファイルだけが**まるごと消えた**（通った数にも
   * 落ちた名前にも出てこない）。libuv が abort していた。
   *
   *   Assertion failed: !_wcsnicmp(filename, dir, dirlen), file src\win\fs-event.c, line 72
   *
   * %TEMP% が短い形（`C:\Users\RUNNER~1\...`）で入ってきていて、書き換えが
   * 届いた瞬間に落ちていた。ここでは junction（Windows）と symlink（他）越しに
   * 見張って、**OS が名乗る形へ直してから渡していること**を見る。
   */
  test('**別の名前（junction や symlink）越しでも、見張れる**', async () => {
    const root = await site({ 'index.html': '<h1>あ</h1>' });
    const other = join(await tempDir('aas-preview-link-'), 'link');
    await symlink(root, other, process.platform === 'win32' ? 'junction' : 'dir');
    const s = new PreviewServer({ root: other });
    servers.push(s);
    const url = await s.start();
    const seen = await listen(url);
    try {
      // 渡された名前ではなく、実体の名前で見張っている。
      assert.equal(s.watching, realpathSync.native(other), '渡された名前のまま見張っている');
      await until(() => seen.lines.some((l) => l.startsWith(':')), '繋がった合図が来る', { timeoutMs: 5000 });
      await writeFile(join(other, 'index.html'), '<h1>い</h1>', 'utf8');
      await until(() => seen.lines.some((l) => l === 'data: change'), '別の名前越しでも伝わる', { timeoutMs: 10_000 });
    } finally { seen.close(); s.stop(); }
  });
});

describe('読み直しの差し込み', () => {
  test('</body> の手前に入れる', () => {
    const out = inject('<html><body><p>あ</p></body></html>');
    assert.ok(out.indexOf(RELOAD_SNIPPET) < out.indexOf('</body>'));
  });

  test('</body> が無くても入る', () => {
    assert.ok(inject('<p>あ</p>').includes('EventSource'));
  });

  test('中身より後ろに入れる。行番号をずらさない', () => {
    const out = inject('<p>目印</p>');
    assert.ok(out.indexOf('目印') < out.indexOf('EventSource'));
  });
});

describe('作業場を配る', () => {
  test('HTML を出し、読み直しの仕掛けが入っている', async () => {
    const url = await serve(await site({ 'index.html': '<h1>やあ</h1>' }));
    const text = await (await fetch(url)).text();
    assert.match(text, /やあ/);
    assert.match(text, /EventSource/);
  });

  test('CSS や画像は、そのまま出す（仕掛けを混ぜない）', async () => {
    const url = await serve(await site({ 'a.css': 'body{color:red}' }));
    const r = await fetch(`${url}a.css`);
    assert.match(r.headers.get('content-type') ?? '', /text\/css/);
    assert.equal(await r.text(), 'body{color:red}');
  });

  test('index.html が無ければ一覧を出す', async () => {
    const url = await serve(await site({ 'a.txt': 'x', 'b/c.txt': 'y' }));
    const text = await (await fetch(url)).text();
    assert.match(text, /a\.txt/);
    assert.match(text, /b/);
  });

  test('溜め込ませない。作りかけを見ているので、古いものが出続けると困る', async () => {
    const url = await serve(await site({ 'index.html': '<p>あ</p>' }));
    assert.match((await fetch(url)).headers.get('cache-control') ?? '', /no-store/);
  });

  test('無いものは 404', async () => {
    const url = await serve(await site({ 'index.html': 'x' }));
    assert.equal((await fetch(`${url}nope.html`)).status, 404);
  });
});

describe('作業場の外は見せない', () => {
  test('.. で外へ出られない', async () => {
    const url = await serve(await site({ 'index.html': 'x' }));
    for (const path of ['../../etc/passwd', '..%2F..%2Fetc%2Fpasswd', '%2e%2e/%2e%2e/etc/passwd']) {
      const r = await fetch(`${url}${path}`);
      assert.ok(r.status === 403 || r.status === 404, `通ってしまった: ${path} → ${r.status}`);
    }
  });

  test('絶対パスでも出られない', async () => {
    const url = await serve(await site({ 'index.html': 'x' }));
    const r = await fetch(`${url}/etc/passwd`);
    assert.ok(r.status === 403 || r.status === 404);
  });
});

describe('操作用の口と混ざらない', () => {
  test('操作用とは別の口（別ポート）で出す', async () => {
    // 同じ口から作業物を出すと、書いたページが /api/send を叩ける。
    const a = new PreviewServer({ root: await site({}), watch: false });
    const b = new PreviewServer({ root: await site({}), watch: false });
    servers.push(a, b);
    await a.start();
    await b.start();
    assert.notEqual(a.port, b.port);
    assert.ok(a.port > 0);
  });

  test('この口には操作用の道が無い', async () => {
    const url = await serve(await site({ 'index.html': 'x' }));
    for (const path of ['api/send', 'api/approve', 'api/models/get']) {
      const r = await fetch(`${url}${path}`, { method: 'POST' });
      assert.equal(r.status, 404, `操作用の道がある: ${path}`);
    }
  });
});

describe('一覧の見た目', () => {
  test('folder が先、file が後', () => {
    const html = listing('/', [
      { name: 'z.txt', isDir: false }, { name: 'a', isDir: true },
    ]);
    assert.ok(html.indexOf('a') < html.indexOf('z.txt'));
  });
});

describe('一覧に、名前をそのまま流し込まない', () => {
  test('名前の中の < と " は文字として出る', () => {
    const html = listing('/', [{ name: '"><script>alert(1)</script>', isDir: false }]);
    assert.ok(!html.includes('<script>alert'), '名前が HTML として通っている');
    assert.ok(html.includes('&lt;script&gt;'), '文字として出ていない');
    // href も同じ。属性を閉じて外へ出させない。
    assert.ok(!html.includes('href=""><'), 'href が閉じられている');
  });

  test('見出しの道も同じ', () => {
    const html = listing('<b>x</b>', []);
    assert.ok(!html.includes('<b>x</b>'));
    assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;'));
  });

  test('ふつうの名前は、そのまま読める（対）', () => {
    const html = listing('/', [{ name: 'メモ.md', isDir: false }, { name: 'src', isDir: true }]);
    assert.ok(html.includes('📄 メモ.md'));
    assert.ok(html.includes('href="src/"'));
  });
});

describe('鍵や記録は、見る窓から出さない', () => {
  test('.env と .git は 403', async () => {
    const url = await serve(await site({ '.env': 'SECRET=1', 'index.html': 'x', '.git/config': 'x' }));
    for (const path of ['.env', '.git/config', 'sub/../.env']) {
      const r = await fetch(`${url}${path}`);
      assert.equal(r.status, 403, `出てしまった: ${path}`);
    }
  });

  test('\\ で区切った隠しファイルも断る（%5C を使うと、Windows では道の区切りになる）', async () => {
    // Windows の実機では確かめていない。判定の関数と、Linux で要求が断られることを見る
    assert.equal(hiddenRequest('x\\..\\.env'), true);
    assert.equal(hiddenRequest('sub\\.git\\config'), true);
    assert.equal(hiddenRequest('sub/a.txt'), false);
    assert.equal(hiddenRequest('./a.txt'), false);
    const url = await serve(await site({ '.env': 'SECRET=1', 'index.html': 'x' }));
    const r = await fetch(`${url}x%5C..%5C.env`);
    assert.equal(r.status, 403, '\\ で区切った .env を断っていない');
  });

  test('ふつうの頁は出る（対）', async () => {
    const url = await serve(await site({ 'index.html': 'ここ', 'a.txt': 'b' }));
    assert.equal((await fetch(`${url}a.txt`)).status, 200);
    assert.equal(await (await fetch(`${url}index.html`)).text().then((t) => t.includes('ここ')), true);
  });

  test('よその名前（Host）で来たら見せない', async () => {
    // fetch は Host を差し替えさせてくれない（黙って落とす）。生の http で送る。
    const url = new URL(await serve(await site({ 'index.html': 'x' })));
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({
        host: url.hostname, port: url.port, path: '/index.html', method: 'GET',
        headers: { host: 'evil.example' },
      }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 403);
  });
});

describe('リンク越しにも外を見せない', () => {
  test('外を指すリンクの先は 403 か 404', async () => {
    const { symlink, writeFile: wf } = await import('node:fs/promises');
    const { join: j } = await import('node:path');
    const { tempDir } = await import('./tmp.ts');
    const outside = await tempDir('aas-pv-out-');
    await wf(j(outside, 'secret.txt'), 'S');
    const root = await site({ 'index.html': 'x' });
    try { await symlink(outside, j(root, 'link')); } catch { return; /* リンクを作れない機械 */ }
    const url = await serve(root);
    const r = await fetch(`${url}link/secret.txt`);
    assert.ok(r.status === 403 || r.status === 404, `出てしまった: ${r.status}`);
  });
});
