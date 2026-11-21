/**
 * 大きいモデルの確かめ（docs/knowledge/large-models-2026-11-15.md）。入れた形（配る形）の本体を、
 * 「メモリがモデルより小さい機械」として起こし、画面で計画を見て、そのモデルを選び、頼んで、答えを見る。
 *
 *   node scripts/check-large.mjs --start "<起こす命令>" --port <口> --model-file <.gguf の場所> [--shots <dir>] [--out <json>]
 *
 * メモリは、試験の口（AAS_TEST_RAM_BYTES）でモデルの 6 割に見せる。本物のメモリは変わらないので、モデルは実際には読める。
 * 見るのは「大きすぎます」で断らず、SSD から読む計画を見せ、その計画で読んで答えること。ページングの空きは 64GB、
 * ディスクの空きは 18GB に見せる（22GB のモデルが「入らない」と出て、理由と動かす手が出ることも見る）。
 * 確かめは足すだけ。一度載せた id（checks/large.ids）は消さない・飛ばさない（test/large-checks.test.ts が止める）。
 * 1 行ずつ「== PASS <id>: …」「== FAIL <id>: …」を出し、最後に「== 結果: n/m」。1 つでも落ちたら 1 で終わる。
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { findAppBrowser } from '../src/core/app-window.ts';

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const start = opt('--start');
const port = Number(opt('--port') ?? 4178);
const modelFile = opt('--model-file');
const shots = opt('--shots');
const out = opt('--out');
const work = resolve(opt('--work') ?? join(tmpdir(), `aas-large-check-${Date.now()}`));
if (!start || !modelFile || !existsSync(modelFile)) {
  console.error('使い方: node scripts/check-large.mjs --start "<起こす命令>" --port <口> --model-file <.gguf の場所> [--shots <dir>] [--out <json>]');
  process.exit(2);
}
mkdirSync(work, { recursive: true });
if (shots) mkdirSync(shots, { recursive: true });

const GIB = 1024 ** 3;
const ref = basename(modelFile);
const modelBytes = statSync(modelFile).size;
const shownRam = Math.floor(modelBytes * 0.6);
const ASK = '1234 × 5678 は?';
const ANSWER = '7006652';
const FOLLOW = 'その答えに 1 を足すと?';
const FOLLOW_ANSWER = '7006653';
const FITS = ['快適', '動く（遅い）', 'SSD から読む（とても遅い）', '入らない'];
const say = (s) => console.log(`[${new Date().toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo' })}] ${s}`);
const api = (p, init) => fetch(`http://127.0.0.1:${port}${p}`, { signal: AbortSignal.timeout(60_000), ...init }).then((r) => r.json()).catch(() => ({}));

const app = spawn(start, {
  shell: true, stdio: 'inherit', detached: process.platform !== 'win32',
  env: {
    ...process.env, AAS_UI_PORT: String(port), AAS_UI_NO_OPEN: '1',
    AAS_TEST_RAM_BYTES: String(shownRam), AAS_TEST_PAGING_BYTES: String(64 * GIB), AAS_TEST_DISK_BYTES: String(18 * GIB),
  },
});
function stopAll() {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/T', '/F', '/PID', String(app.pid)], { stdio: 'ignore' });
    else process.kill(-app.pid, 'SIGTERM');
  } catch { /* 終わっている */ }
}

let page;
/** 本体の記録。途中で流れて消えないよう、確かめの間ずっと集める。 */
const logs = [];
let logSeq = 0;
async function pullLogs() {
  const got = await api(`/api/logs?after=${logSeq}`);
  for (const l of got.lines ?? []) { logs.push(String(l.text ?? '')); logSeq = Math.max(logSeq, l.seq ?? 0); }
}
async function shot(name) {
  if (shots) await page.screenshot({ path: join(shots, name) }).catch(() => undefined);
}
async function openModelSettings() {
  if (!(await page.locator('#cfgGguf').isVisible().catch(() => false))) {
    await page.click('#openSettings');
    await page.click('#settings .tabs-lite button[data-sec="model"]');
  }
  await page.locator('#cfgGguf .row').first().waitFor({ state: 'visible', timeout: 60_000 });
}
/** 送って、手が空くまで待ち、その会話の最後の答えを返す。 */
async function ask(text, minutes, fresh) {
  if (fresh) {
    await api('/api/conversations', { method: 'POST' });
    await page.reload({ waitUntil: 'domcontentloaded' });
  }
  const box = page.locator('.chat textarea').first();
  await box.waitFor({ state: 'visible', timeout: 60_000 });
  await box.fill(text);
  await page.getByText('送る', { exact: true }).click();
  const until = Date.now() + minutes * 60_000;
  await page.waitForTimeout(3000);
  for (;;) {
    await pullLogs();
    const s = await api('/api/approvals');
    if (s.busy === false && !s.planning) break;
    if (Date.now() > until) break;
    await page.waitForTimeout(3000);
  }
  await pullLogs();
  const list = await api('/api/conversations');
  const id = list.current ?? list.list?.[0]?.id;
  const msgs = id ? (await api(`/api/conversations/messages?id=${encodeURIComponent(id)}`)).messages ?? [] : [];
  const last = [...msgs].reverse().find((m) => m.role === 'assistant' && String(m.content ?? '').trim());
  return String(last?.content ?? '');
}
const digits = (s) => s.replace(/[,，\s]/g, '');
/** 記録の「最初の 1 トークンまで N 秒」を、出た順に。 */
const firstTokenSeconds = () => logs.flatMap((l) => { const m = /最初の 1 トークンまで ([\d.]+) 秒/.exec(l); return m ? [Number(m[1])] : []; });

