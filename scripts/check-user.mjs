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
 *   6. 中のモデルが知らない新しい API（Node の `path.matchesGlob`）を使う glob.js を作らせ、動かして `path.matchesGlob` と同じ答えが出るかで
 *      判定する（成果物 5。知識はネットワークの送り口が nodejs.org から取る）。`--without-network` を付けると、取りに行くのを
 *      止めて（AAS_KNOWLEDGE_FETCH=0）起こし、6 は「中のモデルだけでは落ちる」ことを見る
 *
 * 答えの文面では判定しない（「作りました」と言っても、ファイルが無ければ落とす）。
 *
 * 使い方:
 *   node scripts/check-user.mjs --start "<起こす命令>" --port <口> --find <探す場所> [--find …] [--shots <置き先>] [--without-network]
 *
 * 画面を押すのは playwright-core。ブラウザは AAS_CHECK_BROWSER、無ければアプリのウィンドウと同じ探し方（Edge → Chrome）。
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
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
const withoutNetwork = process.argv.includes('--without-network');
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

/* 成果物 5: 中のモデル（4B）が知らない API。Node 22.5 で入った `path.matchesGlob`（`util.diff` は 4B が知っていた。
 * 2026-11-08 の手元の試しで、文書なしは 2 回とも落ち、nodejs.org の文書ありは 2 回とも通った）。答えは、この確かめを動かす node で出す */
const NEW_ASK = "glob.js というファイルを作ってください。node:path の matchesGlob を使って、'src/a/b.ts' が 'src/**/*.ts' に合うか、"
  + "'x.js' が '*.ts' に合うかを調べ、2 つの結果を空白でつないで console.log で 1 行に出します。glob の包みは使わず、node:path の matchesGlob を呼びます。"
  + "書くだけにして、動かさないでください（コマンドは実行しません）。";
const { matchesGlob } = await import('node:path');
const NEW_EXPECTED = typeof matchesGlob === 'function'
  ? `${matchesGlob('src/a/b.ts', 'src/**/*.ts')} ${matchesGlob('x.js', '*.ts')}` : undefined;

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
 * 画面に出た確かめの帯を押す。使う人は確かめの帯を見て押すので、押す（押さないと 10 分待って断ったことになる）。
 * `denyCommands` のときは、コマンド実行（`コマンド実行: …`）の帯だけ「拒否」を押す。3 つ目の頼みで、
 * 本体に glob.js を動かして試し直させないため（試し直すと、知識が無くても通ってしまう。run 42419219884）。
 * 押した数を返す。
 */
