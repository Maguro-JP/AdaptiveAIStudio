/**
 * ブロックでつくる画面の確かめ（docs/BLOCKS.md）。入れた形（配る形）の本体を起こし、画面を押して組み、動かし、出た結果で判定する。
 *
 *   node scripts/check-blocks.mjs --start "<起こす命令>" --port <口> [--work <作業場>] [--shots <dir>]
 *
 * 確かめは足すだけ。一度載せた id（checks/blocks.ids）は消さない・飛ばさない（test/blocks-checks.test.ts が止める）。
 * 1 行ずつ「== PASS <id>: …」「== FAIL <id>: …」を出し、最後に「== 結果: n/m」。1 つでも落ちたら 1 で終わる。
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { findAppBrowser } from '../src/core/app-window.ts';
import { liveTruth, weatherGroup } from './work-judge.mjs';

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const start = opt('--start');
const port = Number(opt('--port') ?? 4177);
const shots = opt('--shots');
const work = resolve(opt('--work') ?? join(tmpdir(), `aas-blocks-check-${Date.now()}`));
if (!start) {
  console.error('使い方: node scripts/check-blocks.mjs --start "<起こす命令>" --port <口> [--work <作業場>] [--shots <dir>]');
  process.exit(2);
}
mkdirSync(work, { recursive: true });
if (shots) mkdirSync(shots, { recursive: true });

const FIZZ = ['1', '2', 'Fizz', '4', 'Buzz', 'Fizz', '7', '8', 'Fizz', 'Buzz', '11', 'Fizz', '13', '14', 'FizzBuzz'];
const say = (s) => console.log(`[${new Date().toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo' })}] ${s}`);
const api = (p, init) => fetch(`http://127.0.0.1:${port}${p}`, { signal: AbortSignal.timeout(30_000), ...init }).then((r) => r.json()).catch(() => ({}));

const app = spawn(start, { shell: true, stdio: 'inherit', detached: process.platform !== 'win32', env: { ...process.env, AAS_UI_PORT: String(port), AAS_UI_NO_OPEN: '1' } });
function stopAll() {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/T', '/F', '/PID', String(app.pid)], { stdio: 'ignore' });
    else process.kill(-app.pid, 'SIGTERM');
  } catch { /* 終わっている */ }
}

