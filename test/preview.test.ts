/**
 * 作っているものを見る口。
 *
 * 見えることより、**操作用の口と混ざらないこと**を確かめる。
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';
import { PreviewServer, inject, listing, RELOAD_SNIPPET } from '../src/ui/preview.ts';

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