let denyCommands = false;
async function approveShown(page) {
  let n = 0;
  let d = 0;
  for (const box of await page.locator('.ask').all()) {
    if (!(await box.isVisible().catch(() => false))) continue;
    const head = await box.locator('.ask-head').first().innerText().catch(() => '');
    const deny = denyCommands && head.startsWith('コマンド実行');
    const btn = box.getByRole('button', { name: deny ? '拒否' : '許可', exact: true }).first();
    if (!(await btn.isVisible().catch(() => false))) continue;
    await btn.click().catch(() => undefined);
    if (deny) d += 1; else n += 1;
  }
  if (n > 0) say(`確かめの帯で「許可」を ${n} 回押しました`);
  if (d > 0) say(`確かめの帯で、コマンド実行に「拒否」を ${d} 回押しました`);
  return n + d;
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
const app = spawn(start, { shell: true, stdio: 'inherit', detached: process.platform !== 'win32', env: { ...process.env, AAS_UI_PORT: String(port), ...(withoutNetwork ? { AAS_KNOWLEDGE_FETCH: '0' } : {}) } });
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
  // 成果物 3: もう一度起こしても本体は 1 つのまま（ウィンドウだけ開き直す）。モデルの出来に左右されないよう、頼みの前に見る
  const info = async () => fetch(`http://127.0.0.1:${port}/api/info`, { signal: AbortSignal.timeout(3000) })
    .then((r) => (r.ok ? r.json() : undefined)).catch(() => undefined);
  const first = await info();
  if (!first?.pid) fail('本体の PID が /api/info に出ていません');
  const again = await new Promise((resolve) => {
    let out = '';
    const c = spawn(start, { shell: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, AAS_UI_PORT: String(port) } });
    c.stdout.on('data', (b) => { out += b; });
    c.stderr.on('data', (b) => { out += b; });
    const t = setTimeout(() => { try { c.kill(); } catch { /* */ } resolve({ code: -1, out }); }, 60_000);
    c.on('exit', (code) => { clearTimeout(t); resolve({ code, out }); });
  });
  if (again.code !== 0) fail(`2 回目の起動が 0 で終わりません（${again.code}）: ${again.out.slice(-400)}`);
  // 入口（AdaptiveAIStudio.cmd）はコンソールを最小化して渡し、すぐ戻る。本体が開き直すまで少し待つ
  await new Promise((r) => setTimeout(r, 5000));
  const second = await info();
  if (second?.pid !== first.pid) fail(`2 回目の起動で本体が入れ替わりました（${first.pid} → ${second?.pid}）`);
  say(`もう一度起こしても、本体は 1 つのまま（PID ${first.pid}）でした`);
  // 押して開くのはアプリのウィンドウだけ。コンソール（cmd、端末）のウィンドウが出ていたら落とす
  if (process.platform === 'win32') {
    const { execFileSync } = await import('node:child_process');
    const shown = execFileSync('powershell', ['-NoProfile', '-Command',
      "Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName -in @('cmd','conhost','WindowsTerminal','OpenConsole','powershell','pwsh') } | ForEach-Object { $_.ProcessName + ':' + $_.MainWindowTitle }"],
    { encoding: 'utf8' }).trim();
    // CI の手順そのものを動かしている powershell は数えない（題名が空でないものだけを見る）
    const consoles = shown.split(/\r?\n/).filter((l) => l && !/:$/.test(l) && /AdaptiveAIStudio|start\.cmd|node/i.test(l));
    if (consoles.length) fail(`コンソールのウィンドウが開いています: ${consoles.join(', ')}`);
    say('コンソールのウィンドウは開いていませんでした');
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

  // 成果物 5 の段 1: 送り先はネットワークモデル（画面の足元に「ネットワーク」と出る）
  {
    let shown = '';
    for (let i = 0; i < 10 && !shown.includes('ネットワーク'); i += 1) {
      shown = await page.innerText('body').catch(() => '');
      if (!shown.includes('ネットワーク')) await page.waitForTimeout(1000);
    }
    if (!shown.includes('ネットワーク')) fail('画面に「ネットワーク」が出ていません（送り先がネットワークモデルになっていない）');
    say('送り先はネットワークモデルです（画面に「ネットワーク」と出ています）');
  }

  // 成果物 4: Windows で取ったモデルは、自作アプリどうしで共有する C:\LLM\gguf に入る（LLM_HOME があればその下）
  if (process.platform === 'win32') {
    const shared = join(process.env.LLM_HOME?.trim() || 'C:\\LLM', 'gguf');
    const got = existsSync(shared) ? readdirSync(shared).filter((n) => n.toLowerCase().endsWith('.gguf')) : [];
    if (got.length === 0) fail(`共有の保存先 ${shared} にモデルがありません`);
    say(`モデルは共有の保存先 ${shared} にあります（${got.join(', ')}）`);
  }

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
  let why = '';
  try { fixed = execFileSync(process.execPath, [calc], { encoding: 'utf8', timeout: 10_000 }).trim(); }
  catch (e) { fixed = ''; why = String(e.stderr || e.message || e).trim().split('\n').slice(0, 6).join(' / '); }
  if (shots) await page.screenshot({ path: join(shots, '3-after-fix.png') });
  if (statSync(calc).mtimeMs === before) fail('20 分たっても calc.js が直されませんでした');
  if (fixed !== '5') fail(`calc.js を直しましたが、出力が 5 ではありません: 「${fixed}」 実行のエラー: 「${why}」 中身: 「${readFileSync(calc, 'utf8').slice(0, 400)}」`);
  say('calc.js が直り、動かすと 5 が出ることを確かめました');

  // 3 つ目（成果物 5）: 中のモデルが知らない新しい API を使う。ネットワークの送り口が nodejs.org から知識を取って足す
  if (!NEW_EXPECTED) fail('この node には path.matchesGlob がありません（Node 22.5 以降で確かめてください）');
  const newFile = join(dirname(file), 'glob.js');
  const newAt = Date.now() - 1000;
  denyCommands = true; // 3 つ目は書いた 1 回目の正しさを見る。動かして試し直させない
  await page.locator('.chat textarea').first().fill(NEW_ASK);
  await page.getByText('送る', { exact: true }).click();
  say(`3 つ目の頼み（新しい API の path.matchesGlob を使う glob.js）を送りました${withoutNetwork ? '（取りに行くのを止めています）' : ''}`);
  const until3 = Date.now() + 20 * 60_000;
  while (Date.now() < until3 && !(existsSync(newFile) && statSync(newFile).mtimeMs >= newAt)) {
    await page.waitForTimeout(10_000);
    await approveShown(page);
  }
  await idle(page, until3);
  denyCommands = false;
  if (shots) await page.screenshot({ path: join(shots, '4-after-new-api.png') });
  let newOut = '';
  let newWhy = '';
  const made = existsSync(newFile) && statSync(newFile).mtimeMs >= newAt;
  if (made) {
    try { newOut = execFileSync(process.execPath, [newFile], { encoding: 'utf8', timeout: 10_000 }).replace(/\r/g, '').trim(); }
    catch (e) { newWhy = String(e.stderr || e.message || e).trim().split('\n').slice(0, 6).join(' / '); }
  }
  const src = made ? readFileSync(newFile, 'utf8') : '';
  // 答えを書き写したものは通さない（node:path の matchesGlob を呼んでいること）
  const callsDiff = /node:path|require\(['"]path['"]\)|from ['"]path['"]/.test(src) && /\bmatchesGlob\s*\(/.test(src);
  const passed = made && newOut === NEW_EXPECTED && callsDiff;
  const newFail = !made ? '20 分たっても glob.js が出来ませんでした'
    : !callsDiff ? `glob.js が node:path の matchesGlob を呼んでいません。中身: 「${src.slice(0, 400)}」`
      : `glob.js の出力が違います: 「${newOut}」（正しくは ${NEW_EXPECTED}） 実行のエラー: 「${newWhy}」 中身: 「${src.slice(0, 400)}」`;
  if (withoutNetwork) {
    if (passed) fail('取りに行くのを止めても glob.js が通りました（中のモデルが path.matchesGlob を知っている。頼みを変える）');
    say(`取りに行くのを止めると、中のモデルだけでは落ちました: ${newFail.slice(0, 300)}`);
  } else {
    if (!passed) fail(newFail);
    say(`glob.js が node:path の matchesGlob を使い、動かすと ${NEW_EXPECTED} が出ることを確かめました`);
  }

  // 成果物 3: 終了で止まる（開き直しは、立ち上がった直後に確かめた）
  const quit = await fetch(`http://127.0.0.1:${port}/api/quit`, { method: 'POST' }).catch(() => undefined);
  if (quit?.status !== 200) fail(`終了が受け付けられません（${quit?.status ?? '繋がらない'}）`);
  let gone = false;
  for (let i = 0; i < 20 && !gone; i += 1) {
    await new Promise((r) => setTimeout(r, 1000));
    gone = !(await info());
  }
  if (!gone) fail('終了を押して 20 秒たっても、本体が止まりません');
  if (process.platform === 'win32') {
    const left = execFileSync('powershell', ['-NoProfile', '-Command',
      `if (Get-Process -Id ${first.pid} -ErrorAction SilentlyContinue) { 'alive' } else { 'gone' }`], { encoding: 'utf8', timeout: 15_000 }).trim();
    if (left !== 'gone') fail(`終了のあとも本体の PID ${first.pid} が残っています`);
  }
  say('終了で本体が止まりました');
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
console.log(`\n== 通りました（${elapsed()}）: 入れた形で、既定のモデルが頼んだファイルを作り、既にあるファイルも直し、どちらも正しく動きました。${withoutNetwork ? '取りに行くのを止めると、新しい API を使う頼みは中のモデルだけでは落ちました。' : 'ネットワークから取った知識で、新しい API を使う頼みも通りました。'}もう一度起こしても本体は 1 つのままで、終了で止まりました`);
process.exit(0);
