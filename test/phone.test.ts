import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tempDir } from './tmp.ts';

// スマホから使う（docs/PHONE.md）。LAN の口は 127.0.0.1 の別の番号に開けて試す（ネットワークの形に頼らない）
const dir = await tempDir('aas-phone-');
process.env.AAS_STATE_DIR = dir;

const { UiServer } = await import('../src/ui/server.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');
const { PhoneAccess, isPrivateAddress, isLoopback, canListenOn, lanAddresses, readCookie, FAILS_PER_ADDRESS, FAIL_WINDOW_MS, openWithoutToken } = await import('../src/ui/phone.ts');

describe('住所の見分け', () => {
  test('私用の範囲だけを LAN と見る', () => {
    for (const a of ['10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.20', '169.254.3.4', '::ffff:192.168.0.9', 'fd12::1', 'fe80::1%eth0']) {
      assert.ok(isPrivateAddress(a), a);
    }
    for (const a of ['8.8.8.8', '172.32.0.1', '172.15.0.1', '192.169.0.1', '1.1.1.1', '2001:db8::1', '192.0.2.2', '127.0.0.1', '', 'x']) {
      assert.ok(!isPrivateAddress(a), a);
    }
  });
  test('自分の機械の中', () => {
    assert.ok(isLoopback('127.0.0.1') && isLoopback('::1') && isLoopback('::ffff:127.0.0.1'));
    assert.ok(!isLoopback('192.168.1.2') && !isLoopback(undefined));
  });
  test('公の住所には開けない', () => {
    assert.ok(!canListenOn('8.8.8.8') && !canListenOn('0.0.0.0') && !canListenOn('::'));
    assert.ok(canListenOn('192.168.1.2') && canListenOn('127.0.0.1'));
  });
  test('LAN の住所の一覧は私用の範囲の IPv4 だけで、169.254 は後ろ', () => {
    const got = lanAddresses({
      lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true } as never],
      a: [{ address: '169.254.1.1', family: 'IPv4', internal: false } as never, { address: '203.0.113.9', family: 'IPv4', internal: false } as never],
      b: [{ address: '192.168.10.4', family: 'IPv4', internal: false } as never, { address: 'fd00::4', family: 'IPv6', internal: false } as never],
    });
    assert.deepEqual(got, ['192.168.10.4', '169.254.1.1']);
  });
  test('トークンなしで読めるのは画面の頁とパスフレーズの口だけ', () => {
    assert.ok(openWithoutToken('/phone.html', 'GET') && openWithoutToken('/manifest.webmanifest', 'GET'));
    assert.ok(openWithoutToken('/api/phone/pair', 'POST'));
    assert.ok(!openWithoutToken('/api/phone/pair', 'GET') && !openWithoutToken('/api/send', 'POST') && !openWithoutToken('/api/events', 'GET'));
  });
});

