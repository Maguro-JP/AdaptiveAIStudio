/**
 * スマホから使う（docs/PHONE.md）の確かめ。入れた形（配る形）の本体を起こし、PC の画面の「設定 → スマホ」を押して LAN に開き、
 * スマホの形（Playwright の iPhone の見立て）で LAN の URL を開き、パスフレーズを入れて繋ぎ、頼みを送って答えを見る。
 *
 *   node scripts/check-phone.mjs --start "<起こす命令>" --port <口> [--lan <LAN の住所>] [--shots <dir>]
 *
 * --lan を渡さないと 127.0.0.2 に開く（CI や、LAN の無い機械でも回せるように。本体は AAS_PHONE_ADDRESS で受ける）。
 * 127.0.0.2 は自分の機械の中だが、LAN の口から来た要求は住所によらずトークンを求めるので、関所の確かめとして同じになる。
 * 確かめは足すだけ。一度載せた id（checks/phone.ids）は消さない・飛ばさない（test/phone-checks.test.ts が止める）。
 * 1 行ずつ「== PASS <id>: …」「== FAIL <id>: …」を出し、最後に「== 結果: n/m」。1 つでも落ちたら 1 で終わる。
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { findAppBrowser } from '../src/core/app-window.ts';

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const start = opt('--start');
const port = Number(opt('--port') ?? 4177);
const lanHost = opt('--lan') ?? '127.0.0.2';
const shots = opt('--shots');
const work = resolve(opt('--work') ?? join(tmpdir(), `aas-phone-check-${Date.now()}`));
if (!start) {
  console.error('使い方: node scripts/check-phone.mjs --start "<起こす命令>" --port <口> [--lan <LAN の住所>] [--shots <dir>]');
  process.exit(2);
}
mkdirSync(work, { recursive: true });
if (shots) mkdirSync(shots, { recursive: true });

const ASK = '1234 × 5678 は?';
const ANSWER = '7006652';
const say = (s) => console.log(`[${new Date().toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo' })}] ${s}`);
const api = (p, init) => fetch(`http://127.0.0.1:${port}${p}`, { signal: AbortSignal.timeout(30_000), ...init }).then((r) => r.json()).catch(() => ({}));

const app = spawn(start, {
  shell: true, stdio: 'inherit', detached: process.platform !== 'win32',
  env: { ...process.env, AAS_UI_PORT: String(port), AAS_UI_NO_OPEN: '1', AAS_PHONE_ADDRESS: lanHost },
});
function stopAll() {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/T', '/F', '/PID', String(app.pid)], { stdio: 'ignore' });
    else process.kill(-app.pid, 'SIGTERM');
  } catch { /* 終わっている */ }
}

let pc;
let phone;
let lanUrl = '';
let passphrase = '';
async function shot(p, name) {
  if (shots) await p.screenshot({ path: join(shots, name) }).catch(() => undefined);
}

