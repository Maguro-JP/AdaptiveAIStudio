/**
 * 大きいモデルの確かめ（docs/PLACEMENT.md）。入れた形（配る形）の本体を、
 * 「メモリがモデルより小さい機械」として起こし、画面で計画を見て、そのモデルを選び、頼んで、答えを見る。
 *
 *   node scripts/check-large.mjs --start "<起こす命令>" --port <口> --model-file <.gguf の場所> [--shots <dir>] [--out <json>]
 *
 * メモリは、試験の口（AAS_TEST_RAM_BYTES）でモデルの 6 割に見せる。本物のメモリは変わらないので、モデルは実際には読める。
 * 見るのは「大きすぎます」で断らず、SSD から読む計画を見せ、その計画で読んで答えること。ページングの空きは 64GB、
 * ディスクの空きは 18GB に見せる（22GB のモデルが「入らない」と出て、理由と動かす手が出ることも見る）。
 * そのあと、試験の口を変えて本体を 2 回起こし直す。読み込みの最初の段を落として、段を下げて読み直すのを見る（AAS_TEST_LOAD_FAILS）。
 * 読み込みを待つ上限を 1 ミリ秒にして、時間切れの理由が画面に出るのを見る（AAS_TEST_LOAD_TIMEOUT_MS）。使い方は docs/PLACEMENT.md。
 * 最後に、メモリの小さい機械としてもう一度起こし、置き方を画面で選んで・その置き方で読んで・既定に戻すのを見る（docs/PLACEMENT.md の「置き方を選ぶ」）。
 * 読めなかった段を次は避けること、頼んだあとは速さが「実測」になり、記録を消すと「目安」に戻ることも見る（「使うほど計画が当たる」）。
 * 押し戻しが続いた頼み（試験の口 AAS_TEST_PUSHBACKS）が、置いてある大きいモデルに回ること、置いて無ければ回さずに 1 行で言うこと、
 * 設定で切れることも見る（docs/NETWORK-MODEL.md の「大きいモデルは要るときだけ」）。小さいモデルは scripts/tiny-gguf.mjs（種を固定）で保存先に置き、終わったら消す。
 * 始める前に、本体のデータの下の実測の記録と選んだ置き方を消す（前の回の覚えで、結果が変わらないように）。
 * 確かめは足すだけ。一度載せた id（checks/large.ids）は消さない・飛ばさない（test/large-checks.test.ts が止める）。
 * 1 行ずつ「== PASS <id>: …」「== FAIL <id>: …」を出し、最後に「== 結果: n/m」。1 つでも落ちたら 1 で終わる。
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
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

/** 大きいモデルの機械に見せる口（メモリはモデルの 6 割、ページングの空きは 64GB、ディスクの空きは 18GB）。 */
const SMALL_MACHINE = {
  AAS_TEST_RAM_BYTES: String(shownRam), AAS_TEST_PAGING_BYTES: String(64 * GIB), AAS_TEST_DISK_BYTES: String(18 * GIB),
};
/** 本体のデータの場所（AAS_HOME のデータの下）。実測の記録を消すのに使う。 */
let stateDir = '';
let app;
/** 本体を起こす。`hooks` は試験の口（AAS_TEST_*）。立ち上がるまで待つ。 */
async function startApp(hooks) {
  app = spawn(start, {
    shell: true, stdio: 'inherit', detached: process.platform !== 'win32',
    env: { ...process.env, AAS_UI_PORT: String(port), AAS_UI_NO_OPEN: '1', ...hooks },
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
/** 本体を止めて、別の試験の口で起こし直す（読み込みの段と時間切れは、起こすときの口で決まる）。記録は取り切ってから止める。 */
async function restartApp(hooks) {
  await pullLogs();
  await fetch(`http://127.0.0.1:${port}/api/quit`, { method: 'POST' }).catch(() => undefined);
  for (let i = 0; i < 60; i += 1) {
    if (!(await api('/api/info')).pid) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  stopAll();
  await new Promise((r) => setTimeout(r, 2000));
  logSeq = 0;
  await startApp(hooks);
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.locator('#openSettings').waitFor({ state: 'visible', timeout: 30_000 });
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

/**
 * 記録の「新しく読んだのは N トークン」を、出た順に（最初の 1 トークンまでに、入力として実際に読んだ数。ライブラリの数え）。
 * 待ちの秒数は機械の具合で揺れ、小さいモデルでは 0.1 秒の差で通ったり落ちたりした。読んだ数は、同じ頼みなら回によって変わらない。
 */
const freshTokens = () => logs.flatMap((l) => { const m = /最初の 1 トークンまで [\d.]+ 秒（入力 \d+ トークン・新しく読んだのは (\d+) トークン）/.exec(l); return m ? [Number(m[1])] : []; });

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
      // 「読むのは新しい分だけ」は、読んだトークンの数で見る。答える呼び出し（その回の最後の呼び出し）で、2 回目に新しく読んだ数が 1 回目より少ないこと
      const fresh = freshTokens();
      const freshFirst = fresh.slice(0, turnOneFirsts || before.length).at(-1);
      const freshSecond = fresh.slice(before.length).at(-1);
      measured.freshTokensFirstTurn = freshFirst;
      measured.freshTokensFollowTurn = freshSecond;
      const ok = digits(answer).includes(FOLLOW_ANSWER) && all.length > before.length
        && freshFirst !== undefined && freshSecond !== undefined && freshSecond < freshFirst;
      return { ok, why: `答え: ${answer.replace(/\s+/g, ' ').slice(0, 100)} ／ 答える呼び出しが新しく読んだトークン: 1 回目 ${freshFirst ?? '?'}、2 回目 ${freshSecond ?? '?'}（最初の 1 トークンまで: 1 回目 ${first} 秒、2 回目 ${second} 秒）` };
    },
  },
  {
    id: 'large-retry-steps-down',
    what: `読み込みの最初の段がメモリの不足で落ちる機械（試験の口 AAS_TEST_LOAD_FAILS=1）として起こし直すと、段を下げて読み直し、記録に「やり直し」が残り、「${ASK}」に答え（${ANSWER} を含む）が出る`,
    async run() {
      // メモリは小さく見せない（小さく見せると、コンテキストウィンドウが初めから下限で、下げる段が無い）
      await restartApp({ AAS_TEST_LOAD_FAILS: '1' });
      const from = logs.length;
      const answer = await ask(ASK, 60, true);
      await shot('large-retry.png');
      const mine = logs.slice(from);
      const fell = mine.find((l) => l.includes('読み込めませんでした（メモリが足りません（試験の口 AAS_TEST_LOAD_FAILS')) ?? '';
      const retry = mine.find((l) => /やり直し 1\/\d+: /.test(l)) ?? '';
      measured.retryLine = retry;
      const ok = Boolean(fell) && Boolean(retry) && digits(answer).includes(ANSWER);
      return { ok, why: `落ちた段: ${fell.slice(0, 90) || '（無い）'} ／ ${retry.slice(0, 110) || '（やり直しの行が無い）'} ／ 答え: ${answer.replace(/\s+/g, ' ').slice(0, 80)}` };
    },
  },
  {
    id: 'large-avoids-failed-step',
    what: `前の確かめで読み込みが落ちた段を覚えていて、口を立てずに起こし直すと、その段を最初から避けて読み（記録に「避けて、次の段から読みます」が残り、「読み込めませんでした」は出ない）、「${ASK}」に答え（${ANSWER} を含む）が出る`,
    async run() {
      await restartApp({});
      const from = logs.length;
      const answer = await ask(ASK, 60, true);
      await shot('large-avoid.png');
      const mine = logs.slice(from);
      const avoided = mine.find((l) => /前にメモリが足りずに落ちた置き方（.+）を避けて、次の段から読みます/.test(l)) ?? '';
      const fell = mine.some((l) => l.includes('読み込めませんでした'));
      measured.avoidLine = avoided;
      const ok = Boolean(avoided) && !fell && digits(answer).includes(ANSWER);
      return { ok, why: `${avoided.slice(0, 130) || '（避けた行が無い）'} ／ 落ちた段: ${fell ? '在る' : '無い'} ／ 答え: ${answer.replace(/\s+/g, ' ').slice(0, 80)}` };
    },
  },
  {
    id: 'large-load-timeout-says-why',
    what: '読み込みを待つ上限を 1 ミリ秒にして起こし直す（試験の口 AAS_TEST_LOAD_TIMEOUT_MS=1）と、いつまでも待たずに止まり、読み込みが終わらなかったことと、どうすればよいかが画面に出る',
    async run() {
      await restartApp({ AAS_TEST_LOAD_TIMEOUT_MS: '1' });
      const from = logs.length;
      const t0 = Date.now();
      await ask(ASK, 10, true);
      const seconds = Math.round((Date.now() - t0) / 1000);
      await shot('large-timeout.png');
      const seen = await page.locator('body').innerText().catch(() => '');
      const line = logs.slice(from).find((l) => l.includes('の読み込みが 0.001 秒で終わりませんでした')) ?? '';
      const shown = seen.includes('の読み込みが 0.001 秒で終わりませんでした') && seen.includes('小さいモデルか、空きの多い機械で試してください');
      measured.timeoutSeconds = seconds;
      const ok = shown && seconds < 300;
      return { ok, why: `画面: ${shown ? '理由と手が出た' : '出ていない'} ／ 記録: ${line.slice(0, 100) || '（無い）'} ／ 止まるまで ${seconds} 秒` };
    },
  },
  {
    id: 'large-options-pick-and-reset',
    what: `設定 → モデル に、同じモデルの置き方が 2 つ以上（1 つに「既定」）並び、1 回押すと選べて、開き直しても覚えていて、その置き方で読んで「${ASK}」に答え（${ANSWER} を含む）、「おまかせ」を押すと既定に戻る`,
    async run() {
      await restartApp(SMALL_MACHINE);
      await openModelSettings();
      const mine = `#cfgGguf .placement-options[data-ref="${ref}"]`;
      await page.locator(`${mine} .placement-option`).first().waitFor({ state: 'visible', timeout: 60_000 });
      const texts = await page.locator(`${mine} .placement-option`).allInnerTexts();
      const defaults = texts.filter((t) => t.includes('（既定）')).length;
      const other = page.locator(`${mine} .placement-option:not(.chosen)`).first();
      const name = (await other.locator('.placement-option-name').innerText()).replace(/^[○●]\s*/, '').trim();
      await other.click();
      await page.locator(`${mine} .placement-option.chosen`, { hasText: name }).waitFor({ state: 'visible', timeout: 30_000 });
      const note = await page.locator('#cfgNote').innerText();
      await shot('large-options-picked.png');
      // 開き直しても、選んだものが残っている
      await page.reload({ waitUntil: 'domcontentloaded' });
      await openModelSettings();
      const kept = await page.locator(`${mine} .placement-option.chosen`).first().innerText();
      await page.keyboard.press('Escape');
      const from = logs.length;
      const answer = await ask(ASK, 60, true);
      const used = logs.slice(from).find((l) => l.includes(`選んである置き方（${name}）で読みます`)) ?? '';
      // 「おまかせ」（既定）を押して戻す
      await openModelSettings();
      await page.locator(`${mine} .placement-option`, { hasText: '（既定）' }).first().click();
      await page.locator(`${mine} .placement-option.chosen`, { hasText: '（既定）' }).waitFor({ state: 'visible', timeout: 30_000 });
      const back = ((await api('/api/models')).installed ?? []).find((m) => m.ref === ref)?.chosen;
      await shot('large-options-back.png');
      await page.keyboard.press('Escape');
      measured.optionPicked = name;
      measured.optionLines = texts.map((t) => t.replace(/\s+/g, ' '));
      const ok = texts.length >= 2 && defaults === 1 && note.includes(`「${name}」で置きます`) && kept.includes(name) && kept.includes('（選択中）')
        && Boolean(used) && digits(answer).includes(ANSWER) && back === 'auto';
      return { ok, why: `置き方 ${texts.length} 通り（既定 ${defaults}）。押したもの: ${name} ／ ${note.slice(0, 80)} ／ 開き直したあと: ${kept.replace(/\s+/g, ' ').slice(0, 60)} ／ 記録: ${used.slice(0, 80) || '（無い）'} ／ 答え: ${answer.replace(/\s+/g, ' ').slice(0, 60)} ／ 戻したあと: ${back}` };
    },
  },
  {
    id: 'large-measured-replaces-estimate',
    what: '頼んだあとは、設定 → モデル の一行と「計画を見る」の速さが「目安」から「実測」に変わる。実測の記録を消す（clean が消すファイルを消す）と「目安」に戻る',
    async run() {
      const row = async () => ((await api('/api/models')).installed ?? []).find((m) => m.ref === ref) ?? {};
      await page.reload({ waitUntil: 'domcontentloaded' });
      await openModelSettings();
      const note = await page.locator('#cfgGguf .note', { hasText: 'この PC では:' }).first().innerText().catch(() => '');
      const more = page.locator('#cfgGguf details.placement-detail').first();
      await more.locator('summary').click();
      const detail = await more.innerText();
      await shot('large-measured.png');
      const speed = /速さの実測: ([\d.]+) tok\/s（(\d+) 回の平均/.exec(detail);
      measured.measuredLine = note;
      measured.measuredTps = speed ? Number(speed[1]) : undefined;
      measured.measuredSamples = speed ? Number(speed[2]) : undefined;
      // 記録を消すと、見当に戻る（clean が消すのと同じファイル）
      const file = join(stateDir, 'placement-history.json');
      const had = existsSync(file);
      rmSync(file, { force: true });
      const back = (await row()).plan ?? '';
      await page.keyboard.press('Escape');
      const ok = /この PC では: .*実測 [\d.]+ tok\/s/.test(note) && Boolean(speed) && Number(speed[2]) >= 1 && had && /目安 [\d.]+ tok\/s/.test(back) && !back.includes('実測');
      return { ok, why: `一行: ${note.slice(-60)} ／ 計画を見る: ${speed ? speed[0] : '（実測の行が無い）'} ／ 記録のファイル: ${had ? '在った' : '無かった'} ／ 消したあと: ${back.slice(-50)}` };
    },
  },
  {
    id: 'large-no-larger-model-says-so',
    what: `押し戻しが続いた頼みとして起こし直す（試験の口 AAS_TEST_PUSHBACKS=2）。今のモデルより大きいモデルが置いて無いので回さず、会話に「大きいモデルに回しませんでした（…）」が 1 行出て、今のモデルで「${ASK}」に答え（${ANSWER} を含む）が出る。設定の画面にも、回せない理由が出る`,
    async run() {
      await restartApp({ AAS_TEST_PUSHBACKS: '2' });
      await openModelSettings();
      const status = page.locator('#escalateStatus');
      await page.waitForFunction(() => document.querySelector('#escalateStatus')?.textContent?.length > 0, null, { timeout: 30_000 });
      const shown = await status.innerText();
      await shot('large-escalate-none.png');
      await page.keyboard.press('Escape');
      const from = logs.length;
      const answer = await ask(ASK, 60, true);
      const seen = await page.locator('body').innerText().catch(() => '');
      const said = '大きいモデルに回しませんでした（今のモデルより大きいモデルが置いてありません）。今のモデルで続けます';
      const lines = logs.slice(from).filter((l) => l.includes('大きいモデルに回しませんでした'));
      const routed = logs.slice(from).some((l) => l.includes('に回します'));
      const ok = shown.includes('いまは回せません（今のモデルより大きいモデルが置いてありません）') && seen.includes(said) && lines.length === 1 && !routed && digits(answer).includes(ANSWER);
      return { ok, why: `設定の画面: ${shown.slice(0, 70)} ／ 会話: ${seen.includes(said) ? '1 行出た' : '出ていない'} ／ 記録 ${lines.length} 行: ${(lines[0] ?? '').slice(0, 90)} ／ 答え: ${answer.replace(/\s+/g, ' ').slice(0, 60)}` };
    },
  },
  {
    id: 'large-escalates-when-pushed-back',
    what: `小さいモデル（種を固定した scripts/tiny-gguf.mjs）を置いて選び、押し戻しが続いた頼みとして「${ASK}」を送ると、置いてある大きいモデルに回り、会話に「切替（…大きいモデルに回します）」が出て、記録に「回します」が残り、答え（${ANSWER} を含む）が出る。設定で切ると、次の頼みは回らない`,
    async run() {
      const tiny = 'aas-check-small.gguf';
      const tinyAt = join(dirname(modelFile), tiny);
      execFileSync(process.execPath, [join(import.meta.dirname, 'tiny-gguf.mjs'), tinyAt, '--seed', '7'], { stdio: 'ignore' });
      const use = async (name) => {
        await page.reload({ waitUntil: 'domcontentloaded' });
        await openModelSettings();
        const row = page.locator('#cfgGguf .row', { hasText: name }).first();
        await row.waitFor({ state: 'visible', timeout: 60_000 });
        const button = row.getByRole('button').last();
        if (await button.isEnabled()) await button.click();
        await page.waitForFunction((r) => [...document.querySelectorAll('#cfgGguf .row')].some((x) => x.textContent.includes(r) && x.textContent.includes('いまこれ')), name, { timeout: 30_000 });
      };
      const escalateText = async (want) => {
        await page.waitForFunction((w) => (document.querySelector('#escalateStatus')?.textContent ?? '').includes(w), want, { timeout: 30_000 }).catch(() => undefined);
        return page.locator('#escalateStatus').innerText();
      };
      try {
        await use(tiny);
        const target = await escalateText('回す先');
        await shot('large-escalate-ready.png');
        await page.keyboard.press('Escape');
        let from = logs.length;
        const answer = await ask(ASK, 60, true);
        const seen = await page.locator('body').innerText().catch(() => '');
        await shot('large-escalated.png');
        const line = logs.slice(from).find((l) => l.includes(`ので、大きいモデル（${ref}）に回します`)) ?? '';
        const onScreen = seen.includes(`${ref} に切替（押し戻しが 2 回続いたので、大きいモデルに回します）`);
        // 設定で切る。次の頼みは回らない（小さいモデルの答えの中身は見ない。乱数の重みなので意味を成さない）
        await openModelSettings();
        await page.locator('#escalateOn').click();
        const off = await escalateText('切ってあります');
        await page.keyboard.press('Escape');
        from = logs.length;
        await ask(ASK, 10, true);
        const routedWhenOff = logs.slice(from).some((l) => l.includes('に回します') || l.includes('回しませんでした'));
        // 戻す（入れ直す）
        await openModelSettings();
        await page.locator('#escalateOn').click();
        const back = await escalateText('入っています');
        measured.escalateLine = line;
        const ok = target.includes(`回す先: ${ref}`) && Boolean(line) && onScreen && digits(answer).includes(ANSWER)
          && off.includes('切ってあります') && !routedWhenOff && back.includes(`回す先: ${ref}`);
        return { ok, why: `設定の画面: ${target.slice(0, 60)} ／ 記録: ${line.slice(0, 100) || '（無い）'} ／ 会話の「切替」: ${onScreen ? '出た' : '出ていない'} ／ 答え: ${answer.replace(/\s+/g, ' ').slice(0, 60)} ／ 切ったあと: ${off.slice(0, 30)}・${routedWhenOff ? '回った' : '回らない'} ／ 戻したあと: ${back.slice(0, 40)}` };
      } finally {
        // 元のモデルに戻し、置いた小さいモデルを消す
        await use(ref).catch(() => undefined);
        await page.keyboard.press('Escape').catch(() => undefined);
        rmSync(tinyAt, { force: true });
      }
    },
  },
];

const results = [];
let browser;
let failed = 0;
try {
  say(`起こします: ${start}（${ref} ${(modelBytes / GIB).toFixed(1)}GB を、メモリ ${(shownRam / GIB).toFixed(1)}GB の機械として）`);
  await startApp(SMALL_MACHINE);
  await api('/api/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workRoot: work }) });
  // 前の回の覚え（実測・読めなかった段・選んだ置き方）を消してから始める。残っていると、回によって「目安」が「実測」になり、落とす段が変わる
  stateDir = (await api('/api/info')).stateDir ?? '';
  if (!stateDir) throw new Error('本体のデータの場所（/api/info の stateDir）が分かりません');
  for (const name of ['placement-history.json', 'placement-choices.json']) rmSync(join(stateDir, name), { force: true });
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