describe('パスフレーズとトークン', () => {
  test('パスフレーズは 4 字ずつ 4 つで、作り直すと変わり、前のトークンは効かなくなる', async () => {
    const p = new PhoneAccess();
    assert.match(p.passphrase, /^[2-9a-zA-Z]{4}-[2-9a-zA-Z]{4}-[2-9a-zA-Z]{4}-[2-9a-zA-Z]{4}$/);
    const got = await p.pair('192.168.1.2', p.passphrase);
    assert.ok(got.ok);
    const cookie = `aas_phone=${got.ok ? got.token : ''}`;
    assert.ok(p.allows(cookie));
    const before = p.passphrase;
    await p.regenerate();
    assert.notEqual(p.passphrase, before);
    assert.ok(!p.allows(cookie));
  });
  test('区切りと空白は無くても通る。字の大小は区別する', async () => {
    const p = new PhoneAccess();
    assert.ok((await p.pair('10.0.0.1', ` ${p.passphrase.replace(/-/g, '')} `)).ok);
    const swapped = p.passphrase.replace(/[a-z]/, (c) => c.toUpperCase());
    if (swapped !== p.passphrase) assert.ok(!(await p.pair('10.0.0.2', swapped)).ok);
  });
  test('間違いが続くと、正しくてもしばらく断り、時間が過ぎれば戻る', async () => {
    let now = 1_000_000;
    const p = new PhoneAccess({ now: () => now });
    for (let i = 0; i < FAILS_PER_ADDRESS; i++) {
      const r = await p.pair('192.168.1.9', 'wrong');
      assert.equal(r.ok ? 0 : r.status, 401);
    }
    const blocked = await p.pair('192.168.1.9', p.passphrase);
    assert.equal(blocked.ok ? 0 : blocked.status, 429);
    // 別の住所は止めない（全体の上限までは）
    assert.ok((await p.pair('192.168.1.10', p.passphrase)).ok);
    now += FAIL_WINDOW_MS + 1;
    assert.ok((await p.pair('192.168.1.9', p.passphrase)).ok);
  });
  test('トークンには期限がある', async () => {
    let now = 0;
    const p = new PhoneAccess({ now: () => now });
    const r = await p.pair('192.168.1.2', p.passphrase);
    const cookie = `aas_phone=${r.ok ? r.token : ''}`;
    now += 29 * 86_400_000;
    assert.ok(p.allows(cookie));
    now += 2 * 86_400_000;
    assert.ok(!p.allows(cookie));
  });
  test('置いた設定から読み直せ、壊れていれば閉じた状態から始める', async () => {
    const file = join(dir, 'p1.json');
    const a = await PhoneAccess.load(file);
    await a.setEnabled(true);
    const r = await a.pair('192.168.1.2', a.passphrase);
    const b = await PhoneAccess.load(file);
    assert.ok(b.enabled);
    assert.equal(b.passphrase, a.passphrase);
    assert.ok(b.allows(`aas_phone=${r.ok ? r.token : ''}`));
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, '{ broken');
    assert.ok(!(await PhoneAccess.load(file)).enabled);
  });
  test('Cookie の見出しから名前で取り出す', () => {
    assert.equal(readCookie('a=1; aas_phone=xyz; b=2', 'aas_phone'), 'xyz');
    assert.equal(readCookie(undefined, 'aas_phone'), undefined);
  });
});