const measured = { ref, modelBytes, shownRamBytes: shownRam };
let turnOneFirsts = 0;

/* ---------- 確かめの一覧（足すだけ） ---------- */
const CHECKS = [
  {
    id: 'large-picker-shows-plan',
    what: '設定 → モデル の一覧で、メモリより大きいモデルに「SSD から読む（とても遅い）」と、どう置くかの一行が、選ぶ前に出る',
    async run() {
      await openModelSettings();
      const row = page.locator('#cfgGguf .row', { hasText: ref }).first();
      const rowText = await row.innerText();
      const note = await page.locator('#cfgGguf .note', { hasText: 'この PC では:' }).first().innerText().catch(() => '');
      await shot('large-picker.png');
      const ok = rowText.includes('SSD から読む（とても遅い）') && !rowText.includes('載りません')
        && /この PC では: .*SSD から読みます。目安 [\d.]+ tok\/s/.test(note);
      measured.planLine = note;
      return { ok, why: `行: ${rowText.replace(/\s+/g, ' ').slice(0, 120)} ／ 計画: ${note}` };
    },
  },
  {
    id: 'large-plan-detail',
    what: '「計画を見る」を開くと、GPU・メモリ・SSD から読む分・コンテキストウィンドウ・待つ上限が出る',
    async run() {
      await openModelSettings();
      const more = page.locator('#cfgGguf details.placement-detail').first();
      await more.locator('summary').click();
      const text = await more.innerText();
      await shot('large-plan-detail.png');
      const need = ['計画を見る', 'GPU: ', 'メモリ: ', 'SSD から読む分: ', 'コンテキストウィンドウ: ', '速さの目安: ', '待つ上限: 読み込み '];
      const missing = need.filter((n) => !text.includes(n));
      const ok = missing.length === 0 && !/SSD から読む分: なし/.test(text);
      return { ok, why: missing.length ? `無い行: ${missing.join(' / ')}` : text.replace(/\s+/g, ' ').slice(0, 200) };
    },
  },
  {
    id: 'large-catalog-fit-labels',
    what: '取ってくる一覧のどのモデルにも、この PC での具合（快適・動く（遅い）・SSD から読む（とても遅い）・入らない）が、取ってくる前に出る。入らないものには理由と動かす手が出る',
    async run() {
      await openModelSettings();
      const options = await page.locator('#cfgCatalog option').allInnerTexts();
      const unlabeled = options.filter((o) => !FITS.some((f) => o.includes(`この PC では ${f}`)));
      const models = await api('/api/models');
      const no = (models.catalog ?? []).filter((m) => m.possible === false);
      const explained = no.every((m) => /入りません（.+）。動かすには: /.test(m.plan ?? ''));
      const big = (models.catalog ?? []).filter((m) => m.approxGB >= 15).map((m) => `${m.id}=${m.fitLabel}`);
      const ok = options.length >= 6 && unlabeled.length === 0 && no.length >= 1 && explained && big.length >= 3;
      return { ok, why: `一覧 ${options.length} 件（具合の無いもの ${unlabeled.length} 件）。大きいもの: ${big.join('、')}。入らない ${no.length} 件: ${(no[0]?.plan ?? '').slice(0, 90)}` };
    },
  },
  {
    id: 'large-not-refused-and-answers',
    what: `メモリより大きいモデルを「これを使う」で選び、「${ASK}」を送ると、「大きすぎます」で断らずに読んで、答え（${ANSWER} を含む）が出る`,
    async run() {
      await openModelSettings();
      const row = page.locator('#cfgGguf .row', { hasText: ref }).first();
      const use = row.getByRole('button').last();
      if (await use.isEnabled()) await use.click();
      await page.waitForFunction((r) => [...document.querySelectorAll('#cfgGguf .row')].some((x) => x.textContent.includes(r) && x.textContent.includes('いまこれ')), ref, { timeout: 30_000 });
      await page.keyboard.press('Escape');
      const t0 = Date.now();
      const answer = await ask(ASK, 60, true);
      measured.firstTurnSeconds = Math.round((Date.now() - t0) / 1000);
      turnOneFirsts = firstTokenSeconds().length;
      await shot('large-answer.png');
      const refused = logs.some((l) => l.includes('大きすぎます'));
      const ok = digits(answer).includes(ANSWER) && !refused;
      return { ok, why: `答え: ${answer.replace(/\s+/g, ' ').slice(0, 120)}${refused ? '（記録に「大きすぎます」があります）' : ''}（${measured.firstTurnSeconds} 秒）` };
    },
  },
  {
    id: 'large-log-plan-progress-speed',
    what: '本体の記録に、配置の計画（SSD から読む）・読み込みの進み具合（100% まで）・速さ（tok/s）が残る',
    async run() {
      await pullLogs();
      const plan = logs.find((l) => l.includes('配置の計画（SSD から読む（とても遅い））')) ?? '';
      const done = logs.some((l) => l.includes(`読み込み中 100%: ${ref}`));
      const loaded = logs.map((l) => /読み込みました: .+（([\d.]+) 秒）/.exec(l)).find(Boolean);
      const speed = logs.filter((l) => l.startsWith('答えました: ')).at(-1) ?? '';
      const tps = /出力 (\d+) トークン（[\d.]+ 秒・([\d.]+) tok\/s）/.exec(speed);
      measured.loadSeconds = loaded ? Number(loaded[1]) : undefined;
      measured.outputTokens = tps ? Number(tps[1]) : undefined;
      measured.tokensPerSecond = tps ? Number(tps[2]) : undefined;
      measured.speedLine = speed;
      const ok = Boolean(plan) && done && Boolean(loaded) && Boolean(tps);
      return { ok, why: `計画: ${plan.slice(0, 110) || '（無い）'} ／ 100%: ${done ? '在る' : '無い'} ／ 読み込み ${measured.loadSeconds ?? '?'} 秒 ／ ${speed.slice(0, 110) || '（速さの行が無い）'}` };
    },
  },
  {
    id: 'large-followup-reads-only-new',
    what: `続けて「${FOLLOW}」を送ると、前の会話を覚えたまま答え（${FOLLOW_ANSWER} を含む）、読むのは新しい分だけなので、最初の 1 トークンまでが 1 回目より短い`,
    async run() {
      const before = firstTokenSeconds();
      const t0 = Date.now();
      const answer = await ask(FOLLOW, 60, false);
      measured.followTurnSeconds = Math.round((Date.now() - t0) / 1000);
      const all = firstTokenSeconds();
      // 1 回目のいちばん長い待ち（会話の頭から全部読んだ回）と、2 回目のいちばん長い待ちを比べる
      const first = Math.max(...before.slice(0, turnOneFirsts || before.length), 0);
      const second = Math.max(...all.slice(before.length), 0);
      measured.firstTokenFirstTurn = first;
      measured.firstTokenFollowTurn = second;
      await shot('large-followup.png');
      const ok = digits(answer).includes(FOLLOW_ANSWER) && all.length > before.length && second < first;
      return { ok, why: `答え: ${answer.replace(/\s+/g, ' ').slice(0, 100)} ／ 最初の 1 トークンまで: 1 回目 ${first} 秒、2 回目 ${second} 秒` };
    },
  },
];

