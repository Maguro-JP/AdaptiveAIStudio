/**
 * 使う人と同じ道で、1 往復ではなく「頼んだ仕事が出来ている」ことを確かめる。
 *
 * `check-real.mjs` は「1+1= に 2」と「read_file を 1 回呼ぶ」までしか見ていなかった。
 * それでは、入れた人が実際に頼む仕事で動くかが分からない（実際に「動かない」と言われた）。
 *
 * やること:
 *   1. 入れた形（setup.exe で入れたもの、または portable）を、利用者と同じ入口で起こす
 *   2. 画面を開き、帯のボタン「小さいモデル（約…GB）を取ってくる」を押して既定のモデルを取る
 *   3. 画面の入力欄から、ファイルを作る仕事を頼む（fizzbuzz.js）
 *   4. 出来たファイルを node で動かし、15 行の出力が合っているかで判定する
 *   5. 引き算になっている calc.js を置いて直させ、動かして 5 が出るかで判定する
 *
 * 答えの文面では判定しない（「作りました」と言っても、ファイルが無ければ落とす）。
 *
 * 使い方:
 *   node scripts/check-user.mjs --start "<起こす命令>" --port <口> --find <探す場所> [--find …] [--shots <置き先>]
 *
 * 画面を押すのは playwright-core。ブラウザは AAS_CHECK_BROWSER、無ければアプリのウィンドウと同じ探し方（Edge → Chrome）。
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { findAppBrowser } from '../src/core/app-window.ts';

function args(name) {
  const out = [];
  process.argv.forEach((a, i) => { if (a === name && process.argv[i + 1] !== undefined) out.push(process.argv[i + 1]); });
  return out;
}
const start = args('--start')[0];
const port = Number(args('--port')[0] ?? 4174);
const finds = args('--find');
const shots = args('--shots')[0];
if (!start || finds.length === 0) {
  console.error('使い方: node scripts/check-user.mjs --start "<起こす命令>" --port <口> --find <探す場所>');
  process.exit(2);
}
if (shots) mkdirSync(shots, { recursive: true });

const EXPECTED = Array.from({ length: 15 }, (_, i) => {
  const n = i + 1;
  return n % 15 === 0 ? 'FizzBuzz' : n % 3 === 0 ? 'Fizz' : n % 5 === 0 ? 'Buzz' : String(n);
}).join('\n');
const ASK = 'fizzbuzz.js というファイルを作ってください。1 から 15 までの数を順に 1 行ずつ console.log で出します。'
  + '3 の倍数は Fizz、5 の倍数は Buzz、3 と 5 の両方の倍数は FizzBuzz を、数の代わりに出します。';

const FIX_ASK = 'calc.js の add が、足し算ではなく引き算になっています。足し算になるように直してください。';

const began = Date.now();
const elapsed = () => `${Math.round((Date.now() - began) / 1000)}秒`;
const say = (s) => console.log(`[${elapsed()}] ${s}`);
let failed;
const fail = (s) => { failed = s; throw new Error(s); };

/** 探す場所の下で、いちばん新しい fizzbuzz.js。node_modules は見ない。 */
function newestFizz(dirs, since) {
  let best;
  const walk = (d, depth) => {
    if (depth > 6) return;
    let names = [];
    try { names = readdirSync(d); } catch { return; }
    for (const n of names) {
      if (n === 'node_modules' || n === '.git') continue;
      const p = join(d, n);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p, depth + 1);
      else if (n.toLowerCase() === 'fizzbuzz.js' && st.mtimeMs >= since && (!best || st.mtimeMs > best.at)) best = { path: p, at: st.mtimeMs };
    }
  };
  for (const d of dirs) walk(d, 0);
  return best?.path;
}

/**
 * 画面に出た「許可」を押す。使う人は確かめの帯を見て押すので、押す（押さないと 10 分待って断ったことになる）。
 * 押した数を返す。
 */
async function approveShown(page) {
  let n = 0;
  for (const btn of await page.getByRole('button', { name: '許可', exact: true }).all()) {
    if (await btn.isVisible().catch(() => false)) { await btn.click().catch(() => undefined); n += 1; }
  }
  if (n > 0) say(`確かめの帯で「許可」を ${n} 回押しました`);
  return n;
}

