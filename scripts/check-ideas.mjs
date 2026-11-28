/**
 * アイデアの拡張機能（docs/IDEAS.md）と、拡張機能の入れ物（docs/EXTENSIONS.md）の確かめ。入れた形（配る形）の本体を、
 * モデルを 1 つも置かずに起こし、画面でパネル「アイデア」を出して押して、出た札を見る。
 *
 *   node scripts/check-ideas.mjs --start "<起こす命令>" --port <口> [--shots <dir>] [--out <json>] [--work <dir>]
 *
 * モデルの保存先（LLM_HOME）は、作業用の空のフォルダに向ける（モデルが無い状態で札が出るのを見る）。知識を取りに行くのも止める
 * （AAS_KNOWLEDGE_FETCH=0）。札は語の掛け合わせで作るので、どちらも要らない。ネットワークを OS の側で切ることはしていない
 * （ネットワークを呼ばないことは、test/ideas.test.ts が fetch を投げる物に替えて見る）。
 * 始める前に、本体のデータの下のアイデアの蔵と、拡張機能の入り切りを消す（前の回の語と重みで、結果が変わらないように）。
 * 途中で本体を 2 回起こし直す（残した札と語の重み、筋が、起こし直しても残るのを見る）。
 * 確かめは足すだけ。一度載せた id（checks/ideas.ids）は消さない・飛ばさない（test/ideas-checks.test.ts が止める）。
 * 1 行ずつ「== PASS <id>: …」「== FAIL <id>: …」を出し、最後に「== 結果: n/m」。1 つでも落ちたら 1 で終わる。
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { findAppBrowser } from '../src/core/app-window.ts';

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const start = opt('--start');
const port = Number(opt('--port') ?? 4179);
const shots = opt('--shots');
const out = opt('--out');
const work = resolve(opt('--work') ?? join(tmpdir(), `aas-ideas-check-${Date.now()}`));
if (!start) {
  console.error('使い方: node scripts/check-ideas.mjs --start "<起こす命令>" --port <口> [--shots <dir>] [--out <json>] [--work <dir>]');
  process.exit(2);
}
// 作業場のフォルダの名前は、自動で採るテーマの語になる。決まった名前にして、回によって語が変わらないようにする
const workRoot = join(work, 'yoyaku-app');
const emptyModels = join(work, 'llm');
mkdirSync(workRoot, { recursive: true });
mkdirSync(emptyModels, { recursive: true });
if (shots) mkdirSync(shots, { recursive: true });

const WORD = '棚卸し';
const THOUGHT = '通知が多すぎて読まれない';
const THOUGHT_WORD = '通知';
const say = (s) => console.log(`[${new Date().toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo' })}] ${s}`);
const call = async (p, init) => {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { signal: AbortSignal.timeout(30_000), ...init }).catch(() => undefined);
  if (!r) return { status: 0, body: {} };
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const api = async (p, init) => (await call(p, init)).body;
const post = (p, data) => call(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data ?? {}) });

let app;
let page;
let stateDir = '';
let configFile = '';
/** 確かめの前に、設定の runtime.autoFetch に書いてあった値（書いてなければ undefined）。終わったら戻す。 */
let autoFetchBefore;
let autoFetchRead = false;
/** 設定のファイルの runtime.autoFetch を書き換える（undefined なら消す）。ほかの設定は、そのまま残す。 */
function setAutoFetch(value) {
  if (!configFile) return;
  const config = existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8').replace(/^\uFEFF/, '')) : {};
  if (!autoFetchRead) { autoFetchBefore = config.runtime?.autoFetch; autoFetchRead = true; }
  const runtime = { ...(config.runtime ?? {}) };
  if (value === undefined) delete runtime.autoFetch; else runtime.autoFetch = value;
  if (Object.keys(runtime).length > 0) config.runtime = runtime; else delete config.runtime;
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
}
const measured = {};
/** 本体を起こす。モデルの保存先は空のフォルダ、知識を取りに行くのは止める。立ち上がるまで待つ。 */
async function startApp() {
  app = spawn(start, {
    shell: true, stdio: 'inherit', detached: process.platform !== 'win32',
    env: { ...process.env, AAS_UI_PORT: String(port), AAS_UI_NO_OPEN: '1', LLM_HOME: emptyModels, AAS_KNOWLEDGE_FETCH: '0' },
  });
  for (let i = 0; ; i += 1) {
    if ((await api('/api/info')).pid) break;
    if (i > 120) throw new Error('本体が 120 秒たっても立ち上がりませんでした');
    await new Promise((r) => setTimeout(r, 1000));
  }
}
function stopAll() {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/T', '/F', '/PID', String(app.pid)], { stdio: 'ignore' });
    else process.kill(-app.pid, 'SIGTERM');
  } catch { /* 終わっている */ }
}
async function restartApp() {
  await fetch(`http://127.0.0.1:${port}/api/quit`, { method: 'POST' }).catch(() => undefined);
  for (let i = 0; i < 60; i += 1) {
    if (!(await api('/api/info')).pid) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  stopAll();
  await new Promise((r) => setTimeout(r, 2000));
  await startApp();
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await settle();
}
/**
 * 画面を開いたあと、上の帯（モデルが無いときの「まだ話せません」と、取ってくるボタン）が出るまで待つ。
 * 帯は遅れて出て、下の画面を押し下げる。出る前に押すと、押す先がずれて、帯のボタン（モデルを取ってくる）を押してしまう。
 */
async function settle() {
  await page.locator('#openSettings').waitFor({ state: 'visible', timeout: 30_000 });
  await page.locator('#crashNote').waitFor({ state: 'visible', timeout: 30_000 }).catch(() => undefined);
}
/** モデルの保存先に在るファイルの数（取りかけも数える）。 */
function modelFiles(dir = emptyModels) {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) n += e.isDirectory() ? modelFiles(join(dir, e.name)) : 1;
  return n;
}
async function shot(name) {
  if (shots) await page.screenshot({ path: join(shots, name) }).catch(() => undefined);
}