const results = [];
let browser;
let failed = 0;
try {
  say(`起こします: ${start}（${ref} ${(modelBytes / GIB).toFixed(1)}GB を、メモリ ${(shownRam / GIB).toFixed(1)}GB の機械として）`);
  for (let i = 0; ; i += 1) {
    if ((await api('/api/info')).pid) break;
    if (i > 120) throw new Error('本体が 120 秒たっても立ち上がりませんでした');
    await new Promise((r) => setTimeout(r, 1000));
  }
  await api('/api/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workRoot: work }) });
  const { chromium } = await import('playwright-core');
  const exe = process.env.AAS_CHECK_BROWSER || findAppBrowser(process.platform, process.env, existsSync);
  browser = await chromium.launch(exe ? { executablePath: exe } : {});
  page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('pageerror', (e) => say(`画面の中で落ちました: ${e.message}`));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.locator('#openSettings').waitFor({ state: 'visible', timeout: 30_000 });
  for (const c of CHECKS) {
    const t0 = Date.now();
    let verdict;
    try { verdict = await c.run(); } catch (e) { verdict = { ok: false, why: `確かめの途中で落ちました: ${e.message.split('\n')[0]}` }; }
    if (!verdict.ok) { failed += 1; await shot(`fail-${c.id}.png`); }
    results.push({ id: c.id, ok: verdict.ok, why: verdict.why, seconds: Math.round((Date.now() - t0) / 1000) });
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
console.log(`== 測った値: ${JSON.stringify(measured)}`);
console.log(`== 結果: ${results.filter((r) => r.ok).length}/${CHECKS.length}`);
if (out) writeFileSync(out, JSON.stringify({ measured, results }, null, 2));
process.exit(failed > 0 ? 1 : 0);
