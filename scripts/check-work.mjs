/**
 * 働くかの確かめ。起動の確かめではない（それは check-user.mjs）。
 *
 * 入れた形（配る形）の本体を起こし、画面の入力欄から本物のモデルに質問と作業を頼み、答えの中身と出来たファイルで判定する。
 * 既定の一覧（checks/work.json）は毎回全部を回す。--ask / --task / --list はそれに足すだけ（代わりにしない）。
 *
 *   node scripts/check-work.mjs --start "<起こす命令>" --port <口> [--work <作業場>] [--shots <dir>] [--out <結果の json>]
 *     [--list <自分の一覧.json>] [--ask "<質問>" --expect "<正規表現>"] [--task "<頼み>" --file <名前> --stdout "<出力>"]
 *
 * 1 行ずつ「== PASS <id>: …」「== FAIL <id>: …」を出し、最後に「== 結果: n/m」。1 つでも落ちたら 1 で終わる。
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { findAppBrowser } from '../src/core/app-window.ts';
import { adHocChecks, judgeAnswer, liveTruth } from './work-judge.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const start = opt('--start');
const port = Number(opt('--port') ?? 4176);
const shots = opt('--shots');
const out = opt('--out');
const work = resolve(opt('--work') ?? join(tmpdir(), `aas-work-check-${Date.now()}`));
if (!start) {
  console.error('使い方: node scripts/check-work.mjs --start "<起こす命令>" --port <口> [--work <作業場>] [--list <一覧>] [--ask … --expect …] [--task … --file … --stdout …]');
  process.exit(2);
}
mkdirSync(work, { recursive: true });
if (shots) mkdirSync(shots, { recursive: true });

const checks = JSON.parse(readFileSync(join(here, '..', 'checks', 'work.json'), 'utf8')).checks;
const own = opt('--list');
if (own) checks.push(...JSON.parse(readFileSync(own, 'utf8')).checks.map((c) => ({ ...c, id: `list:${c.id}` })));
checks.push(...adHocChecks(argv));

const say = (s) => console.log(`[${new Date().toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo' })}] ${s}`);
const api = (p, init) => fetch(`http://127.0.0.1:${port}${p}`, { signal: AbortSignal.timeout(30_000), ...init }).then((r) => r.json()).catch(() => ({}));

const app = spawn(start, { shell: true, stdio: 'inherit', detached: process.platform !== 'win32', env: { ...process.env, AAS_UI_PORT: String(port), AAS_UI_NO_OPEN: '1' } });
function stopAll() {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/T', '/F', '/PID', String(app.pid)], { stdio: 'ignore' });
    else process.kill(-app.pid, 'SIGTERM');
  } catch { /* 終わっている */ }
}

async function approveShown(page) {
  for (const box of await page.locator('.ask').all()) {
    if (!(await box.isVisible().catch(() => false))) continue;
    const btn = box.getByRole('button', { name: '許可', exact: true }).first();
    if (await btn.isVisible().catch(() => false)) await btn.click().catch(() => undefined);
  }
}

/** 送って、手が空くまで待ち、その会話の最後の答えを返す。 */
async function askOnScreen(page, text, minutes) {
  await api('/api/conversations', { method: 'POST' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  const box = page.locator('.chat textarea').first();
  await box.waitFor({ state: 'visible', timeout: 60_000 });
  await box.fill(text);
  await page.getByText('送る', { exact: true }).click();
  const until = Date.now() + minutes * 60_000;
  await page.waitForTimeout(3000);
  for (;;) {
    await approveShown(page);
    const s = await api('/api/approvals');
    if (s.busy === false && !s.planning) break;
    if (Date.now() > until) break;
    await page.waitForTimeout(3000);
  }
  const list = await api('/api/conversations');
  const id = list.current ?? list.list?.[0]?.id;
  const msgs = id ? (await api(`/api/conversations/messages?id=${encodeURIComponent(id)}`)).messages ?? [] : [];
  const last = [...msgs].reverse().find((m) => m.role === 'assistant' && String(m.content ?? '').trim());
  return { answer: String(last?.content ?? ''), id };
}

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
  const { chromium } = await import('playwright-core');
  const exe = process.env.AAS_CHECK_BROWSER || findAppBrowser(process.platform, process.env, existsSync);
  browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  // モデルが無ければ、利用者と同じく帯のボタンで取る（入れた直後の Windows）
  const get = page.getByText(/小さいモデル（約.*GB）を取ってくる/).first();
  if (await get.waitFor({ state: 'visible', timeout: 30_000 }).then(() => true).catch(() => false)) {
    say(`帯のボタンを押します: ${await get.innerText()}`);
    await get.click();
  }
  for (let i = 0; !(await api('/api/ready')).ready; i += 1) {
    if (i > 360) throw new Error('話せる状態になりません（30 分）');
    await new Promise((r) => setTimeout(r, 5000));
  }
  await api('/api/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workRoot: work }) });
  const place = (await api('/api/location')).location ?? '東京';
  say(`話せる状態です。作業場: ${work}、天気の既定の場所: ${place}`);

  for (const c of checks) {
    const t0 = Date.now();
    let verdict;
    try {
      if (c.kind === 'task') {
        const file = join(work, c.judge.file);
        if (c.setup) writeFileSync(join(work, c.setup.file), c.setup.content);
        const before = existsSync(file) ? statSync(file).mtimeMs : 0;
        const { answer } = await askOnScreen(page, c.ask, 20);
        if (!existsSync(file) || statSync(file).mtimeMs === before) verdict = { ok: false, why: `${c.judge.file} が出来ていません（直っていません）。答え: ${answer.slice(0, 200)}` };
        else {
          let got;
          try { got = execFileSync(process.execPath, [file], { encoding: 'utf8', timeout: 10_000, cwd: work }).trim(); } catch (e) { got = `（落ちました: ${String(e.stderr || e.message).split('\n')[0]}）`; }
          verdict = got === c.judge.stdout ? { ok: true, why: `動かすと「${got}」` } : { ok: false, why: `動かすと「${got}」（正しくは「${c.judge.stdout}」）` };
        }
        verdict.answer = answer;
      } else {
        const { answer } = await askOnScreen(page, c.ask, 10);
        const truth = await liveTruth(c.judge, place);
        verdict = { ...judgeAnswer(c.judge, answer, truth), answer };
      }
    } catch (e) {
      verdict = { ok: false, why: `確かめの途中で落ちました: ${e.message}`, answer: '' };
    }
    if (!verdict.ok) failed += 1;
    if (shots) await page.screenshot({ path: join(shots, `${c.id.replace(/[^\w-]/g, '_')}.png`) }).catch(() => undefined);
    results.push({ id: c.id, ask: c.ask, ok: verdict.ok, why: verdict.why, answer: verdict.answer, seconds: Math.round((Date.now() - t0) / 1000) });
    console.log(`== ${verdict.ok ? 'PASS' : 'FAIL'} ${c.id}: ${verdict.why} ／ 答え: ${String(verdict.answer).replace(/\s+/g, ' ').slice(0, 160)}`);
  }
} catch (e) {
  console.log(`== FAIL 起動: ${e.message}`);
  failed += 1;
} finally {
  await browser?.close().catch(() => undefined);
  await fetch(`http://127.0.0.1:${port}/api/quit`, { method: 'POST' }).catch(() => undefined);
  stopAll();
}
console.log(`== 結果: ${results.filter((r) => r.ok).length}/${checks.length}`);
if (out) writeFileSync(out, JSON.stringify(results, null, 2));
process.exit(failed > 0 ? 1 : 0);