/* ---------- 画面を押す手 ---------- */
let page;
const node = (id) => `.bk-node[data-id="${id}"]`;
/** 押したまま引いて離す（利用者の手と同じ。途中も動かす） */
async function drag(from, toX, toY) {
  const a = await from.boundingBox();
  if (!a) throw new Error('引くものが見えません');
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(toX, toY, { steps: 8 });
  await page.mouse.up();
}
async function place(kind, x, y) {
  // 左の一覧から引いて、置く所（画面の中の座標）に落とす。ブロックの左上が (x, y) になる
  const st = await page.locator('#stage').boundingBox();
  await drag(page.locator(`.bk-pal-item[data-kind="${kind}"]`), st.x + x + 20, st.y + y + 12);
}
async function wire(a, ap, b, bp) {
  const to = await page.locator(`${node(b)} .bk-port.in[data-port="${bp}"]`).boundingBox();
  if (!to) throw new Error(`${b} の ${bp} の口が見えません`);
  await drag(page.locator(`${node(a)} .bk-port.out[data-port="${ap}"]`), to.x + to.width / 2, to.y + to.height / 2);
}
async function typeIn(sel, value) {
  const box = page.locator(sel);
  await box.fill(String(value));
  await box.press('Tab');
}
async function runAndRead() {
  await page.click('#runIt');
  await page.waitForFunction(() => /終わりました|止まりました/.test(document.getElementById('runState')?.textContent ?? ''), null, { timeout: 60_000 });
  return { state: await page.locator('#runState').innerText(), lines: await page.locator('#out .line').allInnerTexts() };
}
async function shot(name) {
  if (shots) await page.screenshot({ path: join(shots, name) }).catch(() => undefined);
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ---------- 確かめの一覧（足すだけ） ---------- */
const CHECKS = [
  {
    id: 'blocks-fizzbuzz-by-hand',
    what: '空から、ブロックを引いて置き、口をつないで FizzBuzz を組み、▶ 動かす で 1〜15 が正しく出る',
    async run() {
      await page.click('#newOne');
      await page.click('#viewGraph');
      await place('repeat', 40, 40);
      for (const [i, y] of [[2, 40], [4, 300], [6, 560]]) { await place('calc', 320, y); await place('compare', 600, y); void i; }
      await place('if', 880, 560); await place('if', 1160, 300); await place('if', 1440, 40); await place('show', 1720, 40);
      const count = await page.locator('.bk-node').count();
      if (count !== 11) return { ok: false, why: `置いたブロックが ${count} 個（11 個のはず）` };
      await typeIn(`${node('n1')} .bk-row.in[data-port="to"] input`, 15);
      for (const [id, b] of [['n2', 15], ['n4', 3], ['n6', 5]]) {
        await page.locator(`${node(id)} .bk-row.field select`).selectOption('余り');
        await typeIn(`${node(id)} .bk-row.in[data-port="b"] input`, b);
      }
      for (const [id, text] of [['n8', 'Buzz'], ['n9', 'Fizz'], ['n10', 'FizzBuzz']]) await typeIn(`${node(id)} .bk-row.in[data-port="yes"] input`, text);
      for (const w of [
        ['n1', 'each', 'n2', 'a'], ['n1', 'each', 'n4', 'a'], ['n1', 'each', 'n6', 'a'],
        ['n2', 'out', 'n3', 'a'], ['n4', 'out', 'n5', 'a'], ['n6', 'out', 'n7', 'a'],
        ['n7', 'out', 'n8', 'cond'], ['n1', 'each', 'n8', 'no'],
        ['n5', 'out', 'n9', 'cond'], ['n8', 'out', 'n9', 'no'],
        ['n3', 'out', 'n10', 'cond'], ['n9', 'out', 'n10', 'no'],
        ['n10', 'out', 'n11', 'value'],
      ]) await wire(...w);
      const wires = await page.locator('#wires path').count();
      if (wires !== 13) return { ok: false, why: `つないだ線が ${wires} 本（13 本のはず）` };
      const got = await runAndRead();
      await shot('blocks-fizzbuzz.png');
      return same(got.lines, FIZZ) ? { ok: true, why: `出た: ${got.lines.join(',')}（${got.state}）` } : { ok: false, why: `出た: ${got.lines.join(',')}（${got.state}）` };
    },
  },
  {
    id: 'blocks-refuse-wrong-type',
    what: '型の合わない口（数を真偽の口へ）は、つながずに、わけを言う',
    async run() {
      const before = await page.locator('#wires path').count();
      await wire('n2', 'out', 'n9', 'cond');
      const note = await page.locator('#note').innerText();
      const after = await page.locator('#wires path').count();
      return /つなげません: 数は真偽の口にはつなげません/.test(note) && after === before
        ? { ok: true, why: `断った: ${note}` } : { ok: false, why: `表示: ${note}、線 ${before}→${after}` };
    },
  },
  {
    id: 'blocks-code-export-runs',
    what: '右の JavaScript を作業場に書き出し、Node で動かすと同じ FizzBuzz が出る',
    async run() {
      const code = await page.locator('#code').innerText();
      if (!/for \(let v_n1_each = 1; v_n1_each <= 15;/.test(code)) return { ok: false, why: `JavaScript の欄: ${code.slice(0, 120)}` };
      await page.click('#exportCode');
      await page.fill('#askInput', 'fizz.mjs');
      await page.click('#askOk');
      await page.waitForFunction(() => /書き出しました/.test(document.getElementById('note')?.textContent ?? ''), null, { timeout: 15_000 });
      const out = execFileSync(process.execPath, [join(work, 'fizz.mjs')], { encoding: 'utf8', timeout: 10_000 }).trim().split(/\r?\n/);
      return same(out, FIZZ) ? { ok: true, why: `node fizz.mjs: ${out.join(',')}` } : { ok: false, why: `node fizz.mjs: ${out.join(',')}` };
    },
  },
  {
    id: 'blocks-direction-same-output',
    what: '向きを 上から下・左上から右（折り返し）・左から右 に変えて 整える。どの向きでも同じ JavaScript、同じ結果。折り返しは読む順に並び、前に覚えた diag は wrap として読む',
    async run() {
      const code0 = await page.locator('#code').innerText();
      const seen = [];
      for (const [dir, file] of [['ttb', 'blocks-ttb.png'], ['wrap', 'blocks-wrap.png'], ['ltr', 'blocks-ltr.png']]) {
        await page.click(`[data-dir="${dir}"]`);
        await page.click('#tidy');
        const got = await runAndRead();
        await shot(file);
        if (dir === 'wrap') {
          // 読む順: 次のブロックは、同じ段なら右、そうでなければ下の段の左端
          const boxes = await page.locator('.bk-node').evaluateAll((els) => els.map((e) => ({ id: e.dataset.id, x: e.offsetLeft, y: e.offsetTop })));
          const at = new Map(boxes.map((b) => [b.id, b]));
          const order = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8', 'n9', 'n10', 'n11'].map((id) => at.get(id));
          const rows = new Set(order.map((b) => b.y)).size;
          const bad = order.slice(1).find((b, i) => !((b.y === order[i].y && b.x > order[i].x) || (b.y > order[i].y && b.x === order[0].x)));
          if (bad || rows < 2) return { ok: false, why: `折り返し: 段 ${rows}、読む順に逆らうブロック ${bad?.id ?? 'なし'}` };
        }
        const code = await page.locator('#code').innerText();
        const saved = (await api('/api/blocks/direction')).direction;
        if (!same(got.lines, FIZZ) || code !== code0 || saved !== dir) return { ok: false, why: `${dir}: 出た ${got.lines.join(',')}、JavaScript ${code === code0 ? '同じ' : '違う'}、覚えた向き ${saved}` };
        seen.push(dir);
      }
      // 前の名前（diag）で覚えた人の設定は、折り返しとして読む
      await api('/api/blocks/direction', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ direction: 'diag' }) });
      const migrated = (await api('/api/blocks/direction')).direction;
      await api('/api/blocks/direction', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ direction: 'ltr' }) });
      if (migrated !== 'wrap') return { ok: false, why: `diag を覚えさせると ${migrated} が返った（wrap のはず）` };
      return { ok: true, why: `${seen.join('・')} で同じ結果・同じ JavaScript。向きは設定に覚えた。折り返しは読む順に並んだ。diag は wrap として読んだ` };
    },
  },
  {
    id: 'blocks-save-reopen',
    what: '保存して、新しくで空にし、開くで読み直して動かすと同じ結果',
    async run() {
      await page.click('#saveOne');
      await page.fill('#askInput', 'fizz');
      await page.click('#askOk');
      await page.waitForFunction(() => /保存しました/.test(document.getElementById('note')?.textContent ?? ''), null, { timeout: 15_000 });
      if (!existsSync(join(work, 'fizz.blocks.json'))) return { ok: false, why: '作業場に fizz.blocks.json が出来ていません' };
      await page.click('#newOne');
      if (await page.locator('.bk-node').count() !== 0) return { ok: false, why: '新しくで空になりません' };
      await page.click('#openOne');
      await page.locator('#askList button', { hasText: 'fizz.blocks.json' }).click();
      await page.waitForFunction(() => /開きました/.test(document.getElementById('note')?.textContent ?? ''), null, { timeout: 15_000 });
      const got = await runAndRead();
      const saved = JSON.parse(readFileSync(join(work, 'fizz.blocks.json'), 'utf8'));
      return same(got.lines, FIZZ) ? { ok: true, why: `ブロック ${saved.nodes.length} 個・線 ${saved.links.length} 本を読み直して同じ結果` } : { ok: false, why: `出た: ${got.lines.join(',')}` };
    },
  },
  {
    id: 'blocks-undo-redo',
    what: '消したブロックを ↶ で戻し、↷ でまた消せる',
    async run() {
      await page.locator(`${node('n11')} .bk-x`).click();
      const gone = await page.locator(node('n11')).count();
      await page.click('#undo');
      const back = await page.locator(node('n11')).count();
      await page.click('#redo');
      const again = await page.locator(node('n11')).count();
      await page.click('#undo');
      return gone === 0 && back === 1 && again === 0 ? { ok: true, why: '消す→戻す→やり直す が効いた' } : { ok: false, why: `消した ${gone}・戻した ${back}・やり直した ${again}` };
    },
  },
  {
    id: 'flow-umbrella-by-hand',
    what: '手順の形で「明日の天気を取って、雨なら『傘を持って』、そうでなければ『傘はいらない』」を押して組み、動かすと予報どおりに出る',
    async run() {
      await page.click('#newOne');
      await page.click('#viewFlow');
      const menuPick = async (text) => page.locator('.bk-menu button', { hasText: text }).first().click();
      await page.click('#addStep'); await menuPick('天気を取る');
      await page.click('#addStep'); await menuPick('条件');
      await page.locator('[data-step="s2"] [data-field="cond"] button', { hasText: '前の出力' }).click();
      await menuPick('天気を取るの雨か');
      await page.locator('[data-step="s2"] [data-branch="yes"] > .bk-add').click(); await menuPick('表示');
      await typeIn('[data-step="s3"] [data-field="value"] input', '傘を持って');
      await page.locator('[data-step="s2"] [data-branch="no"] > .bk-add').click(); await menuPick('表示');
      await typeIn('[data-step="s4"] [data-field="value"] input', '傘はいらない');
      const got = await runAndRead();
      await shot('flow-umbrella.png');
      const truth = await liveTruth({ type: 'weather-matches-open-meteo', place: '東京' }, '東京');
      if (!truth.weather) return { ok: false, why: `Open-Meteo から答え合わせの予報を取れませんでした（画面の結果: ${got.lines.join(',')}）` };
      const rain = ['雨', '雪'].includes(weatherGroup(truth.weather.code));
      const want = rain ? '傘を持って' : '傘はいらない';
      return same(got.lines, [want]) ? { ok: true, why: `予報は ${weatherGroup(truth.weather.code)}（code ${truth.weather.code}）、出た: ${got.lines.join(',')}` }
        : { ok: false, why: `予報は ${weatherGroup(truth.weather.code)}（code ${truth.weather.code}）なので「${want}」のはず。出た: ${got.lines.join(',')}（${got.state}）` };
    },
  },
  {
    id: 'text-fizzbuzz-by-hand',
    what: '文章の形で、空から「1 から 15 まで数えて、その数が 15 で割り切れたら FizzBuzz…」を押して組み、行の横の結果と ▶ 動かす の結果が 1〜15 の FizzBuzz になる',
    async run() {
      await page.click('#newOne');
      await page.click('#viewText');
      const menuPick = async (text) => page.locator('.bk-menu button', { hasText: text }).first().click();
      const addIn = async (id, branch, text) => { await page.locator(`[data-add-in="${id}"][data-branch="${branch}"]`).click(); await menuPick(text); };
      const slotIn = (id, name) => `#text [data-step="${id}"] [data-slot="${name}"]`;
      let clicks = 2;
      await page.click('#addLine'); await menuPick('くり返す'); clicks += 2;
      await typeIn(slotIn('s1', 'to'), 15); clicks += 1;
      await addIn('s1', 'body', '割り切れたら'); clicks += 2;
      await typeIn(slotIn('s2', 'b'), 15); clicks += 1;
      await addIn('s2', 'yes', '表示'); await typeIn(slotIn('s3', 'value'), 'FizzBuzz'); clicks += 3;
      await addIn('s2', 'no', '割り切れたら'); clicks += 2; // B は 3 のまま
      await addIn('s4', 'yes', '表示'); await typeIn(slotIn('s5', 'value'), 'Fizz'); clicks += 3;
      await addIn('s4', 'no', '割り切れたら'); await typeIn(slotIn('s6', 'b'), 5); clicks += 3;
      await addIn('s6', 'yes', '表示'); await typeIn(slotIn('s7', 'value'), 'Buzz'); clicks += 3;
      await addIn('s6', 'no', '表示'); clicks += 2;
      await page.locator('#text [data-step="s8"] [data-pick="value"]').click(); await menuPick('その数'); clicks += 2;
      // 変えるとすぐ動かし直す。行の横に結果が出るのを待つ
      await page.waitForFunction(() => /はい 1 回/.test(document.querySelector('#text [data-step="s2"] .bk-live')?.textContent ?? ''), null, { timeout: 15_000 });
      const live = await page.locator('#text [data-step="s2"] .bk-live').innerText();
      await page.waitForTimeout(500);
      const got = await runAndRead();
      await shot('text-fizzbuzz.png');
      const sentence = await page.locator('#text [data-step="s2"] .bk-sentence').innerText();
      const ok = same(got.lines, FIZZ) && /もし/.test(sentence) && /割り切れる/.test(sentence);
      return { ok, why: `出た: ${got.lines.join(',')}（${got.state}）。s2 の文「${sentence.replace(/\s+/g, ' ')}」、横の結果「${live}」。押した数 ${clicks}` };
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
  const { chromium } = await import('playwright-core');
  const exe = process.env.AAS_CHECK_BROWSER || findAppBrowser(process.platform, process.env, existsSync);
  browser = await chromium.launch(exe ? { executablePath: exe } : {});
  // FizzBuzz の 11 個が重ならずに並ぶ広さ。写しは細かく（deviceScaleFactor 2）
  page = await browser.newPage({ viewport: { width: 2500, height: 1150 }, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => say(`画面の中で落ちました: ${e.message}`));
  // 会話の画面の ▦ から入る（利用者と同じ入口）
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.locator('#openBlocks').click();
  await page.waitForURL(/blocks\.html/);
  await page.locator('.bk-pal-item').first().waitFor({ state: 'visible', timeout: 30_000 });
  say(`ブロックでつくる画面を開きました。作業場: ${work}`);
  for (const c of CHECKS) {
    const t0 = Date.now();
    let verdict;
    try { verdict = await c.run(); } catch (e) { verdict = { ok: false, why: `確かめの途中で落ちました: ${e.message.split('\n')[0]}` }; }
    if (!verdict.ok) { failed += 1; await shot(`fail-${c.id}.png`); }
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