/* ---------- 確かめの一覧（足すだけ） ---------- */
const CHECKS = [
  {
    id: 'phone-toggle-shows-qr',
    what: 'PC の画面の「設定 → スマホ」で「スマホから使う」を入れると、LAN の URL・パスフレーズ・QR が出る',
    async run() {
      await pc.click('#openSettings');
      await pc.click('#settings .tabs-lite button[data-sec="phone"]');
      const before = await pc.locator('#phoneStatus').innerText();
      await pc.locator('#phoneOn').check();
      await pc.locator('#phoneBox').waitFor({ state: 'visible', timeout: 15_000 });
      lanUrl = (await pc.locator('#phoneUrl').innerText()).split('\n')[0].trim();
      passphrase = (await pc.locator('#phonePass').innerText()).trim();
      const qr = await pc.locator('#phoneQr').evaluate((img) => ({ w: img.naturalWidth, src: img.src.slice(0, 26) }));
      await shot(pc, 'phone-pc-settings.png');
      const ok = lanUrl.startsWith(`http://${lanHost}:`) && /^\w{4}-\w{4}-\w{4}-\w{4}$/.test(passphrase) && qr.w > 0 && qr.src.startsWith('data:image/svg+xml');
      return { ok, why: `入れる前「${before}」。URL ${lanUrl}、パスフレーズ ${passphrase.length} 字、QR ${qr.w}px` };
    },
  },
  {
    id: 'phone-refuse-without-token',
    what: 'LAN の口では、パスフレーズで繋ぐ前の API は 401 で断られ、頁を開くとパスフレーズの画面が出る',
    async run() {
      const origin = new URL(lanUrl).origin;
      const status = (await fetch(`${origin}/api/events/seq`)).status;
      const sendStatus = (await fetch(`${origin}/api/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"text":"x"}' })).status;
      await phone.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
      await phone.locator('#pairView').waitFor({ state: 'visible', timeout: 15_000 });
      await shot(phone, 'phone-pair.png');
      const ok = status === 401 && sendStatus === 401 && /phone\.html$/.test(phone.url());
      return { ok, why: `トークンなしの /api/events/seq は ${status}、/api/send は ${sendStatus}。/ を開くと ${phone.url()}` };
    },
  },
  {
    id: 'phone-wrong-passphrase',
    what: '違うパスフレーズを入れると、繋がずに「パスフレーズが違います」と言う',
    async run() {
      await phone.fill('#pass', 'aaaa-bbbb-cccc-dddd');
      await phone.click('#pairGo');
      await phone.waitForFunction(() => /違います|受け付けません/.test(document.getElementById('pairNote')?.textContent ?? ''), null, { timeout: 15_000 });
      const note = await phone.locator('#pairNote').innerText();
      const still = await phone.locator('#pairView').isVisible();
      return { ok: /パスフレーズが違います/.test(note) && still, why: `出た: ${note}` };
    },
  },
  {
    id: 'phone-pair-and-answer',
    what: `正しいパスフレーズで繋ぎ、「${ASK}」を送ると、PC の本体の答え（${ANSWER} を含む）がスマホに出る`,
    async run() {
      await phone.fill('#pass', passphrase);
      await phone.click('#pairGo');
      await phone.locator('#chatView').waitFor({ state: 'visible', timeout: 15_000 });
      const tap = await phone.locator('#sendGo').boundingBox();
      await phone.fill('#ask', ASK);
      await phone.click('#sendGo');
      await phone.locator('.msg.me').first().waitFor({ timeout: 10_000 });
      // 答えが出終わる（待機中に戻る）まで待つ。モデルの読み込みを含めて 10 分まで
      await phone.waitForFunction(() => document.querySelector('.msg.ai') && !document.querySelector('.msg.ai.working') && /待機中/.test(document.getElementById('state')?.textContent ?? ''), null, { timeout: 600_000 });
      const answer = (await phone.locator('.msg.ai').allInnerTexts()).join('\n');
      await shot(phone, 'phone-chat.png');
      const ok = answer.replace(/[,，\s]/g, '').includes(ANSWER) && (tap?.height ?? 0) >= 44;
      return { ok, why: `答え: ${answer.replace(/\s+/g, ' ').slice(0, 160)}（送るの高さ ${Math.round(tap?.height ?? 0)}px）` };
    },
  },
  {
    id: 'phone-manifest-installable',
    what: 'ホーム画面に置ける形（manifest に名前・start_url・192 と 512 の絵柄。絵柄が読める）',
    async run() {
      const origin = new URL(lanUrl).origin;
      const link = await phone.locator('link[rel="manifest"]').getAttribute('href');
      const m = await (await fetch(`${origin}${link}`)).json();
      const sizes = (m.icons ?? []).map((i) => i.sizes);
      const icons = await Promise.all((m.icons ?? []).map(async (i) => (await fetch(`${origin}${i.src}`)).status));
      const ok = m.name === 'AdaptiveAIStudio' && m.start_url === '/phone.html' && m.display === 'standalone'
        && sizes.includes('192x192') && sizes.includes('512x512') && icons.every((s) => s === 200);
      return { ok, why: `manifest ${link}: ${m.name} / ${m.start_url} / ${m.display} / ${sizes.join(',')}（絵柄 ${icons.join(',')}）` };
    },
  },
  {
    id: 'phone-toggle-off-closes',
    what: '「スマホから使う」を切ると LAN の口が閉じ、スマホから届かなくなる',
    async run() {
      await pc.locator('#phoneOn').uncheck();
      await pc.waitForFunction(() => /入れていません/.test(document.getElementById('phoneStatus')?.textContent ?? ''), null, { timeout: 15_000 });
      const reach = await fetch(`${new URL(lanUrl).origin}/phone.html`, { signal: AbortSignal.timeout(5000) }).then((r) => `届いた（${r.status}）`, () => '届かない');
      const local = (await fetch(`http://127.0.0.1:${port}/api/events/seq`)).status;
      return { ok: reach === '届かない' && local === 200, why: `LAN の口: ${reach}。PC の画面の口: ${local}` };
    },
  },
];

const results = [];
let browser;
let failed = 0;
try {
  say(`起こします: ${start}`);
  for (let i = 0; ; i += 1) {
    if ((await api('/api/info')).pid) break;
    if (i > 120) throw new Error('本体が 120 秒たっても立ち上がりませんでした');
    await new Promise((r) => setTimeout(r, 1000));
  }
  await api('/api/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workRoot: work }) });
  const { chromium, devices } = await import('playwright-core');
  const exe = process.env.AAS_CHECK_BROWSER || findAppBrowser(process.platform, process.env, existsSync);
  browser = await chromium.launch(exe ? { executablePath: exe } : {});
  pc = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  pc.on('pageerror', (e) => say(`PC の画面の中で落ちました: ${e.message}（${(e.stack ?? '').split('\n').slice(1, 3).join(' ').trim()}）`));
  await pc.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await pc.locator('#openSettings').waitFor({ state: 'visible', timeout: 30_000 });
  // スマホの見立て（deviceScaleFactor は見立ての既定のまま）
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  phone = await ctx.newPage();
  phone.on('pageerror', (e) => say(`スマホの画面の中で落ちました: ${e.message}`));
  await phone.goto('about:blank');
  say(`PC の画面を開きました。LAN の住所: ${lanHost}`);
  for (const c of CHECKS) {
    const t0 = Date.now();
    let verdict;
    try { verdict = await c.run(); } catch (e) { verdict = { ok: false, why: `確かめの途中で落ちました: ${e.message.split('\n')[0]}` }; }
    if (!verdict.ok) { failed += 1; await shot(phone, `fail-${c.id}.png`); }
    results.push({ id: c.id, ok: verdict.ok });
    console.log(`== ${verdict.ok ? 'PASS' : 'FAIL'} ${c.id}: ${verdict.why}（${Math.round((Date.now() - t0) / 1000)} 秒）`);
  }
} catch (e) {
  console.log(`== FAIL 起動: ${e.message}`);
  failed += 1;
} finally {
  await browser?.close().catch(() => undefined);
  await fetch(`http://127.0.0.1:${port}/api/quit`, { method: 'POST' }).catch(() => undefined);
  stopAll();
}
console.log(`== 結果: ${results.filter((r) => r.ok).length}/${CHECKS.length}`);
process.exit(failed > 0 ? 1 : 0);