const panel = () => page.locator('.ideas').first();
const topCards = () => page.locator('.ideas-board > .idea-card');
const stateText = async () => (await page.locator('.ideas-state').first().innerText()).trim();
const texts = async () => (await page.locator('.ideas-board > .idea-card > .idea-text').allInnerTexts()).map((t) => t.trim());
const chips = async () => page.locator('.idea-chip').evaluateAll((els) => els.map((e) => e.dataset.term));
/** 状態の行が、その文字を含むまで待つ（押した結果は、状態の行に出る）。 */
const waitState = (part) => page.waitForFunction((p) => (document.querySelector('.ideas-state')?.textContent ?? '').includes(p), part, { timeout: 20_000 });

/** 表示の一覧を開く。画面は、読み込みの終わりにボタンを繋ぐので、開くまで押し直す。 */
async function openViewList() {
  for (let i = 0; i < 40; i += 1) {
    await page.click('#openView');
    if (await page.locator('#viewMenu[open] #viewList .view-row').count() > 0) return;
    await page.waitForTimeout(500);
  }
  throw new Error('表示の一覧が開きませんでした');
}
/** 表示の一覧で、パネル「アイデア」を出す（出ていれば何もしない）。一覧に「アイデア」が在ったかを返す。 */
async function openIdeasPanel() {
  if (await panel().isVisible().catch(() => false)) return true;
  await openViewList();
  const row = page.locator('#viewList .view-row[data-kind="ideas"]');
  const listed = await row.count() > 0;
  if (listed) await row.locator('input').check();
  await page.keyboard.press('Escape');
  if (listed) await panel().waitFor({ state: 'visible', timeout: 15_000 });
  return listed;
}
async function openExtensionSettings() {
  if (!(await page.locator('#extList').isVisible().catch(() => false))) {
    await page.click('#openSettings');
    await page.click('#settings .tabs-lite button[data-sec="ext"]');
  }
  await page.locator('#ext-ideas').waitFor({ state: 'visible', timeout: 15_000 });
}