describe('本体の LAN の口', () => {
  let server: InstanceType<typeof UiServer>;
  let base = '';
  let lan = '';
  before(async () => {
    server = new UiServer({ config: DEFAULT_CONFIG, port: 0, phoneAddresses: ['127.0.0.1'], phonePort: 0 });
    base = (await server.start()).replace(/\/$/, '');
  });
  after(async () => { await server.stop(); });

  const post = (url: string, body: unknown, headers: Record<string, string> = {}) => fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), redirect: 'manual',
  });

  test('既定は閉じている（LAN には開かない）', async () => {
    const d = await (await fetch(`${base}/api/phone`)).json() as { enabled: boolean; listening: boolean; urls: string[] };
    assert.equal(d.enabled, false);
    assert.equal(d.listening, false);
    assert.deepEqual(d.urls, []);
  });

  test('入れると LAN の口が開き、QR とパスフレーズが出る', async () => {
    const r = await post(`${base}/api/phone`, { enabled: true });
    assert.equal(r.status, 200);
    const d = await (await fetch(`${base}/api/phone`)).json() as { listening: boolean; urls: string[]; passphrase: string; qr: string };
    assert.ok(d.listening);
    assert.match(d.urls[0]!, /^http:\/\/127\.0\.0\.1:\d+\/phone\.html$/);
    assert.match(d.qr, /^<svg [^>]*viewBox=/);
    assert.ok(d.passphrase.length >= 16);
    lan = new URL(d.urls[0]!).origin;
    assert.notEqual(lan, base);
  });

  test('LAN の口では、トークンの無い要求は 401。頁そのものは出る', async () => {
    assert.equal((await fetch(`${lan}/api/events/seq`)).status, 401);
    assert.equal((await post(`${lan}/api/send`, { text: 'hi' })).status, 401);
    assert.equal((await fetch(`${lan}/phone.html`)).status, 200);
    assert.equal((await fetch(`${lan}/manifest.webmanifest`)).headers.get('content-type')?.startsWith('application/manifest+json'), true);
    const top = await fetch(`${lan}/`, { redirect: 'manual' });
    assert.equal(top.status, 302);
    assert.equal(top.headers.get('location'), '/phone.html');
  });

  test('PC の画面（127.0.0.1 の口）は今までどおりトークンなしで使える', async () => {
    assert.equal((await fetch(`${base}/api/events/seq`)).status, 200);
  });

  test('正しいパスフレーズでトークン（HttpOnly・SameSite=Strict の Cookie）が出て、それで API が通る', async () => {
    const pass = ((await (await fetch(`${base}/api/phone`)).json()) as { passphrase: string }).passphrase;
    const r = await post(`${lan}/api/phone/pair`, { passphrase: pass });
    assert.equal(r.status, 200);
    const set = r.headers.get('set-cookie') ?? '';
    assert.match(set, /^aas_phone=[A-Za-z0-9_-]{40,};/);
    assert.match(set, /HttpOnly/);
    assert.match(set, /SameSite=Strict/);
    const cookie = set.split(';')[0]!;
    assert.equal((await fetch(`${lan}/api/events/seq`, { headers: { cookie } })).status, 200);
    // スマホからは、スマホの設定（パスフレーズを見る・閉じる）に触れない
    assert.equal((await fetch(`${lan}/api/phone`, { headers: { cookie } })).status, 403);
    assert.equal((await post(`${lan}/api/phone`, { enabled: false }, { cookie })).status, 403);
    // よその頁からは、トークンを持っていても断る
    assert.equal((await post(`${lan}/api/send`, { text: 'x' }, { cookie, origin: 'http://evil.example' })).status, 403);
    // 作り直すと、渡したトークンは効かない
    assert.equal((await post(`${base}/api/phone/regenerate`, {})).status, 200);
    assert.equal((await fetch(`${lan}/api/events/seq`, { headers: { cookie } })).status, 401);
  });

  test('違うパスフレーズは 401 で、続けば 429（正しいパスフレーズでも）', async () => {
    const pass = ((await (await fetch(`${base}/api/phone`)).json()) as { passphrase: string }).passphrase;
    for (let i = 0; i < FAILS_PER_ADDRESS; i++) assert.equal((await post(`${lan}/api/phone/pair`, { passphrase: 'aaaa-bbbb-cccc-dddd' })).status, 401);
    const r = await post(`${lan}/api/phone/pair`, { passphrase: pass });
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get('retry-after')) > 0);
    assert.equal((await post(`${lan}/api/phone/pair`, {})).status, 429);
  });

  test('切ると LAN の口が閉じる', async () => {
    assert.equal((await post(`${base}/api/phone`, { enabled: false })).status, 200);
    const d = await (await fetch(`${base}/api/phone`)).json() as { listening: boolean };
    assert.equal(d.listening, false);
    await assert.rejects(fetch(`${lan}/phone.html`, { signal: AbortSignal.timeout(5000) }));
  });
});

describe('公の住所', () => {
  test('公の住所を渡されても開けず、わけを言う', async () => {
    const server = new UiServer({ config: DEFAULT_CONFIG, port: 0, phoneAddresses: ['8.8.8.8'], phonePort: 0 });
    const base = (await server.start()).replace(/\/$/, '');
    try {
      const r = await fetch(`${base}/api/phone`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
      const d = await r.json() as { listening: boolean; problem: string; urls: string[] };
      assert.equal(d.listening, false);
      assert.deepEqual(d.urls, []);
      assert.match(d.problem, /公の住所には開けません: 8\.8\.8\.8/);
    } finally {
      await fetch(`${base}/api/phone`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
      await server.stop();
    }
  });
});