/** 本体の手が空くまで待つ（確かめの帯が出れば押す）。上限 `deadline` を過ぎたら、そのまま進む。 */
async function idle(page, deadline) {
  while (Date.now() < deadline) {
    await approveShown(page);
    const s = await fetch(`http://127.0.0.1:${port}/api/approvals`).then((r) => r.json()).catch(() => ({}));
    if (s.busy === false && !s.planning) return;
    await page.waitForTimeout(5_000);
  }
}

async function waitUp() {
  for (let i = 0; i < 120; i += 1) {
    const ok = await fetch(`http://127.0.0.1:${port}/api/info`, { signal: AbortSignal.timeout(2000) })
      .then((r) => r.ok).catch(() => false);
    if (ok) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  fail('画面の本体が 120 秒たっても立ち上がりませんでした');
}

// 組ごと止められるように、Windows 以外は別の組で起こす（後で残った本体やモデルの口が、次の確かめに繋がっていた）
const app = spawn(start, { shell: true, stdio: 'inherit', detached: process.platform !== 'win32', env: { ...process.env, AAS_UI_PORT: String(port) } });
/** 起こしたものを、子ごと止める。/api/quit は作業中だと断られる（409）ので、それだけに頼らない。 */
function stopAll() {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/T', '/F', '/PID', String(app.pid)], { stdio: 'ignore' });
    else process.kill(-app.pid, 'SIGTERM');
  } catch { /* 終わっている */ }
}
let browser;
let page;
try {
  say(`起こします: ${start}`);
  await waitUp();
  say('画面の本体が立ち上がりました');

  // アプリのウィンドウで開いたか（ブラウザのタブにしない）。Windows では Edge が --app で起きているはず
  if (process.platform === 'win32' && process.env.AAS_UI_NO_OPEN !== '1') {
    let found = '';
    for (let i = 0; i < 20 && !found; i += 1) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        found = execFileSync('powershell', ['-NoProfile', '-Command',
          "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*--app=http://127.0.0.1:*' } | Select-Object -First 1 -ExpandProperty Name"],
        { encoding: 'utf8', timeout: 15_000 }).trim();
      } catch { found = ''; }
    }
    if (!found) fail('アプリのウィンドウ（--app で開いたブラウザ）が見つかりません');
    say(`アプリのウィンドウで開きました（${found} を --app で起こしています）`);
  }

  const { chromium } = await import('playwright-core');
  const exe = process.env.AAS_CHECK_BROWSER || findAppBrowser(process.platform, process.env, existsSync);
  browser = await chromium.launch(exe ? { executablePath: exe } : {});
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });

  // 帯は /api/ready を聞いてから出る。出るか、もう話せると分かるまで待つ（isVisible は待たない）
  const get = page.getByText(/小さいモデル（約.*GB）を取ってくる/).first();
  const shown = await get.waitFor({ state: 'visible', timeout: 60_000 }).then(() => true).catch(() => false);
  if (shown) {
    say(`帯のボタンを押します: ${await get.innerText()}`);
    await get.click();
    const until = Date.now() + 30 * 60_000;
    for (;;) {
      await page.waitForTimeout(10_000);
      const ready = await fetch(`http://127.0.0.1:${port}/api/ready`).then((r) => r.json()).catch(() => ({}));
      if (ready.ready) break;
      if (ready.canFetch?.failed) fail(`モデルを取れませんでした: ${ready.canFetch.failed}`);
      if (Date.now() > until) fail('モデルが 30 分たっても取り終わりませんでした');
    }
    say('モデルを取り終え、話せる状態になりました');
  } else {
    // 初めて起こしたときは、押す前に本体が推奨のモデルを取りに行く（帯は「取ってきています…」になる）
    const until = Date.now() + 30 * 60_000;
    let ready = await fetch(`http://127.0.0.1:${port}/api/ready`).then((r) => r.json()).catch(() => ({}));
    if (!ready.ready && ready.canFetch?.fetching) say('押す前に、本体が推奨のモデルを取りに行っています');
    while (!ready.ready && ready.canFetch?.fetching && Date.now() < until) {
      await page.waitForTimeout(10_000);
      ready = await fetch(`http://127.0.0.1:${port}/api/ready`).then((r) => r.json()).catch(() => ({}));
    }
    if (!ready.ready) fail(`話せる状態になりません: ${JSON.stringify(ready).slice(0, 400)}`);
    say('話せる状態です（押さずに済みました）');
  }
  if (shots) await page.screenshot({ path: join(shots, '1-ready.png') });

  const askedAt = Date.now() - 1000;
  const box = page.locator('.chat textarea').first();
  await box.fill(ASK);
  await page.getByText('送る', { exact: true }).click();
  say('頼みを送りました');

  let file;
  const until = Date.now() + 20 * 60_000;
  while (!file && Date.now() < until) {
    await page.waitForTimeout(10_000);
    await approveShown(page);
    file = newestFizz(finds, askedAt);
  }
  if (shots) await page.screenshot({ path: join(shots, '2-after-ask.png') });
  if (!file) fail('20 分たっても fizzbuzz.js が出来ませんでした');
  // 頼みが終わるまで待ってから動かす。モデルは書いて、走らせて、直すことがある（最初に書いた版で判定しない）
  await idle(page, until);
  say(`出来たファイル: ${file}`);
  let out;
  try {
    out = execFileSync(process.execPath, [file], { encoding: 'utf8', timeout: 10_000 }).replace(/\r/g, '').trim();
  } catch (e) {
    fail(`fizzbuzz.js が動きませんでした: ${String(e.stderr || e.message).split('\n').slice(0, 5).join(' / ')}`);
  }
  if (out !== EXPECTED) fail(`出力が違います。\n--- 出た\n${out}\n--- 正しい\n${EXPECTED}`);
  say('fizzbuzz.js を動かし、15 行の出力が正しいことを確かめました');

  // 2 つ目: 既にあるファイルを直す（作るより難しい。読んでから、合っている所を残して直す）
  const calc = join(dirname(file), 'calc.js');
  writeFileSync(calc, 'function add(a, b) {\n  return a - b;\n}\nconsole.log(add(2, 3));\n');
  const before = statSync(calc).mtimeMs;
  await page.locator('.chat textarea').first().fill(FIX_ASK);
  await page.getByText('送る', { exact: true }).click();
  say('2 つ目の頼み（calc.js を直す）を送りました');
  let fixed = '';
  const until2 = Date.now() + 20 * 60_000;
  while (Date.now() < until2 && statSync(calc).mtimeMs === before) {
    await page.waitForTimeout(10_000);
    await approveShown(page);
  }
  await idle(page, until2);
  try { fixed = execFileSync(process.execPath, [calc], { encoding: 'utf8', timeout: 10_000 }).trim(); } catch { fixed = ''; }
  if (shots) await page.screenshot({ path: join(shots, '3-after-fix.png') });
  if (statSync(calc).mtimeMs === before) fail('20 分たっても calc.js が直されませんでした');
  if (fixed !== '5') fail(`calc.js を直しましたが、出力が 5 ではありません: 「${fixed}」`);
  say('calc.js が直り、動かすと 5 が出ることを確かめました');
} catch (e) {
  if (!failed) failed = e instanceof Error ? e.message : String(e);
  if (page && shots) await page.screenshot({ path: join(shots, 'failed.png') }).catch(() => undefined);
  if (page) {
    const body = await page.innerText('body').catch(() => '');
    console.log(`--- 画面の文字（先頭）\n${body.slice(0, 3000)}`);
  }
} finally {
  await browser?.close().catch(() => undefined);
  await fetch(`http://127.0.0.1:${port}/api/quit`, { method: 'POST' }).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 3000));
  stopAll();
}

if (failed) {
  console.log(`\n== 落ちました（${elapsed()}）: ${failed}`);
  process.exit(1);
}
console.log(`\n== 通りました（${elapsed()}）: 入れた形で、既定のモデルが頼んだファイルを作り、既にあるファイルも直し、どちらも正しく動きました`);
process.exit(0);