/* ---------- 確かめの一覧（足すだけ） ---------- */
const CHECKS = [
  {
    id: 'ideas-opens-with-cards-no-model',
    what: 'モデルを 1 つも置いていない本体で、表示の一覧からパネル「アイデア」を出すと、開いただけで札が 3 枚以上並び、作業場の名前から採った語がテーマに出る',
    async run() {
      const cfg = await api('/api/config');
      const models = (cfg.gguf ?? []).length;
      const listed = await openIdeasPanel();
      await topCards().first().waitFor({ state: 'visible', timeout: 20_000 });
      const got = await texts();
      const themes = await chips();
      const polish = (await post('/api/ideas/polish', { ids: ['c1'] })).body;
      measured.firstCards = got;
      await shot('ideas-open.png');
      const ok = listed && models === 0 && got.length >= 3 && got.length <= 5 && got.every((t) => t.length > 8)
        && themes.includes('yoyaku') && typeof polish.skipped === 'string' && polish.skipped.length > 0;
      return { ok, why: `置いてあるモデル ${models} 個 ／ 札 ${got.length} 枚（1 枚目: ${got[0] ?? '（無い）'}）／ テーマの語: ${themes.join('・')} ／ 磨き: ${polish.skipped ?? '（断りが無い）'}` };
    },
  },
  {
    id: 'ideas-same-seed-same-cards',
    what: '種を固定して札を 2 回出すと、同じ札が出る。種を変えると、違う札が出る',
    async run() {
      const a = (await post('/api/ideas/receive', { seed: 20261128 })).body.cards ?? [];
      const b = (await post('/api/ideas/receive', { seed: 20261128 })).body.cards ?? [];
      const c = (await post('/api/ideas/receive', { seed: 20261129 })).body.cards ?? [];
      const line = (cards) => cards.map((x) => x.original).join(' ｜ ');
      const ok = a.length >= 3 && line(a) === line(b) && line(a) !== line(c);
      return { ok, why: `同じ種: ${line(a) === line(b) ? '同じ' : '違う'}（${a.length} 枚。1 枚目: ${a[0]?.original ?? '（無い）'}）／ 別の種: ${line(a) !== line(c) ? '違う' : '同じ'}` };
    },
  },
  {
    id: 'ideas-add-word-appears',
    what: `語（${WORD}）を足すと、テーマにその語が並び、出し直した札にその語が入る`,
    async run() {
      await page.fill('.ideas-add-input', WORD);
      await page.click('.ideas-add');
      await waitState(`「${WORD}」を足しました`);
      const themes = await chips();
      const got = await texts();
      const withWord = got.filter((t) => t.includes(WORD));
      await shot('ideas-added.png');
      return { ok: themes.includes(WORD) && withWord.length >= 1, why: `テーマの語: ${themes.join('・')} ／ ${WORD} の入った札 ${withWord.length}/${got.length} 枚（${withWord[0] ?? '（無い）'}）` };
    },
  },
  {
    id: 'ideas-remove-word-and-undo',
    what: `語（${WORD}）の × を押すと、テーマから消えて、その語の札が出なくなる。「取り消す」を押すと、語と前の札が戻る`,
    async run() {
      const before = await texts();
      await page.click(`.idea-chip[data-term="${WORD}"] .idea-chip-x`);
      await waitState(`「${WORD}」を外しました`);
      const gone = await chips();
      const after = await texts();
      // 外したあと、種を変えて 5 回出しても、その語の札は出ない
      let leaked = 0;
      for (let seed = 1; seed <= 5; seed += 1) {
        const cards = (await post('/api/ideas/receive', { seed })).body.cards ?? [];
        leaked += cards.filter((c) => c.original.includes(WORD)).length;
      }
      await page.click('.ideas-undo');
      await waitState(`「${WORD}」を戻しました`);
      const back = await chips();
      const restored = await texts();
      const ok = !gone.includes(WORD) && after.every((t) => !t.includes(WORD)) && leaked === 0
        && back.includes(WORD) && restored.join('｜') === before.join('｜') && restored.some((t) => t.includes(WORD));
      return { ok, why: `外したあと: テーマに${gone.includes(WORD) ? '在る' : '無い'}・並んだ札に ${after.filter((t) => t.includes(WORD)).length} 枚・出し直した 5 回に ${leaked} 枚 ／ 取り消したあと: テーマに${back.includes(WORD) ? '在る' : '無い'}・前の札に${restored.join('｜') === before.join('｜') ? '戻った' : '戻っていない'}` };
    },
  },
  {
    id: 'ideas-more-grows-branch',
    what: '札の「もっと」を押すと、その札の下に、違う文の札が 1 枚伸びる',
    async run() {
      const first = topCards().first();
      const parent = (await first.locator(':scope > .idea-text').innerText()).trim();
      await first.locator(':scope > .idea-acts .idea-more').click();
      await first.locator(':scope > .idea-card.branch').first().waitFor({ state: 'visible', timeout: 15_000 });
      const child = (await first.locator(':scope > .idea-card.branch > .idea-text').first().innerText()).trim();
      const label = (await first.locator(':scope > .idea-card.branch .idea-from').first().innerText()).trim();
      await shot('ideas-more.png');
      return { ok: child.length > 8 && child !== parent && label.includes('もっと'), why: `元: ${parent} ／ 伸びた札: ${child}（${label}）` };
    },
  },
  {
    id: 'ideas-why-shows-source',
    what: '仕組みの札の「なぜ」を押すと、元の仕組みの文と、出典（ウィキペディアの URL）と、ライセンス（CC BY-SA 4.0）が出る',
    async run() {
      const card = page.locator('.ideas-board > .idea-card[data-template="mechanism_transfer"]').first();
      await card.waitFor({ state: 'visible', timeout: 15_000 });
      const text = (await card.locator(':scope > .idea-text').innerText()).trim();
      await card.locator(':scope > .idea-acts .idea-why').click();
      const box = card.locator(':scope > .idea-why-box');
      await box.waitFor({ state: 'visible', timeout: 10_000 });
      const how = (await box.locator('.idea-why-how').innerText()).trim();
      const href = await box.locator('.idea-why-source a').first().getAttribute('href');
      const source = (await box.locator('.idea-why-source').innerText()).trim();
      // 「元の仕組み（題）: 文。」の文が、札の文の頭にそのまま入っている
      const sentence = how.replace(/^元の仕組み（[^）]*）: /, '').replace(/。$/, '');
      await shot('ideas-why.png');
      const ok = how.startsWith('元の仕組み（') && sentence.length > 8 && text.includes(sentence)
        && /^https:\/\/ja\.wikipedia\.org\/wiki\//.test(href ?? '') && source.includes('CC BY-SA 4.0');
      return { ok, why: `${how.slice(0, 80)} ／ ${source} ／ 札の文に元の文が${text.includes(sentence) ? '入っている' : '入っていない'}` };
    },
  },
  {
    id: 'ideas-combine-two',
    what: '札を 2 枚選んで「組み合わせる」を押すと、1 枚目の材料の入った新しい札が、いちばん上に出る',
    async run() {
      const disabledBefore = await page.locator('.ideas-combine').isDisabled();
      const a = topCards().nth(0);
      const b = topCards().nth(1);
      const idA = await a.getAttribute('data-id');
      const idB = await b.getAttribute('data-id');
      const seen = await texts();
      await a.locator(':scope > .idea-head .idea-pick').check();
      await topCards().nth(1).locator(':scope > .idea-head .idea-pick').check();
      await page.locator('.ideas-combine').click();
      await waitState('2 枚を組み合わせた札');
      const top = topCards().first();
      const text = (await top.locator(':scope > .idea-text').innerText()).trim();
      const label = (await top.locator(':scope > .idea-head .idea-from').innerText()).trim();
      const known = (await post('/api/ideas/receive', { seed: 1 })).body; // テーマの語を読むだけ
      const material = (known.themes ?? []).map((t) => t.term).find((t) => text.includes(t));
      await shot('ideas-combine.png');
      const ok = disabledBefore && idA !== idB && !seen.includes(text) && label.includes('組み合わせた') && Boolean(material);
      return { ok, why: `選ぶ前のボタン: ${disabledBefore ? '押せない' : '押せる'} ／ 出た札: ${text}（${label}。材料: ${material ?? '（見つからない）'}）` };
    },
  },
  {
    id: 'ideas-ask-into-chat',
    what: '札の「依頼に入れる」を押すと、チャットの入力欄にその札の文が入る',
    async run() {
      const card = topCards().first();
      const text = (await card.locator(':scope > .idea-text').innerText()).trim();
      await card.locator(':scope > .idea-acts .idea-ask').click();
      await waitState('依頼に入れました');
      const value = await page.locator('.chat textarea').first().inputValue();
      await page.locator('.chat textarea').first().fill('');
      return { ok: value.includes(text), why: `入力欄: ${value.trim().slice(0, 80)}` };
    },
  },
  {
    id: 'ideas-star-raises-weight-and-survives-restart',
    what: '札の「☆ 残す」を押すと、その札の語の重みが 1 から 1.25 に上がり、本体を起こし直しても、残した札と語の重みが残っている',
    async run() {
      const card = topCards().first();
      const id = await card.getAttribute('data-id');
      const text = (await card.locator(':scope > .idea-text').innerText()).trim();
      await card.locator(':scope > .idea-acts .idea-star').click();
      await waitState('残しました');
      const said = await stateText();
      const pressed = await card.locator(':scope > .idea-acts .idea-star').getAttribute('aria-pressed');
      const file = join(stateDir, 'extensions', 'ideas', 'store.json');
      const stored = JSON.parse(readFileSync(file, 'utf8'));
      const grown = Object.values(stored.weights ?? {}).flatMap((terms) => Object.values(terms)).filter((w) => w === 1.25).length;
      await restartApp();
      const listed = await openIdeasPanel();
      await page.locator('.ideas-saved-toggle').click();
      await waitState('残した札: ');
      const saved = await texts();
      const status = await api('/api/ideas/stock_status');
      await shot('ideas-saved-after-restart.png');
      measured.savedAfterRestart = saved.length;
      const ok = pressed === 'true' && said.includes('1.25') && grown >= 1 && listed && saved.includes(text) && status.saved >= 1 && status.grown >= 1;
      return { ok, why: `${said.slice(0, 80)} ／ 蔵のファイルに 1.25 の語 ${grown} 個 ／ 起こし直したあと: 残した札 ${saved.length} 枚（押した札 ${id} が${saved.includes(text) ? '在る' : '無い'}）・重みの育った語 ${status.grown ?? '?'} 個` };
    },
  },
  {
    id: 'ideas-extension-off-and-on',
    what: '設定 → 拡張機能 で「アイデア」を切ると、パネルと表示の一覧の「アイデア」が消え、API は 404 を返す。入れ直すと、パネルが出て、残した札が戻っている',
    async run() {
      const before = (await api('/api/ideas/browse')).saved ?? [];
      await openExtensionSettings();
      await page.locator('#ext-ideas').uncheck();
      await page.waitForFunction(() => /切りました/.test(document.getElementById('extNote')?.textContent ?? ''), null, { timeout: 15_000 });
      await page.keyboard.press('Escape');
      const panelGone = await page.locator('.ideas').count() === 0;
      await openViewList();
      const rowGone = await page.locator('#viewList .view-row[data-kind="ideas"]').count() === 0;
      const rows = await page.locator('#viewList .view-row').count();
      await page.keyboard.press('Escape');
      const offBrowse = (await call('/api/ideas/browse')).status;
      const offReceive = (await post('/api/ideas/receive', { seed: 1 })).status;
      const kinds = (await api('/api/layout')).kinds ?? [];
      await shot('ideas-off.png');
      await openExtensionSettings();
      await page.locator('#ext-ideas').check();
      await page.waitForFunction(() => /入れました/.test(document.getElementById('extNote')?.textContent ?? ''), null, { timeout: 15_000 });
      await page.keyboard.press('Escape');
      await panel().waitFor({ state: 'visible', timeout: 15_000 });
      await topCards().first().waitFor({ state: 'visible', timeout: 20_000 });
      const after = (await api('/api/ideas/browse')).saved ?? [];
      await shot('ideas-on-again.png');
      const same = before.length >= 1 && after.map((c) => c.original).join('｜') === before.map((c) => c.original).join('｜');
      const ok = panelGone && rowGone && rows >= 5 && offBrowse === 404 && offReceive === 404 && !kinds.includes('ideas') && same;
      return { ok, why: `切ったあと: パネル${panelGone ? '無い' : '在る'}・一覧の行${rowGone ? '無い' : '在る'}（ほかの行 ${rows}）・browse ${offBrowse}・receive ${offReceive}・種類の一覧に${kinds.includes('ideas') ? '在る' : '無い'} ／ 入れ直したあと: パネルが出て、残した札 ${after.length} 枚（切る前と${same ? '同じ' : '違う'}）` };
    },
  },
  {
    id: 'ideas-never-fetches-model',
    what: 'ここまでの間、モデルを 1 度も取りに行っていない（モデルの保存先は空のまま、取ってくる仕事も無い）。それでも札は出る',
    async run() {
      const files = modelFiles();
      const jobs = ((await api('/api/jobs')).jobs ?? []).map((j) => `${j.title}（${j.state}）`);
      const gguf = ((await api('/api/config')).gguf ?? []).length;
      const cards = (await post('/api/ideas/receive', { seed: 3 })).body.cards ?? [];
      return { ok: files === 0 && jobs.length === 0 && gguf === 0 && cards.length >= 3, why: `保存先のファイル ${files} 個・裏の仕事 ${jobs.length} 件${jobs.length ? `（${jobs.join('、')}）` : ''}・置いてあるモデル ${gguf} 個・札 ${cards.length} 枚` };
    },
  },
  {
    id: 'ideas-plant-thought-spreads',
    what: `いちばん上の欄に思いつき（${THOUGHT}）を 1 行で置いて「広げる」を押すと、その思いつきの語（${THOUGHT_WORD}）で広げた札が並び、思いつきが筋の頭に出る`,
    async run() {
      await page.fill('.ideas-thought-input', THOUGHT);
      await page.click('.ideas-plant');
      await waitState('思いつきを置きました');
      const head = (await page.locator('.ideas-thread .ideas-thread-thought').innerText()).trim();
      const got = await texts();
      const grows = await page.locator('.ideas-board > .idea-card > .idea-acts .idea-grow').count();
      const left = await page.locator('.ideas-thought-input').inputValue();
      await shot('ideas-plant.png');
      const ok = head === THOUGHT && got.length >= 3 && got.every((t) => t.includes(THOUGHT_WORD)) && grows === got.length && left === '';
      return { ok, why: `筋の頭: ${head} ／ 札 ${got.length} 枚（${THOUGHT_WORD} の入った札 ${got.filter((t) => t.includes(THOUGHT_WORD)).length} 枚。1 枚目: ${got[0] ?? '（無い）'}）／「育てる」${grows} 個` };
    },
  },
  {
    id: 'ideas-grow-keeps-one-thread',
    what: '札の「育てる」を押すと、その札が筋に足され、次の札が出る。もう 1 度育てると、育てた順に 1 本の筋として並ぶ',
    async run() {
      const first = (await topCards().nth(1).locator(':scope > .idea-text').innerText()).trim();
      await topCards().nth(1).locator(':scope > .idea-acts .idea-grow').click();
      await waitState('筋に足しました（1 枚目）');
      const next = await texts();
      const second = next[0] ?? '';
      await topCards().nth(0).locator(':scope > .idea-acts .idea-grow').click();
      await waitState('筋に足しました（2 枚目）');
      const steps = (await page.locator('.ideas-thread .ideas-thread-step').allInnerTexts()).map((t) => t.trim());
      const after = await texts();
      measured.threadSteps = steps;
      await shot('ideas-grow.png');
      const ok = next.length === 3 && !next.includes(first) && steps.length === 2 && steps[0] === first && steps[1] === second && after.length === 3 && !after.includes(second);
      return { ok, why: `1 枚目に育てた札: ${first} ／ 次の札 ${next.length} 枚 ／ 筋: ${steps.map((t, i) => `${i + 1}. ${t}`).join(' → ')}` };
    },
  },
  {
    id: 'ideas-thread-reopen-and-ask',
    what: '筋を閉じて本体を起こし直しても、「筋の一覧」に筋が残っていて、「開く」で開き直すと続きの札が出る。「筋を依頼に入れる」で、思いつきと育てた札がチャットの入力欄に入る',
    async run() {
      const steps = measured.threadSteps ?? [];
      await page.click('.ideas-thread-close');
      await waitState('筋を閉じました');
      const closed = await page.locator('.ideas-thread').isHidden();
      await restartApp();
      await openIdeasPanel();
      await topCards().first().waitFor({ state: 'visible', timeout: 20_000 });
      await page.click('.ideas-threads-toggle');
      await waitState('筋: ');
      const row = page.locator('.ideas-thread-row').first();
      const rowText = (await row.innerText()).replace(/\s+/g, ' ');
      await row.locator('.ideas-thread-open').click();
      await waitState('筋を開きました');
      const reopened = (await page.locator('.ideas-thread .ideas-thread-step').allInnerTexts()).map((t) => t.trim());
      const cards = await texts();
      await page.click('.ideas-thread-ask');
      await waitState('筋を依頼に入れました');
      const value = await page.locator('.chat textarea').first().inputValue();
      await page.locator('.chat textarea').first().fill('');
      await shot('ideas-thread-reopened.png');
      const ok = closed && steps.length === 2 && rowText.includes(THOUGHT) && rowText.includes('育てた札 2 枚')
        && reopened.join('｜') === steps.join('｜') && cards.length === 3
        && value.includes(`思いつき: ${THOUGHT}`) && value.includes(`1. ${steps[0]}`) && value.includes(`2. ${steps[1]}`);
      return { ok, why: `閉じたあと筋の箱は${closed ? '隠れた' : '出たまま'} ／ 起こし直したあとの一覧: ${rowText.slice(0, 70)} ／ 開き直した筋 ${reopened.length} 枚（閉じる前と${reopened.join('｜') === steps.join('｜') ? '同じ' : '違う'}）・続きの札 ${cards.length} 枚 ／ 入力欄: ${value.replace(/\s+/g, ' ').slice(0, 90)}` };
    },
  },
];

const results = [];
let browser;
let failed = 0;
try {
  say(`起こします: ${start}（モデルの保存先は空のフォルダ ${emptyModels}）`);
  await startApp();
  // 前の回の語・重み・残した札と、拡張機能の入り切りを消してから始める
  stateDir = (await api('/api/info')).stateDir ?? '';
  if (!stateDir) throw new Error('本体のデータの場所（/api/info の stateDir）が分かりません');
  configFile = (await api('/api/config')).path ?? '';
  if (!configFile) throw new Error('設定のファイルの場所（/api/config の path）が分かりません');
  await call('/api/extensions', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'ideas', enabled: true }) });
  await fetch(`http://127.0.0.1:${port}/api/quit`, { method: 'POST' }).catch(() => undefined);
  for (let i = 0; i < 60; i += 1) {
    if (!(await api('/api/info')).pid) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  stopAll();
  rmSync(join(stateDir, 'extensions', 'ideas'), { recursive: true, force: true });
  // 本体は、モデルが 1 つも無いと、起こしたときに推奨のモデルを取りに行く。この確かめの間は止める（設定 runtime.autoFetch）。
  // 最初に起こした分の取りかけは消す。終わったら、設定を元に戻す
  setAutoFetch(false);
  await new Promise((r) => setTimeout(r, 2000));
  rmSync(emptyModels, { recursive: true, force: true });
  mkdirSync(emptyModels, { recursive: true });
  await startApp();
  await call('/api/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workRoot }) });
  const { chromium } = await import('playwright-core');
  const exe = process.env.AAS_CHECK_BROWSER || findAppBrowser(process.platform, process.env, existsSync);
  browser = await chromium.launch(exe ? { executablePath: exe } : {});
  page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('pageerror', (e) => say(`画面の中で落ちました: ${e.message}`));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await settle();
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
  try { setAutoFetch(autoFetchBefore); } catch { /* 設定を読めなかった回。変えていない */ }
}
console.log(`== 測った値: ${JSON.stringify(measured)}`);
console.log(`== 結果: ${results.filter((r) => r.ok).length}/${CHECKS.length}`);
if (out) writeFileSync(out, JSON.stringify({ measured, results }, null, 2));
process.exit(failed > 0 ? 1 : 0);
