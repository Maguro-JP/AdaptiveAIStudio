/**
 * 画面を、端から押して回る。
 *
 * **利用者に見つけてもらわない。**設定を開く・畳む・開き直す・送る、を
 * こちらで実際に押して、落ちた所と空のまま出た所を並べる。
 * 実際に「選択肢が空」「畳んだら開けない」を見つけられずに出してしまった。
 *
 * 使い方:
 *   node scripts/sweep.mjs <画面のURL> [撮る先.png] [--no-model]
 *
 * --no-model はモデルを置いていない状態で回すとき。送りが 503 で断られるのが
 * 正しい振る舞いなので、それを不具合に数えない。
 *
 * 走らせるには playwright-core と Chromium が要る（bundle には入れない）。
 */
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
import { findBrowser } from './find-browser.mjs';
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const noModel = process.argv.includes('--no-model');
const url = args[0];
const shot = args[1];
if (!url) {
  console.error('使い方: node scripts/sweep.mjs <画面のURL> [撮る先.png] [--no-model]');
  process.exit(2);
}
// ブラウザの場所を決め打たない（この機械にしか無い道だった）。
// Windows なら Edge、mac なら Chrome を探す。`AAS_SWEEP_BROWSER` が最優先。
const picked = findBrowser({ platform: process.platform, env: process.env, exists: existsSync });
if (!picked.ok) { console.error(picked.why); process.exit(2); }
const b = await chromium.launch({ executablePath: picked.browser });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const bad = [];
/*
 * 断られるのを見に行っている間は、断りを不具合に数えない。
 *
 * 立ち上げ直しの確かめは 409（作業中）も 501（起こし直せない入口）も
 * 「正しい断り」として通すのに、下の聞き耳は 409 を不具合に積んでいた。
 * 手すきの見回りが走っていると作業中になるので、**走らせるたびに結果が
 * 変わる**（一度通って、次に落ちた）。
 */
let expectingRefusal = false;
/** わざと保存を失敗させている間（500 を返させている口）。その 500 は不具合として数えない。 */
let expectingSaveFailure = false;
p.on('pageerror', (e) => bad.push(`落ちた: ${e.message}`));
p.on('console', (m) => {
  if (m.type() !== 'error') return;
  if (noModel && m.text().includes('503')) return;
  if (expectingRefusal && /\b(409|501)\b/.test(m.text())) return;
  if (expectingSaveFailure && /\b500\b/.test(m.text())) return;
  bad.push(`画面のエラー: ${m.text()}`);
});
p.on('response', (r) => {
  if (r.status() < 400) return;
  const at = new URL(r.url()).pathname;
  // モデルを置いていない状態では、送りを断るのが正しい。
  if (noModel && r.status() === 503 && at === '/api/send') return;
  // **起こし直してもらえない入口では、断るのが正しい。**作業中の 409 も同じ。
  // ここで止めると誰も起こさず、二度と戻らない（実際にそうなっていた）。
  if (expectingRefusal && [409, 501].includes(r.status()) && at === '/api/restart') return;
  if (expectingSaveFailure && r.status() === 500 && ['/api/theme/preset', '/api/layout/preset', '/api/theme', '/api/memory', '/api/unfinished', '/api/state'].includes(at)) return;
  bad.push(`${r.status()} ${at}`);
});

/*
 * **通信が止むのを待たない。本体と繋がったのを待つ。**
 *
 * `networkidle`（通信が 0.5 秒止むまで待つ）で開いていた。画面は開いた瞬間から
 * `/api/events` を開きっぱなしにするので、通信は止まない。Chromium の版によっては
 * 30 秒で切れて、押す前に落ちた（2026-09-24、claude.ai のクラウドで実測）。
 * Playwright も `networkidle` は勧めていない。画面が「つながっています」になった
 * （`#status.live`、EventSource の onopen）ところを、開き終わりとみなす。
 */
// 横のパネルを畳んでいても繋がりは見える。**見えているかではなく、在るかで待つ**
// （既定の visible だと、畳んだ状態が残ったとき 30 秒ずつ待って連鎖して落ちる）。
const opened = () => p.waitForSelector('#status.live', { state: 'attached', timeout: 30_000 });

await p.goto(url, { waitUntil: 'load' });
await opened();
await p.waitForTimeout(800);

/** 設定の板を閉じる。開いたままだと、後の確かめが全部その板に阻まれる。 */
const closeSettings = async () => {
  if (!(await p.locator('#settings').isVisible())) return;
  await p.locator('#settings menu button[value="close"]').click({ timeout: 5000 }).catch(async () => {
    await p.keyboard.press('Escape');
  });
  await p.waitForTimeout(400);
};

/*
 * 落ちたときは、その瞬間の画面を残す（AAS_SWEEP_SHOTS にフォルダを渡したとき）。
 * 「locator.click: Timeout」だけでは、何が被さっていたのか分からない。
 */
let failShot = 0;
const check = async (name, fn) => {
  try { await fn(); } catch (e) {
    bad.push(`${name}: ${String(e.message ?? e).split('\n')[0]}`);
    const dir = process.env.AAS_SWEEP_SHOTS;
    if (dir) await p.screenshot({ path: `${dir}/sweep-${++failShot}.png` }).catch(() => undefined);
  }
};

// 横の板：畳んで、開き直せるか
await check('板を畳む', async () => {
  await p.locator('#sideToggle').click();
  await p.waitForTimeout(300);
  if (await p.locator('#side').isVisible()) throw new Error('畳めていない');
  await p.locator('#sideOpen').click();
  await p.waitForTimeout(300);
  if (!(await p.locator('#side').isVisible())) throw new Error('開き直せない');
});

// 設定：全部の頁を開いて、空欄が無いか
await check('設定を開く', async () => { await p.locator('#openSettings').click(); await p.waitForTimeout(1200); });
for (const sec of ['info', 'look', 'place', 'model', 'mcp', 'check']) {
  await check(`設定/${sec}`, async () => {
    await p.locator(`.tabs-lite button[data-sec="${sec}"]`).click();
    await p.waitForTimeout(900);
    const box = p.locator(`#settings section[data-sec="${sec}"]`);
    if (!(await box.isVisible())) throw new Error('頁が出ない');
    const text = (await box.innerText()).trim();
    if (text.length === 0) throw new Error('中身が空');
    for (const id of await box.locator('select').evaluateAll((els) => els.map((e) => e.id))) {
      const n = await p.locator(`#${id} option`).count();
      if (n === 0) throw new Error(`選択肢が空: #${id}`);
    }
  });
}
await check('設定を閉じる', async () => {
  await p.locator('#settings menu button[value="close"]').click();
  await p.waitForTimeout(500);
  if (await p.locator('#settings').isVisible()) throw new Error('閉じない');
});
// 閉じたあと、もう一度開けるか（閉じたら開けない、を作らないため）
await check('設定をもう一度開く', async () => {
  await p.locator('#openSettings').click();
  await p.waitForTimeout(800);
  if (!(await p.locator('#settings').isVisible())) throw new Error('二度目が開かない');
  await p.locator('#settings menu button[value="close"]').click();
  await p.waitForTimeout(400);
});

// 表示：出す・閉じる・並べ替える。**押して確かめる。**
await check('表示から板を出す', async () => {
  const before = await p.locator('#root .panel').count();
  await p.locator('#openView').click();
  await p.waitForTimeout(500);
  if (!(await p.locator('#viewMenu').isVisible())) throw new Error('開かない');
  const rows = await p.locator('#viewList .view-row').count();
  if (rows === 0) throw new Error('選べるものが無い');
  // いま出ていないものを一つ出す。
  const off = p.locator('#viewList .view-row').filter({ has: p.locator('input:not(:checked)') }).first();
  if (await off.count() === 0) throw new Error('出ていないものが無い（数えられていない）');
  const name = (await off.innerText()).trim();
  await off.locator('input').click();
  await p.waitForTimeout(700);
  await p.keyboard.press('Escape');
  await p.waitForTimeout(400);
  const after = await p.locator('#root .panel').count();
  const heads = await p.locator('#root .panel header, #root .panel.tabs header button').allInnerTexts();
  if (!heads.some((h) => h.includes(name))) {
    throw new Error(`出したものが画面に無い: ${name} / ${heads.join(',')}（板 ${before}→${after}）`);
  }
});

await check('板を閉じる', async () => {
  // 束ねてある板の見出しは、中の一枚ごとに × を持つ（直下には無い）。
  // ここでは一枚ものの板を閉じる。
  // **会話のパネルは閉じない。**後の確かめが全部そこで打つ。既定の配置（エディタが
  // 真ん中）では、最後の一枚ものが会話になり、閉じたあとに何も打てなくなった。
  const xs = p.locator('#root .panel:not(.tabs)').filter({ hasNot: p.locator('.chat') }).locator(':scope > header > .panel-x');
  const before = await p.locator('#root .panel').count();
  if (await xs.count() === 0) throw new Error('閉じるものが無い');
  await xs.last().click();
  await p.waitForTimeout(700);
  if (await p.locator('#root .panel').count() >= before) throw new Error('閉じていない');
});

await check('掴んで並べ替える', async () => {
  const heads = p.locator('#root .panel > header');
  if (await heads.count() < 2) throw new Error('動かす相手が足りない');
  const from = heads.first();
  const to = heads.last();
  // **形そのものを見る。**割れている数だけだと、抜いた分と足した分が
  // 打ち消し合って「変わっていない」ように見える（実際にそう出た）。
  const shapeBefore = await p.evaluate(() => fetch('/api/layout').then((r) => r.json()).then((j) => JSON.stringify(j.layout.root)));
  // HTML の掴んで落とすは、手で組み立てて渡す。
  await p.evaluate(() => {
    const all = [...document.querySelectorAll('#root .panel')];
    const a = all[0], b = all[all.length - 1];
    const dt = new DataTransfer();
    a.querySelector('header').dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
    const r = b.getBoundingClientRect();
    const at = { clientX: r.left + r.width / 2, clientY: r.bottom - 4, dataTransfer: dt, bubbles: true };
    b.dispatchEvent(new DragEvent('dragover', at));
    b.dispatchEvent(new DragEvent('drop', at));
  });
  await p.waitForTimeout(900);
  const shapeAfter = await p.evaluate(() => fetch('/api/layout').then((r) => r.json()).then((j) => JSON.stringify(j.layout.root)));
  if (shapeAfter === shapeBefore) throw new Error('並びが変わっていない');
  if (await p.locator('#root .panel').count() === 0) throw new Error('板が消えた');
});

// コマンド板
await check('コマンドを開いて閉じる', async () => {
  // コマンドは入力欄の中（書く手の隣）。板の並びからは外した。
  await p.locator('.chat .field button[title^="コマンド"]').click();
  await p.waitForTimeout(600);
  if (!(await p.locator('#palette').isVisible())) throw new Error('開かない');
  if ((await p.locator('#paletteList').innerText()).trim().length === 0) throw new Error('中身が空');
  await p.keyboard.press('Escape');
  await p.waitForTimeout(400);
});

// 会話：開く → 新しい会話 → 消す。**押した結果まで見る。**
//
// ここは「一番上のつまみを押す」だけだった。押して何が起きたかを見ていない
// ので、押しても何も起きない形をそのまま通していた。実際に利用者から
// 「会話が消せない」「新規で会話が開けない」と言われている。
const convRows = () => p.locator('#sideSessions .side-row');

/*
 * **まだ何も話していない機械では、会話は一つも無い。**
 *
 * 開いた直後はどれも開いていない（トップ）。最初の一言が来たときに会話が
 * できる。ここを「一覧が空なら不具合」と書いていたので、配る形をそのまま
 * 起こして押したときに、正しい姿を不具合として数えていた。
 *
 * 空のときは、**空だと分かる形で出ているか**を見る。
 */
await check('会話を開く', async () => {
  if (await convRows().count() === 0) {
    const empty = await p.locator('#sideSessions .empty').innerText().catch(() => '');
    if (!empty.trim()) throw new Error('一覧が空なのに、空だと言っていない');
    return;
  }
  const row = convRows().last();
  const name = (await row.locator('button').first().innerText()).trim();
  await row.locator('button').first().click();
  await p.waitForTimeout(800);
  // 選ばれている印が、押したものに付くこと。
  const on = await p.locator('#sideSessions .side-row button.on').first().innerText().catch(() => '');
  if (on.trim() !== name) throw new Error(`押したものが選ばれていない: ${name} / ${on.trim()}`);
});

await check('トップへ戻る（名前を押す）', async () => {
  // 「新しい会話」の押しボタンは置かない。トップで書き始めれば新しい会話になる。
  // 名前（左上）を押すとトップへ戻る。**押しても会話は増えない**（空の会話が
  // 増えるように見えるのが嫌がられた）。
  const before = await convRows().count();
  await p.locator('.brand').first().click();
  await p.waitForTimeout(600);
  const after = await convRows().count();
  if (after !== before) throw new Error(`名前を押しただけで会話が増減した（${before} → ${after}）`);
  const state = await p.evaluate(async () => (await (await fetch('/api/conversations')).json()).current);
  if (state !== null) throw new Error(`トップに戻っていない（current=${state}）`);
});

await check('会話の名前を変える', async () => {
  if (await convRows().count() === 0) return;
  const row = convRows().last();
  const before = (await row.locator('button').first().innerText()).trim();
  const want = `${before}#`;
  const answer = (d) => { void d.accept(want).catch(() => undefined); };
  p.on('dialog', answer);
  try {
    await row.locator('button.rename').click();
    await p.waitForTimeout(1000);
  } finally { p.off('dialog', answer); }
  const names = (await p.locator('#sideSessions .side-row button').allInnerTexts()).map((x) => x.trim());
  if (!names.includes(want)) throw new Error(`変えた名前が出ていない: ${want} / ${names.join(', ')}`);
});

await check('会話を消す', async () => {
  const before = await convRows().count();
  // 何も話していないなら、消す相手も居ない。それは正しい姿。
  if (before === 0) return;
  const row = convRows().last();
  const name = (await row.locator('button').first().innerText()).trim();
  // 消すのは訊いてくる。訊かれなければ、それ自体が不具合。
  let asked = false;
  // 受け手を置く。閉じかけの頁で accept が失敗すると、拾い手が居ないまま
  // sweep ごと落ちて、何を見ていたのかも分からなくなる。
  const answer = (d) => { asked = true; void d.accept().catch(() => undefined); };
  p.on('dialog', answer);
  try {
    await row.locator('button.drop').click();
    await p.waitForTimeout(1200);
  } finally { p.off('dialog', answer); }
  if (!asked) throw new Error('確かめずに消している');
  const names = await p.locator('#sideSessions .side-row button').allInnerTexts();
  if (names.map((s) => s.trim()).includes(name)) throw new Error(`消えていない: ${name}`);
  if (await convRows().count() >= before) throw new Error('数が減っていない');
  // 押し間違えは戻せる（本体は立ち上げ直すまで trash/ に持っている）。戻すと一覧に戻る
  // 最後に消した一件（一覧の直下）。前に消した分は畳みの中に並ぶので、数に入れない（普段の画面に当てると残っている）
  const note = p.locator('#sideSessions > .side-note');
  if (await note.count() === 0 || !(await note.innerText()).includes(`「${name}」を消しました`)) throw new Error('消したことと、戻す口を出していない');
  // 文字が在っても、幅が 0 に潰れていれば見えない（innerText は見えていなくても返る）。測って見る
  const said = await note.locator('.grow').boundingBox();
  if (!said || said.width < 40) throw new Error(`消した知らせの文が潰れて見えない（幅 ${said?.width ?? 0}px）`);
  await note.locator('button', { hasText: '戻す' }).click();
  await p.waitForTimeout(800);
  const back = (await p.locator('#sideSessions .side-row button').allInnerTexts()).map((s) => s.trim());
  if (!back.includes(name)) throw new Error(`戻していない: ${name}`);
  if ((await p.locator('#sideSessions').innerText()).includes(`「${name}」を消しました`)) throw new Error('戻したのに、消した知らせが残っている');
});

/*
 * **続けて二つ消しても、前に消した方を戻せる。**前は画面が最後の一件だけを持っていたので、一つ目は戻せなかった。
 * 戻せるものは本体が `trash` で渡す。二件を作るにはモデルが要るので、一覧と戻す口は横取りする。
 */
await check('続けて消した会話の、前の方を戻せる', async () => {
  const heads = [
    { id: 'c20260101-000000-0001', title: 'SWEEP-一つ目', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', messages: 2 },
    { id: 'c20260101-000000-0002', title: 'SWEEP-二つ目', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', messages: 2 },
  ];
  let list = [];
  let trash = [{ id: heads[1].id, title: heads[1].title, at: 2 }, { id: heads[0].id, title: heads[0].title, at: 1 }];
  const sent = [];
  await p.route('**/api/conversations**', async (r) => {
    const req = r.request();
    const at = new URL(req.url()).pathname;
    if (req.method() === 'GET' && at === '/api/conversations') {
      return r.fulfill({ json: { current: null, running: null, runningAll: [], list, total: list.length, hidden: 0, trash } });
    }
    if (req.method() === 'POST' && at === '/api/conversations/restore') {
      const { id } = JSON.parse(req.postData() ?? '{}');
      sent.push(req.postData() ?? '');
      list = [...list, heads.find((h) => h.id === id)];
      trash = trash.filter((t) => t.id !== id);
      return r.fulfill({ json: { id } });
    }
    return r.fallback();
  });
  try {
    await p.reload({ waitUntil: 'load' });
    await opened();
    await p.waitForTimeout(800);
    const box = p.locator('#sideSessions');
    if (!(await box.innerText()).includes('「SWEEP-二つ目」を消しました')) throw new Error('最後に消した会話と、戻す口を出していない');
    const more = box.locator('details');
    if (await more.count() !== 1) throw new Error('前に消した会話を畳んで並べていない');
    await more.locator('summary').click();
    await p.waitForTimeout(300);
    const older = more.locator('.side-note', { hasText: 'SWEEP-一つ目' });
    if (!(await older.isVisible())) throw new Error('畳んだ分を開いても、前に消した会話が見えない');
    await older.locator('button', { hasText: '戻す' }).click();
    await p.waitForTimeout(800);
    if (sent.length !== 1 || JSON.parse(sent[0]).id !== heads[0].id) throw new Error(`前に消した方を戻すよう頼んでいない: ${sent.join(' / ')}`);
    if (Object.keys(JSON.parse(sent[0])).join(',') !== 'id') throw new Error(`名前のほかまで送っている: ${sent[0]}`);
    const names = (await p.locator('#sideSessions .side-row button').allInnerTexts()).map((x) => x.trim());
    if (!names.includes('SWEEP-一つ目')) throw new Error(`戻した会話が一覧に無い: ${names.join(', ')}`);
    const text = await box.innerText();
    if (!text.includes('「SWEEP-二つ目」を消しました')) throw new Error('戻していない方の口を消した');
    if (text.includes('ほかにも')) throw new Error('戻した後も、前の分が畳みに残っている');
  } finally {
    await p.unroute('**/api/conversations**');
    await p.reload({ waitUntil: 'load' }).then(opened).catch(() => undefined);
    await p.waitForTimeout(800);
  }
});
await check('送って返る', async () => {
  /*
   * **自分が打った文で満たされる確かめを書かない。**
   *
   * ここは「モデルが無いときの確かめ」と打って、`log.includes('モデル')` を
   * 見ていた。打った文はそのまま流れに写されるので、**断りの表示を丸ごと
   * 消しても通る。**打つ文から、見たい語を外す。そして**打った文より後ろ**を見る。
   */
  const typed = noModel ? '1 たす 1 は' : '掃除の確かめ';
  await p.locator('.chat textarea').fill(typed);
  await p.locator('.chat textarea').press('Enter');
  const after = async () => {
    const log = await p.locator('.chat .log').innerText();
    const at = log.lastIndexOf(typed);
    return at < 0 ? '' : log.slice(at + typed.length);
  };
  if (noModel) {
    await p.waitForTimeout(2000);
    const said = await after();
    if (!/GGUF|使えるモデルがありません/.test(said)) {
      throw new Error(`断った理由が出ていない: ${JSON.stringify(said.slice(0, 120))}`);
    }
    return;
  }
  await p.waitForFunction(() => document.getElementById('run')?.dataset.state === 'busy', null, { timeout: 30000 });
  await p.waitForFunction(() => document.getElementById('run')?.dataset.state !== 'busy', null, { timeout: 120000 });
  // **返ってきたことを見る。**打った文が出ていることは、返ったことの証拠にならない。
  const said = await after();
  if (said.replace(/\s/g, '').length === 0) throw new Error('打った文の後ろに、何も返っていない');
});
// 狭い窓。横の板と会話が重なって、押せなくなっていないか。
await check('狭い窓（1024）', async () => {
  await p.setViewportSize({ width: 1024, height: 768 });
  await p.waitForTimeout(400);
  const t = p.locator('.chat textarea');
  if (!(await t.isVisible())) throw new Error('入力欄が見えない');
  const box = await t.boundingBox();
  if (!box || box.width < 200) throw new Error(`入力欄が潰れている: ${box?.width ?? 0}px`);
  const send = await p.locator('.chat .send').boundingBox();
  if (!send || send.width < 20) throw new Error('送るボタンが潰れている');
});
/*
 * **溢れは、`scrollWidth` では見つからない。**
 *
 * 上の確かめは「横に溢れていないか」を `scrollWidth` で見ていた。溢れた分を
 * 親が切り取る（overflow: hidden）と、`scrollWidth` は増えない。**切り取られた
 * ものは、見えないまま押せない。**実測で、幅 900 のとき入力の行が画面から 40px、
 * 送るボタンが 35px はみ出していた（切り取られて、画面には出ていない）。
 *
 * だから「押せるか」で見る。押したいものの右端が、画面の中に在ること。
 */
await check('会話のパネルが狭くても、押したいものが外へ出ない', async () => {
  /*
   * **ブラウザの幅で測らない。**ブラウザを縮めても、配置（どのパネルが開いているか）で会話の
   * パネルの幅は変わる。ここまでの確かめでサイドを畳んでいるので、同じブラウザの幅でも
   * 広いままになり、**溢れが出ない**（実際に、畳んだ形では一度も出なかった）。
   * 走らせる順で結果が変わる確かめにしない。
   *
   * 見たいのは「会話のパネルが狭いとき、中のものが外へ出ないか」。だから
   * **パネルの幅をこちらで決めて**測る。実測では、ブラウザを 900 にしたとき
   * 送るボタンが 35px 外へ出ていた（切り取られるので `scrollWidth` では増えない）。
   */
  const bad = await p.evaluate(async () => {
    const chat = document.querySelector('.chat');
    const field = chat?.querySelector('.field');
    if (!chat || !field) return ['会話のパネルが見つからない'];
    const panel = chat.closest('.panel') ?? chat;
    const was = panel.style.width;
    const found = [];
    try {
      for (const width of [420, 360, 320, 280, 240]) {
        panel.style.width = `${width}px`;
        // 次の描き直しを待つ（測る前に効かせる）。
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        // **入れ物からはみ出すのは、行そのもの。**中の部品は行の中に収まったまま、
        // 行ごとパネルの外へ出ていた（だから中だけ見ると見つからない）。
        const edge = panel.getBoundingClientRect().right;
        const box = field.getBoundingClientRect();
        const over = Math.round(box.right - edge);
        if (over > 1) found.push(`幅 ${width}: 入力の行が ${over}px 外（送るボタンが隠れる）`);
        for (const el of field.querySelectorAll('button, textarea')) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          const out = Math.round(r.right - edge);
          if (out > 1) found.push(`幅 ${width}: ${el.className || el.tagName.toLowerCase()} が ${out}px 外`);
        }
      }
    } finally {
      panel.style.width = was;
    }
    return found;
  });
  if (bad.length > 0) throw new Error(bad.join(' / '));
});
await check('画面が低くても、閉じ方が見えている', async () => {
  /*
   * **閉じ方が見えていないと、閉じ方を探すことになる。**画面が低いと
   * （実測: 高さ 700 以下）設定の中身が画面より長くなり、「閉じる」は
   * 下端 755px ＝ 画面の外に居た。中は巻けるので辿り着けるが、見えていない。
   * Esc を知らない人は、そこで詰まる。
   */
  const bad = [];
  for (const height of [700, 560, 460]) {
    await p.setViewportSize({ width: 1100, height });
    await p.locator('#openSettings').click();
    await p.waitForTimeout(600);
    const seen = await p.evaluate(() => {
      const d = document.getElementById('settings');
      const close = d && [...d.querySelectorAll('button')].find((b) => (b.textContent || '').includes('閉じる'));
      if (!close) return { 無い: true };
      const r = close.getBoundingClientRect();
      return { 見えている: r.bottom <= window.innerHeight + 1 && r.top >= -1, 下端: Math.round(r.bottom), 画面: window.innerHeight };
    });
    await p.keyboard.press('Escape');
    await p.waitForTimeout(250);
    if (seen.無い) bad.push(`高さ ${height}: 閉じるが無い`);
    else if (!seen.見えている) bad.push(`高さ ${height}: 閉じるが画面の外（下端 ${seen.下端} > ${seen.画面}）`);
  }
  await p.setViewportSize({ width: 1440, height: 900 });
  await p.waitForTimeout(300);
  if (bad.length > 0) throw new Error(bad.join(' / '));
});
await check('同じ案内を、二度出していない', async () => {
  /*
   * **二度言われると、別のことかと読み直す。**設定のモデルの頁で、
   * 「そのフォルダはまだありません。…」が 60px 離れて二度出ていた（撮って見つけた）。
   * GGUF のフォルダの様子を一行で出したうえに、空のときの案内にも同じ文を足していた。
   *
   * 見るのは**文の重なり**。一つの頁の中に、同じ一文が二度出ていないこと。
   */
  await p.locator('#openSettings').click();
  await p.waitForTimeout(600);
  await p.locator('#settings button', { hasText: 'モデル' }).first().click();
  await p.waitForTimeout(800);
  const twice = await p.evaluate(() => {
    // **設定のダイアログを名指しする。**`dialog` で引くと、先に在るコマンドの方が
    // 当たって、設定の中身を一度も見ないまま通っていた。
    const text = document.getElementById('settings')?.innerText ?? '';
    const seen = new Map();
    /*
     * **行ではなく、文で数える。**片方は道の行にくっついて出ていた
     * （「設定ファイル: /tmp/… 開く コピー そのフォルダは…」）ので、
     * 行で突き合わせると同じ文だと分からない（一度それで見逃した）。
     */
    for (const one of text.split(/\n|(?<=。)/).map((l) => l.trim())) {
      // 短い塊（見出し・ボタンの字）は数えない。案内の文だけを見る。
      if (one.length < 12) continue;
      seen.set(one, (seen.get(one) ?? 0) + 1);
    }
    console.log('DIALOG:' + JSON.stringify(text.slice(0, 700)));
    return [...seen].filter(([, n]) => n > 1).map(([line, n]) => `${line.slice(0, 30)}（${n} 回）`);
  });
  await p.keyboard.press('Escape');
  await p.waitForTimeout(300);
  if (twice.length > 0) throw new Error(`同じ案内が二度出ている: ${twice.join(' / ')}`);
});
await check('見えている字が、切れていない', async () => {
  /*
   * **名前が切れていた。**横のサイドの上に押しものを三つ並べたので、名前の枠が
   * 107px しか残らず、137px 要る「AdaptiveAIStudio」が切れていた（実測）。
   * 撮って見るまで気づかず、しかも毎回の画面に出ている所だった。
   *
   * 入れ物より中身が広い（`scrollWidth > clientWidth`）所を数える。
   * 省略（…）を付けてあっても、**名前や見出しは切らさない**。
   */
  const cut = await p.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('.brand, .panel-head, .panel-head *, .side-top *')) {
      if (el.children.length > 0) continue;
      const text = (el.textContent || '').trim();
      if (!text || el.clientWidth === 0) continue;
      const over = el.scrollWidth - el.clientWidth;
      if (over > 1) out.push(`${text.slice(0, 20)}（${over}px 切れ／枠 ${Math.round(el.clientWidth)}px）`);
    }
    return out;
  });
  if (cut.length > 0) throw new Error(`字が切れている: ${cut.join(' / ')}`);
});
await check('もっと狭い窓（720）', async () => {
  await p.setViewportSize({ width: 720, height: 720 });
  await p.waitForTimeout(400);
  const t = p.locator('.chat textarea');
  if (!(await t.isVisible())) throw new Error('入力欄が見えない');
  // 横に溢れていないか。溢れると、押したいものが画面の外へ出る。
  const over = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
  if (over) throw new Error('横に溢れている');
  await p.setViewportSize({ width: 1440, height: 900 });
  await p.waitForTimeout(300);
});

// 見た目の切り替え。選べるのに何も起きない、を作らない。
await check('見た目を切り替える', async () => {
  try {
    await p.locator('#openSettings').click();
    await p.waitForTimeout(700);
    await p.locator('.tabs-lite button[data-sec="look"]').click();
    await p.waitForTimeout(500);
    const ids = await p.locator('#themes option').evaluateAll((els) => els.map((e) => e.value));
    if (ids.length === 0) throw new Error('土台の選択肢が空');
    // **いま選ばれているものを選び直しても、何も起きなくて当たり前。**別のものを選ぶ。
    const now = await p.locator('#themes').inputValue();
    const other = ids.find((v) => v !== now);
    if (!other) throw new Error('選べる土台が一つしかない');
    const before = await p.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await p.selectOption('#themes', other);
    await p.waitForTimeout(1000);
    const after = await p.evaluate(() => getComputedStyle(document.body).backgroundColor);
    if (before === after) throw new Error(`選んでも見た目が変わらない: ${now} → ${other}`);
  } finally {
    // **落ちても閉じる。**開いたままだと、後の確かめが全部その板に阻まれる。
    await closeSettings();
  }
});

/*
 * ログのパネルは、開き直しても切り替えても消えない。
 *
 * 行を DOM にしか持っていなかったので、描き直しのたびに全部消えた（実機）。
 * 過去分は本体が持ち、パネルは開いたとき取り直す。ここでは、開いた時点で過去分が
 * 出ること、描き直し（表示の出し入れ）のあとも残ることを見る。
 */
await check('ログのパネルは切り替えで消えない', async () => {
  const have = await p.evaluate(() => fetch('/api/logs').then((r) => r.json()).then((j) => j.lines.length));
  if (have === 0) throw new Error('本体に記録が一行も無い');
  const showFromView = async (title) => {
    await p.locator('#openView').click();
    await p.waitForTimeout(500);
    const row = p.locator('#viewList .view-row').filter({ hasText: title }).first();
    if (await row.count() === 0) throw new Error(`表示の一覧に ${title} が無い`);
    await row.locator('input').click();
    await p.waitForTimeout(700);
    await p.keyboard.press('Escape');
    await p.waitForTimeout(400);
  };
  const logShown = async () => (await p.locator('#root .panel header, #root .panel.tabs header button')
    .allInnerTexts()).some((h) => h.includes('ログ'));
  if (!(await logShown())) await showFromView('ログ');
  const tab = p.locator('#root .panel.tabs header button').filter({ hasText: 'ログ' });
  if (await tab.count() > 0) { await tab.first().click(); await p.waitForTimeout(400); }
  await p.waitForTimeout(1000);
  const before = await p.locator('#root .log-line').count();
  if (before === 0) throw new Error(`開いた時点で過去分が出ない（本体には ${have} 行）`);
  // 描き直す（別のパネルを出す）。ログの行が残っていること。
  await showFromView('メモ');
  await p.waitForTimeout(1000);
  if (await tab.count() > 0) { await tab.first().click(); await p.waitForTimeout(400); }
  const after = await p.locator('#root .log-line').count();
  if (after < before) throw new Error(`描き直しで消えた: ${before} → ${after}`);
});

// 裏で動いているものは「実行中のタスク」の中に並ぶ（空なら空と言う）。
// 「裏の仕事」と二枚に分けていたら、同じ意味の札が二つ並んだ。
await check('実行中のタスクに、裏の仕事が並ぶ', async () => {
  const shown = async () => (await p.locator('#root .panel header, #root .panel.tabs header button')
    .allInnerTexts()).some((h) => h.includes('実行中のタスク'));
  if (!(await shown())) {
    await p.locator('#openView').click();
    await p.waitForTimeout(500);
    const row = p.locator('#viewList .view-row').filter({ hasText: '実行中のタスク' }).first();
    if (await row.count() === 0) throw new Error('表示の一覧に実行中のタスクが無い');
    await row.locator('input').click();
    await p.waitForTimeout(700);
    await p.keyboard.press('Escape');
    await p.waitForTimeout(400);
  }
  const tab = p.locator('#root .panel.tabs header button').filter({ hasText: '実行中のタスク' });
  if (await tab.count() > 0) { await tab.first().click(); await p.waitForTimeout(400); }
  await p.waitForTimeout(800);
  const jobs = await p.locator('#root .jobs').count();
  if (jobs === 0) throw new Error('裏の仕事の入る所が無い');
  const text = (await p.locator('#root .jobs').first().innerText()).trim();
  if (!text) throw new Error('空なのに空と言わない');
  // 札が二枚に戻っていないこと。
  const heads = await p.locator('#root .panel header, #root .panel.tabs header button').allInnerTexts();
  if (heads.some((h) => h.includes('裏の仕事'))) throw new Error('「裏の仕事」の札が戻っている');
});

// 道の隣に「開く」「コピー」が在る。読めるだけの道は、打ち直すしかなかった。
await check('道の隣に開く・コピーが在る', async () => {
  try {
    await p.locator('#openSettings').click();
    await p.waitForTimeout(700);
    await p.locator('.tabs-lite button[data-sec="info"]').click();
    await p.waitForTimeout(600);
    const n = await p.locator('#infoRows .path-actions button').count();
    if (n < 6) throw new Error(`情報の道に押し場所が足りない: ${n}`);
    // コピーは押しても外へ出ない。押して、文言が変わる（できた・できない、どちらでも言う）。
    const copy = p.locator('#infoRows .path-actions button').filter({ hasText: 'コピー' }).first();
    await copy.click();
    await p.waitForTimeout(300);
    const said = (await copy.innerText()).trim();
    if (said === 'コピー') throw new Error('押しても何も言わない');
  } finally {
    await closeSettings();
  }
});

// 配置の切り替え。板の並びが実際に変わるか。
await check('配置を切り替える', async () => {
  try {
    await p.locator('#openSettings').click();
    await p.waitForTimeout(700);
    await p.locator('.tabs-lite button[data-sec="place"]').click();
    await p.waitForTimeout(500);
    const ids = await p.locator('#presets option').evaluateAll((els) => els.map((e) => e.value));
    if (ids.length === 0) throw new Error('型の選択肢が空');
    const now = await p.locator('#presets').inputValue();
    const other = ids.find((v) => v !== now);
    if (!other) throw new Error('選べる型が一つしかない');
    // **形そのものを見る。**パネルの数だけだと、数が同じで並びだけ違う二つの型
    // （エディタ中心と会話中心）を「変わっていない」と読む（実際にそう出た）。
    const shape = () => p.evaluate(() => fetch('/api/layout').then((r) => r.json()).then((j) => JSON.stringify(j.layout.root)));
    const before = await shape();
    await p.selectOption('#presets', other);
    await p.waitForTimeout(1000);
    const after = await shape();
    if (await p.locator('#root .panel').count() === 0) throw new Error('板が一つも無くなった');
    if (before === after) throw new Error(`選んでも並びが変わらない: ${now} → ${other}`);
  } finally {
    await closeSettings();
  }
  // 会話の板は、どの並びでも要る。無いと何も打てない。
  if (!(await p.locator('.chat textarea').isVisible())) throw new Error('会話の入力欄が消えた');
});

// 外の道具。合言葉を入れて繋ぎ、**値が画面に残らない**ことまで見る。
await check('見本帳から GitHub を繋ぐ', async () => {
  try {
    await p.locator('#openSettings').click();
    await p.waitForTimeout(700);
    await p.locator('.tabs-lite button[data-sec="mcp"]').click();
    await p.waitForTimeout(900);
    const cards = await p.locator('#mcpCatalog .mcp-card').count();
    if (cards === 0) throw new Error('見本帳が空');
    const card = p.locator('#mcpCatalog .mcp-card').filter({ hasText: 'GitHub' }).first();
    const field = card.locator('input[type="password"]').first();
    await field.fill('ghp_sweep_dummy');
    await card.locator('button.primary').click();
    await p.waitForTimeout(1800);
    const note = await p.locator('#ghNote').innerText();
    if (!note.includes('設定に書きました')) throw new Error(`繋げていない: ${note.slice(0, 100)}`);
    // **入れた値を画面に残さない。**
    const left = await card.locator('input[type="password"]').first().inputValue();
    if (left !== '') throw new Error('合言葉が入力欄に残っている');
    const rows = await p.locator('#mcpRows').innerText();
    if (!rows.includes('github')) throw new Error('一覧に出ていない');
    if (rows.includes('ghp_sweep_dummy')) throw new Error('合言葉が画面に出ている');
    if ((await p.locator('#mcpCatalog').innerText()).includes('ghp_sweep_dummy')) {
      throw new Error('合言葉が見本帳に出ている');
    }
  } finally {
    await closeSettings();
  }
});

// 添付。落とす・貼る・選ぶ、どれでも渡せると謳っているので、実際に渡す。
await check('ファイルを添えて外す', async () => {
  const picker = p.locator('.chat input[type="file"]');
  await picker.setInputFiles({ name: 'メモ.txt', mimeType: 'text/plain', buffer: Buffer.from('中身です') });
  await p.waitForTimeout(1200);
  const tray = p.locator('.chat .attachments');
  if (!(await tray.isVisible())) throw new Error('添えたものが出ない');
  if (!(await tray.innerText()).includes('メモ.txt')) throw new Error('名前が出ない');
  // 外せること。外せないと、間違えて添えたものを送るしかなくなる。
  const drop = tray.locator('button').first();
  if (await drop.count() === 0) throw new Error('外すものが無い');
  await drop.click();
  await p.waitForTimeout(600);
  if (await tray.isVisible()) throw new Error('外しても残る');
});

// 中断。押せるのに効かない、を作らない。
await check('中断できる', async () => {
  // 中断も入力欄の中（送るの隣）。外に浮かせない。
  const stop = p.locator('.chat .field button[title="中断"]');
  if (await stop.count() === 0) throw new Error('中断が無い');
  // 動いていないときは、そもそも出ていないこと。
  // **押せないものを出しておかない。**邪魔なだけで、押して何も起きないと戸惑う。
  if (await stop.isVisible()) throw new Error('動いていないのに中断が出ている');

  /*
   * **押して、止まるところまで見る。**
   *
   * ここは「在ること」と「動いていないときは出ていないこと」しか見ていなかった。
   * 押していないので、押しても何も起きない形をそのまま通す。
   * モデルが無い回は動かせないので、そこは見ない（見られないものは見ない）。
   */
  if (noModel) return;
  await p.locator('.chat textarea').fill('長めに考えてください');
  await p.locator('.chat textarea').press('Enter');
  await p.waitForFunction(() => document.getElementById('run')?.dataset.state === 'busy', null, { timeout: 30000 });
  if (!(await stop.isVisible())) throw new Error('動いているのに中断が出ていない');
  await stop.click();
  await p.waitForFunction(() => document.getElementById('run')?.dataset.state !== 'busy', null, { timeout: 30000 });
  if (await stop.isVisible()) throw new Error('止めたのに中断が出たまま');
});

await check('空の区画を出さない', async () => {
  /*
   * **到達しない条件を見ていた。**
   *
   * `style.css` に `[hidden] { display: none !important; }` が在るので、
   * `hidden` を持つ節が `isVisible()` になることは起こり得ない。つまり
   * 「隠したはずが出ている」は一度も成り立たない。
   * 本当の壊れ方は逆で、**`hidden` を立て忘れて空のまま出す**こと。
   * 出ているなら中身が在ること、を見る。
   */
  for (const id of ['unfinishedSec', 'queue']) {
    const box = p.locator(`#${id}`);
    if (await box.count() === 0) continue;
    if (!(await box.isVisible())) continue;
    const said = (await box.innerText()).trim();
    if (said.length === 0) throw new Error(`空のまま出ている: #${id}`);
  }
});

await check('同じことを二度言わない', async () => {
  // 「待機中」を板のいちばん上と下の帯の両方に出していた。
  const said = (await p.locator('body').innerText()).split('\n').map((l) => l.trim());
  const idle = said.filter((l) => l === '待機中').length;
  if (idle > 1) throw new Error(`同じ表示が ${idle} 箇所に出ている`);
});

// 立ち上げ直す。この入口は起こし直せないので、断る言葉が出ること。
await check('立ち上げ直しは、できないならそう言う', async () => {
  expectingRefusal = true;
  const r = await p.evaluate(async () => {
    const res = await fetch('/api/restart', { method: 'POST' });
    return { status: res.status, body: await res.text() };
  });
  // 断りの知らせは少し遅れて届く。届き切ってから聞き耳を戻す。
  await p.waitForTimeout(300);
  expectingRefusal = false;
  if (r.status === 200) return; // 起こし直せる入口なら、それでよい
  if (![409, 501].includes(r.status)) throw new Error(`思わぬ返事: ${r.status} ${r.body.slice(0, 80)}`);
  if (!r.body.includes('error')) throw new Error('断る理由が無い');
});

await check('作業場を開く', async () => {
  /*
   * **空かどうかは、文で見る。**案内の一言も `button` なので、数で見ると
   * 空のときまで「中身が在る」側に入ってしまう（実際に入った）。
   */
  const note = (await p.locator('#sideFiles').innerText()).trim();
  const empty = note.includes('ここは空です');
  const dirs = p.locator('#sideFiles button');
  if (!empty && await dirs.count() > 0) {
    /*
     * **押したあと、何も確かめずに返っていた。**
     *
     * 押しても何も起きない形をそのまま通す。押した結果が画面に出ること
     * （開いた先の中身か、少なくとも一つ下がったこと）まで見る。
     */
    /*
     * **「パネルが在る」で満たさない。**エディタのパネルは開いていなくても在るので、
     * `.editor` の数を見ると、押しても開かない形が素通りする（一度そう書いた）。
     * 見るのは**中身が変わったか**。一覧が降りるか、開いた先の名前が出るか。
     */
    const shown = async () => `${(await p.locator('#sideFiles button').allInnerTexts()).join('|')}`
      + `##${await p.locator('#root').innerText()}`;
    const before = await shown();
    await dirs.first().click();
    await p.waitForTimeout(1000);
    if (await shown() === before) throw new Error('押しても何も起きない');
    return;
  }
  // **空でもよい。ただし黙るのは駄目。**
  // 入れた直後は作業場が空になる（根の下の work）。そこで正しいが、
  // 何も出ないと壊れているようにしか見えない。何の場所で、どう変えるかを言うこと。
  const said = (await p.locator('#sideFiles').innerText()).trim();
  if (said.length === 0) throw new Error('作業場が空なのに、何も言っていない');
  /*
   * **言葉で合わせない。押して、変える口が開くところを見る。**
   *
   * ここは案内が「設定」という語を含むことを見ていた。語が消えたときに落ちたが、
   * 消したのは正しい（設定→モデルに「フォルダ」は無く、**無い場所を案内していた**）。
   * 語を見ている限り、正しい直しで落ちて、案内が的外れでも通る。
   *
   * 見るのは、案内そのものと横の 📂 の**どちらからでも**、その場で変える口が
   * 開くこと。打ち込む所を出させるだけで、変えはしない（この確かめの後ろで、
   * 別の場所を見にいくものが続く）。
   */
  const opened = [];
  const answer = async (d) => { opened.push(d.type()); await d.dismiss(); };
  p.on('dialog', answer);
  try {
    const note = p.locator('#sideFiles .side-empty');
    if (await note.count() === 0) throw new Error(`空のときの案内が、押せる形をしていない: ${said.slice(0, 60)}`);
    await note.click();
    await p.locator('#pickWork').click();
    await p.waitForTimeout(300);
  } finally { p.off('dialog', answer); }
  const prompts = opened.filter((kind) => kind === 'prompt').length;
  if (prompts < 2) {
    throw new Error(`空だが、その場で変えられない（開いた口: ${opened.join('|') || 'なし'}）`);
  }
});

/*
 * **初めて開いた人が、一押しで始められるか。**
 *
 * モデルを置いていない状態がいちばん多い形で、そこで出るのがこの一手。
 * ここまで確かめていたのは「`app.js` に `canFetch` の字が在る」だけだった。
 * 字が在ることは、押し場所が出ることも、押して何かが起きることも言わない。
 *
 * **取ってくるものは、本物を落とさない。**数GBになる。口を横取りして、
 * 頼みが飛んだことと、押し場所の文が変わることで見る。
 */
if (noModel) {
  await check('モデルが無いとき、一押しで取ってこられる', async () => {
    const note = p.locator('#crashNote');
    if (await note.count() === 0) throw new Error('話せないことを言っていない');
    const said = await note.innerText();
    if (!said.includes('まだ話せません')) throw new Error(`言い方が違う: ${said.slice(0, 60)}`);
    const button = note.locator('.crash-action');
    if (await button.count() === 0) throw new Error('一押しで取ってくる所が無い');
    const label = (await button.innerText()).trim();
    if (!/取ってくる/.test(label)) throw new Error(`押し場所の文が違う: ${label}`);
    if (!/GB/.test(label)) throw new Error(`どれだけ落とすかを言っていない: ${label}`);

    // 口を横取りする。本物は落とさない。
    let asked = 0;
    await p.route('**/api/models/get', async (route) => {
      asked += 1;
      await route.fulfill({
        status: 200, contentType: 'application/json', body: JSON.stringify({ started: true }),
      });
    });
    try {
      await button.click();
      await p.waitForTimeout(600);
      if (asked === 0) throw new Error('押しても取ってこようとしない');
      const after = (await button.innerText()).trim();
      if (!/取ってきています/.test(after)) throw new Error(`押したことが見えない: ${after}`);
    } finally {
      await p.unroute('**/api/models/get');
      // 元の姿に戻す（この後の確かめが、この帯に邪魔されないように畳む）。
      await p.reload({ waitUntil: 'load' });
      await opened();
      await p.waitForTimeout(600);
    }
  });
}

await check('取ってくる先を、自分で打てる', async () => {
  // カタログはこちらが書いた見当で、配布元の名前は変わる（消えることもある）。
  // **打つ道が無いと、見当が外れた時点で利用者は詰む。**
  try {
    await p.locator('#openSettings').click();
    await p.waitForTimeout(700);
    await p.locator('.tabs-lite button[data-sec="model"]').click();
    await p.waitForTimeout(700);
    if (await p.locator('#cfgRepo').count() === 0) throw new Error('取ってくる先を打つ所が無い');
    if (await p.locator('#cfgGetRepo').count() === 0) throw new Error('打ったものを取るつまみが無い');
  } finally { await closeSettings(); }
});

await check('置いたものを読み直せる', async () => {
  /*
   * 取ってこられなかったときの逃げ道。
   *
   * 配布元の名前は変わるし、会社の PC はブラウザでしか落とせない。
   * 落として置き場に入れたあと、拾い直す押し場所が要る。
   * **案内の文がこの押し場所を指しているので、無ければ案内が嘘になる。**
   * 実際に無いまま案内していた。
   */
  // 出ていなければ「表示」から出す。出ていれば、その板を前に出す。
  const shown = async () => (await p.locator('#root .panel header, #root .panel.tabs header button')
    .allInnerTexts()).some((h) => h.includes('モデル'));
  if (!(await shown())) {
    await p.locator('#openView').click();
    await p.waitForTimeout(500);
    const row = p.locator('#viewList .view-row').filter({ hasText: 'モデル' }).first();
    if (await row.count() === 0) throw new Error('表示の一覧にモデルが無い');
    await row.locator('input').click();
    await p.waitForTimeout(700);
    await p.keyboard.press('Escape');
    await p.waitForTimeout(400);
  }
  // 束ねられているときは、その見出しを押して前に出す。
  const tab = p.locator('#root .panel.tabs header button').filter({ hasText: 'モデル' });
  if (await tab.count() > 0) { await tab.first().click(); await p.waitForTimeout(400); }
  await p.waitForTimeout(1200);
  const again = p.locator('button').filter({ hasText: '置いたものを読み直す' });
  if (await again.count() === 0) throw new Error('置いたものを読み直す押し場所が無い');

  /*
   * **押した結果を見る。**
   *
   * ここは「押したあとも押し場所が残っている」しか見ていなかった。
   * 押しても何もしない形をそのまま通す。保存先へ一つ置いてから押し、
   * **その名前が出てくるところ**まで見る。置いたものは最後に片づける。
   */
  const info = await p.evaluate(() => fetch('/api/info').then((r) => r.json()));
  const at = `${info.modelsDir}/sweep-probe.gguf`;
  const { writeFile, rm, mkdir } = await import('node:fs/promises');
  // 置き先がまだ無いことがある（入れた直後・一時の場所）。作ってから置く。
  await mkdir(info.modelsDir, { recursive: true });
  await writeFile(at, 'GGUF');
  try {
    await again.first().click();
    await p.waitForTimeout(1200);
    const shown = await p.locator('#root').innerText();
    if (!shown.includes('sweep-probe.gguf')) throw new Error('押しても、置いたものが出てこない');
  } finally {
    await rm(at, { force: true });
  }
  // 押したあとも、押し場所が残っていること（一度きりにならない）。
  if (await p.locator('button').filter({ hasText: '置いたものを読み直す' }).count() === 0) {
    throw new Error('一度押すと消える');
  }
});

await check('作業場は、作業場の所で変える', async () => {
  // **その区画を操るものは、その区画に置く。**
  // 設定の奥（モデルの頁）に置いていたので、誰も辿り着けなかった。
  if (await p.locator('#pickWork').count() === 0) throw new Error('作業場を変えるつまみが無い');
  if (!(await p.locator('#pickWork').isVisible())) throw new Error('つまみが見えない');
  // いまどこを触っているかが、常に出ていること。
  const now = (await p.locator('#workNow').innerText()).trim();
  if (now.length === 0) throw new Error('いまどこを触っているのかが出ていない');

  /*
   * **押して、変わるところまで見る。**
   *
   * ここは在ること・見えること・文字が空でないことしか見ていなかった。
   * 押していないので、押しても何も起きない形をそのまま通す。
   * 新しい場所を打ち込んで、出ている場所が変わることを見る。
   */
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  /*
   * **戻す先は、画面の表示から取らない。**`#workNow` は道を省略して出すうえ、
   * 「開く」「コピー」の文字も混ざる。それを打ち直すと、**在りもしない場所を
   * 作業場にしてしまう**（実際にそうした）。本体に訊く。
   */
  const cfg = await p.evaluate(() => fetch('/api/config').then((r) => r.json()));
  const wasAt = String(cfg.workRootNow ?? '');
  if (!wasAt) throw new Error('いまの作業場が本体から取れない');
  const want = await mkdtemp(join(tmpdir(), 'aas-sweep-work-'));
  const type = (text) => (d) => { d.accept(text).catch(() => undefined); };
  const move = async (to) => {
    const answer = type(to);
    p.on('dialog', answer);
    try {
      await p.locator('#pickWork').click();
      await p.waitForTimeout(1500);
    } finally { p.off('dialog', answer); }
    return (await p.locator('#workNow').innerText()).trim();
  };
  await move(want);
  /*
   * **変わったかどうかは、本体に訊く。**
   *
   * ここは `#workNow` の字と道の末尾を突き合わせていた。二つ壊れていて、
   * どちらも Windows でだけ出た。道の区切りを `/` と決め打っていたので
   * 末尾が取れず、そのうえ `#workNow` は長い道を**途中を省いて**出すので、
   * 先頭の一字が欠けて当たらない（`…as-sweep-work-xxxx`）。
   * 走らせる場所で結果が変わる確かめになっていた。
   */
  const moved = await p.evaluate(() => fetch('/api/config').then((r) => r.json()));
  if (String(moved.workRootNow ?? '') !== want) {
    throw new Error(`押しても変わらない: ${String(moved.workRootNow).slice(0, 80)} / 入れたのは ${want}`);
  }
  // 画面にも出ていること（本体だけ変わって、見た目が前のまま、を作らない）。
  // **末尾だけを見る。**`#workNow` は長い道の途中を省くので、頭は当てにできない。
  const shown = (await p.locator('#workNow').innerText()).trim();
  const tail = want.slice(-10);
  if (!shown.includes(tail)) {
    throw new Error(`画面が前のまま: ${shown.slice(0, 80)} / 入れたのは ${want}`);
  }
  /*
   * **元へ戻す。**戻さないと、次に回したときの作業場が空になり、
   * 前のほうの確かめ（作業場を開く）が別の道を通る。
   * **走らせるたびに結果が変わる確かめを、自分で作らない。**
   */
  await move(wasAt);
  const again = await p.evaluate(() => fetch('/api/config').then((r) => r.json()));
  if (String(again.workRootNow ?? '') !== wasAt) {
    throw new Error(`元へ戻せていない: ${String(again.workRootNow).slice(0, 80)}`);
  }
});

await check('コマンドと設定が、手の届く所に在る', async () => {
  // コマンドは書く手の隣、設定は板のいちばん上（≡ の横）。
  const cmd = p.locator('.chat .field button[title^="コマンド"]');
  if (await cmd.count() === 0) throw new Error('コマンドが入力欄に無い');
  const gear = p.locator('.side-top #openSettings');
  if (await gear.count() === 0) throw new Error('設定が ≡ の横に無い');
  // 板の途中の並びには置かない（会話や作業場と同じ重さに見える）。
  if (await p.locator('.side-nav').count() > 0) throw new Error('板の途中の並びが残っている');
});

/*
 * **見た目の不具合は、測って見つける。**
 *
 * コードを読んでいるだけでは出てこなかったものを、ここで押さえる。
 * どれも実機の画面で先に見つかっていて、試験は通ったままだった。
 */
await check('横の一覧の行が、潰れていない', async () => {
  /*
   * 横に並べた箱なので、入りきらない分を flex が各行から削る。
   * フォルダの行が高さ 8px まで潰れ、字が切れて**空白の帯**に見えた（実測）。
   *
   * 高さだけを見ると、**その場のファイルの数で結果が変わる**（溢れなければ
   * 潰れない）。走らせる場所で変わる確かめにしないため、削る設定そのものを見る。
   */
  const found = await p.locator('#sideFiles > *').evaluateAll((els) => els.map((e) => ({
    shrink: getComputedStyle(e).flexShrink,
    h: Math.round(e.getBoundingClientRect().height),
    t: (e.innerText || '').slice(0, 16),
  })));
  if (found.length === 0) throw new Error('横の一覧が空');
  const shrinking = found.filter((f) => f.shrink !== '0');
  if (shrinking.length > 0) throw new Error(`縮む行が ${shrinking.length} 本ある（flex-shrink が 0 でない）`);
  const squashed = found.filter((f) => f.h > 0 && f.h < 16);
  if (squashed.length > 0) throw new Error(`潰れた行がある: ${squashed.map((f) => `${f.t}(${f.h}px)`).join(', ')}`);
});

await check('パネルとパネルのあいだが、空きすぎていない', async () => {
  // 隙間（gap）と掴むつまみを別に持っていて、10 + 8 + 10 = 28px 空いていた。
  const gaps = await p.locator('#root .split').evaluateAll((splits) => {
    const out = [];
    for (const s of splits) {
      const kids = [...s.children].filter((e) => !e.classList.contains('grip'));
      const row = !s.classList.contains('column');
      for (let i = 1; i < kids.length; i += 1) {
        const a = kids[i - 1].getBoundingClientRect();
        const b = kids[i].getBoundingClientRect();
        out.push(Math.round(row ? b.x - (a.x + a.width) : b.y - (a.y + a.height)));
      }
    }
    return out;
  });
  const wide = gaps.filter((g) => g > 16);
  if (wide.length > 0) throw new Error(`パネルの隙間が広すぎる: ${wide.join(', ')}px`);
});

await check('設定の欄が、行の幅まで伸びている', async () => {
  // 道を入れる欄が 196px しかなく、610px の行の中で中身が読めなかった。
  await p.locator('#openSettings').click();
  await p.waitForTimeout(600);
  // **出ている頁を見る。**開いた直後は「情報」で、そこに入れる欄は無い。
  // 見に行かずに「不具合なし」と言っていた（わざとバグを入れて気づいた）。
  await p.locator('dialog button', { hasText: 'モデル' }).first().click();
  await p.waitForTimeout(800);
  const rowCount = await p.locator('dialog .field-row:visible').count();
  if (rowCount === 0) throw new Error('設定のモデルの頁に、入れる欄が一つも無い');
  const bad = await p.locator('dialog .field-row').evaluateAll((rows) => {
    const out = [];
    for (const r of rows) {
      if (r.hidden || r.getBoundingClientRect().width === 0) continue;
      const input = r.querySelector('input[type="text"], select');
      if (!input) continue;
      const rw = r.getBoundingClientRect().width;
      const iw = input.getBoundingClientRect().width;
      if (iw < rw * 0.5) out.push(`${r.innerText.split('\n')[0]}: ${Math.round(iw)}/${Math.round(rw)}px`);
      // 見出しが折れていないこと（「動かし方」が「動かし / 方」になっていた）。
      const label = r.querySelector('span, label');
      if (label && label.getBoundingClientRect().height > 30) out.push(`見出しが折れている: ${label.innerText}`);
    }
    return out;
  });
  await p.keyboard.press('Escape');
  await p.waitForTimeout(300);
  if (bad.length > 0) throw new Error(bad.join(' / '));
});

/*
 * **直している最中に書き換えられたら、そう言う。**
 *
 * 画面で直している（保存していない）ファイルを AI が書くと、ファイルは AI の版、
 * 欄は人の版、と二つに割れる。ここまでは**何も言わずに人の版を出し続けて**
 * いたので、先に保存した方が相手を消していた。出来事を流して、帯が出て、
 * 押せば入れ替わり、**押し間違えても戻せる**ところまで見る。
 *
 * 試すファイルはここで作って、最後に消す（人のファイルは触らない）。
 */
await check('直している最中に書き換えられたら、そう言う', async () => {
  const at = 'sweep-notice-probe.txt';
  const put = (content) => p.evaluate(([path, body]) => fetch('/api/file', {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, content: body }),
  }).then((r) => r.status), [at, content]);
  const made = await put('はじめ\n');
  if (made !== 200) throw new Error(`試すファイルを作れない（${made}）`);
  try {
    // 横の一覧から開く。出来事で一覧は読み直されるが、念のため少し待つ。
    await p.waitForTimeout(900);
    const row = p.locator('#sideFiles button').filter({ hasText: at }).first();
    if (await row.count() === 0) throw new Error('作ったファイルが一覧に出ない');
    await row.click();
    await p.waitForTimeout(900);
    const area = p.locator('.editor-area');
    if (await area.count() === 0) throw new Error('エディタが出ない');
    // 保存しないで直す。
    await area.fill('人が書いた\n');
    await p.waitForTimeout(300);
    // ここで AI が書いた、という状況を作る（stamp を送らないので本体は書く）。
    await put('AI が書いた\n');
    await p.waitForTimeout(1200);
    const notice = p.locator('.editor-notice');
    if (await notice.count() === 0 || await notice.isHidden()) throw new Error('書き換えられたのに、何も出ていない');
    const said = await notice.innerText();
    if (!said.includes('書き換えました')) throw new Error(`言い方が違う: ${said.slice(0, 60)}`);
    if (await area.inputValue() !== '人が書いた\n') throw new Error('直している欄を上書きしている');
    // 押すと入れ替わり、押し間違えても戻せる。
    await notice.locator('button', { hasText: 'AI の版を出す' }).first().click();
    await p.waitForTimeout(700);
    if (await area.inputValue() !== 'AI が書いた\n') throw new Error('押しても入れ替わらない');
    await notice.locator('button', { hasText: '自分の直しに戻す' }).first().click();
    await p.waitForTimeout(500);
    if (await area.inputValue() !== '人が書いた\n') throw new Error('預かった直しが戻らない');
  } finally {
    const { rm } = await import('node:fs/promises');
    // 画面の字からではなく、本体が答える道を使う（画面の字は省略されることがある）。
    const root = await p.evaluate(() => fetch('/api/config').then((r) => r.json()).then((c) => c.workRootNow))
      .catch(() => '');
    if (root) await rm(`${root}/${at}`, { force: true }).catch(() => undefined);
  }
});

/*
 * **見出しに、長い文を流し込まない。**
 *
 * 補完が出せない理由（「…に GGUF がありません。設定 → モデル に…」）を
 * そのままエディタの見出しに入れていた。見出しは 3 行に折れ、**ファイル名が
 * 47px まで潰れて**「head-pro…」になり、保存の押し場所まで二段になっていた（実測）。
 *
 * ここは**返ってくるものを決めてから**見る（モデルが在る機械では補完が返って
 * しまい、走らせる場所で結果が変わるため）。
 */
await check('エディタの見出しが、長い文で潰れない', async () => {
  const at = 'sweep-head-probe.txt';
  const made = await p.evaluate(([path]) => fetch('/api/file', {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, content: 'const x = 1;\n' }),
  }).then((r) => r.status), [at]);
  if (made !== 200) throw new Error(`試すファイルを作れない（${made}）`);
  const why = 'C:/どこか/長い/道/models に GGUF がありません。設定 → モデル に、いま見ている保存先が出ています。そこへ .gguf を1つ置いてください。';
  await p.route('**/api/complete', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: '', why }) });
  });
  try {
    await p.waitForTimeout(900);
    const row = p.locator('#sideFiles button').filter({ hasText: at }).first();
    if (await row.count() === 0) throw new Error('作ったファイルが一覧に出ない');
    await row.click();
    await p.waitForTimeout(900);
    const area = p.locator('.editor-area');
    if (await area.count() === 0) throw new Error('エディタが出ない');
    // 行の終わりで手を止めると、補完を訊きに行く（行の途中では出さない作り）。
    await area.click();
    await area.press('End');
    await area.type(' ');
    await p.waitForTimeout(2500);
    const got = await p.evaluate(() => {
      const head = document.querySelector('.editor-head');
      const name = head.querySelector('.editor-name');
      const notice = document.querySelector('.editor-notice');
      return {
        headH: Math.round(head.getBoundingClientRect().height),
        nameW: Math.round(name.getBoundingClientRect().width),
        nameNeeds: Math.round(name.scrollWidth),
        said: head.querySelector('.editor-state').textContent,
        notice: notice && !notice.hidden ? notice.innerText : '',
      };
    });
    // 見出しは一行のまま（折れると 50px を超える）。
    if (got.headH > 40) throw new Error(`見出しが折れている（${got.headH}px）: ${got.said.slice(0, 40)}`);
    if (got.nameW + 1 < got.nameNeeds) throw new Error(`ファイル名が潰れている（${got.nameW}/${got.nameNeeds}px）`);
    if (!got.notice.includes('GGUF がありません')) throw new Error(`理由がどこにも出ていない: ${got.said.slice(0, 40)}`);
  } finally {
    await p.unroute('**/api/complete');
    const { rm } = await import('node:fs/promises');
    const root = await p.evaluate(() => fetch('/api/config').then((r) => r.json()).then((c) => c.workRootNow)).catch(() => '');
    if (root) await rm(`${root}/${at}`, { force: true }).catch(() => undefined);
  }
});

/*
 * **続けて二度、保存できる。**
 *
 * 本体は書けたときに新しい stamp を返していなかったので、画面は開いたときの
 * stamp を持ったままになり、**二度目の保存が「別の所で変わりました（AI の
 * 書き換えなど）」で断られていた**（実測）。直すたびに押し直させることになる。
 * 自分の書き込みの写しで「AI が書き換えました」と出ていたのも、同じ場面。
 */
await check('続けて二度、保存できる', async () => {
  const at = 'sweep-twice-probe.txt';
  const made = await p.evaluate(([path]) => fetch('/api/file', {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, content: 'one\ntwo\n' }),
  }).then((r) => r.status), [at]);
  if (made !== 200) throw new Error(`試すファイルを作れない（${made}）`);
  try {
    await p.waitForTimeout(900);
    const row = p.locator('#sideFiles button').filter({ hasText: at }).first();
    if (await row.count() === 0) throw new Error('作ったファイルが一覧に出ない');
    await row.click();
    await p.waitForTimeout(900);
    const area = p.locator('.editor-area');
    const state = p.locator('.editor-state').first();
    const notice = p.locator('.editor-notice').first();
    for (const mark of ['X', 'Y']) {
      await area.click();
      await area.press('End');
      await area.type(mark);
      await area.press('Control+s');
      await p.waitForFunction(() => /保存しました|保存していません/.test(
        document.querySelector('.editor-state')?.textContent ?? ''), null, { timeout: 15000 });
      const said = (await state.textContent()) ?? '';
      if (!said.startsWith('保存しました')) throw new Error(`${mark} で保存できていない: ${said}`);
      const band = await notice.isHidden() ? '' : await notice.innerText();
      if (/AI がこのファイルを書き換えました/.test(band)) {
        throw new Error(`自分の保存で、書き換えられたと言っている（${mark}）: ${band.replace(/\n/g, ' / ')}`);
      }
      await p.waitForTimeout(400);
    }
  } finally {
    const { rm } = await import('node:fs/promises');
    const root = await p.evaluate(() => fetch('/api/config').then((r) => r.json()).then((c) => c.workRootNow)).catch(() => '');
    if (root) await rm(`${root}/${at}`, { force: true }).catch(() => undefined);
  }
});

/*
 * **全部置き換えたあと、Ctrl+Z で戻せる。**
 *
 * 置き換えを欄への丸ごと代入で書いていたので、ブラウザの戻し履歴が消えていた。
 * 押した人は置換の前に戻せない（取り返しがつかない）。戻せるかどうかはブラウザの
 * 中に在るので、**実際に Ctrl+Z を押して見る**。
 */
await check('全部置き換えたあと、Ctrl+Z で戻せる', async () => {
  const at = 'sweep-undo-probe.txt';
  const first = 'const a = 1;\nconst b = 2;\n';
  const made = await p.evaluate(([path, content]) => fetch('/api/file', {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, content }),
  }).then((r) => r.status), [at, first]);
  if (made !== 200) throw new Error(`試すファイルを作れない（${made}）`);
  try {
    await p.waitForTimeout(900);
    const row = p.locator('#sideFiles button').filter({ hasText: at }).first();
    if (await row.count() === 0) throw new Error('作ったファイルが一覧に出ない');
    await row.click();
    await p.waitForTimeout(900);
    const area = p.locator('.editor-area');
    await area.click();
    await area.press('Control+f');
    await p.locator('.find-q').fill('const');
    await p.locator('.find-r').fill('let');
    await p.locator('.editor-find button').filter({ hasText: '全部' }).first().click();
    await p.waitForFunction(() => /let a = 1;/.test(document.querySelector('.editor-area')?.value ?? ''),
      null, { timeout: 5000 });
    // **手を戻さずに押す。**置き換えた側が欄へ手を戻しているはずで、
    // そこがずれていると Ctrl+Z は探す欄の戻しになる（ここで落ちてよい）。
    await area.press('Control+z');
    await p.waitForTimeout(300);
    const now = await area.inputValue();
    if (now !== first) throw new Error(`Ctrl+Z で置換の前に戻れない: ${JSON.stringify(now)}`);
  } finally {
    const { rm } = await import('node:fs/promises');
    const root = await p.evaluate(() => fetch('/api/config').then((r) => r.json()).then((c) => c.workRootNow)).catch(() => '');
    if (root) await rm(`${root}/${at}`, { force: true }).catch(() => undefined);
  }
});

/*
 * **数行を選んで Tab で字下げしたあとも、Ctrl+Z で戻せる。**
 *
 * 字下げも `execCommand('insertText')` で書くように変えた。改行を含む字を
 * 一度で入れる形なので、**本物のブラウザで行が崩れないこと**まで見ておく。
 */
await check('数行の字下げを、Ctrl+Z で戻せる', async () => {
  const at = 'sweep-indent-probe.txt';
  const first = 'one\ntwo\nthree\n';
  const made = await p.evaluate(([path, content]) => fetch('/api/file', {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, content }),
  }).then((r) => r.status), [at, first]);
  if (made !== 200) throw new Error(`試すファイルを作れない（${made}）`);
  try {
    await p.waitForTimeout(900);
    const row = p.locator('#sideFiles button').filter({ hasText: at }).first();
    if (await row.count() === 0) throw new Error('作ったファイルが一覧に出ない');
    await row.click();
    await p.waitForTimeout(900);
    const area = p.locator('.editor-area');
    await area.click();
    // 1〜2 行目（one\ntwo）を選ぶ。
    await p.evaluate(() => { const t = document.querySelector('.editor-area'); t.focus(); t.setSelectionRange(0, 7); });
    await area.press('Tab');
    await p.waitForTimeout(300);
    const after = await area.inputValue();
    if (after !== '  one\n  two\nthree\n') throw new Error(`字下げになっていない: ${JSON.stringify(after)}`);
    await area.press('Control+z');
    await p.waitForTimeout(300);
    const undone = await area.inputValue();
    if (undone !== first) throw new Error(`Ctrl+Z で字下げの前に戻れない: ${JSON.stringify(undone)}`);
  } finally {
    const { rm } = await import('node:fs/promises');
    const root = await p.evaluate(() => fetch('/api/config').then((r) => r.json()).then((c) => c.workRootNow)).catch(() => '');
    if (root) await rm(`${root}/${at}`, { force: true }).catch(() => undefined);
  }
});

/*
 * **出していない分を、黙って隠さない。**
 *
 * 横の一覧は多すぎると切る（開くのが重くなるため）。切ったことを言わないので、
 * 5000 件のフォルダでは 400 件だけ出て、**残りは無いように見えていた**（実測）。
 */
await check('多いフォルダでは、出していない分を言う', async () => {
  const { mkdir, writeFile, rm } = await import('node:fs/promises');
  const root = await p.evaluate(() => fetch('/api/config').then((r) => r.json()).then((c) => c.workRootNow));
  if (!root) throw new Error('作業場が分からない');
  const dir = `${root}/sweep-many-probe`;
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  await mkdir(dir, { recursive: true });
  try {
    // 上限（400）を超える数を置く。
    for (let i = 0; i < 420; i += 1) {
      await writeFile(`${dir}/f${String(i).padStart(4, '0')}.txt`, 'x');
    }
    await p.reload({ waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(1500);
    const folder = p.locator('#sideFiles button').filter({ hasText: 'sweep-many-probe' }).first();
    if (await folder.count() === 0) throw new Error('作ったフォルダが一覧に出ない');
    await folder.click();
    await p.waitForTimeout(1200);
    const text = await p.locator('#sideFiles').innerText();
    if (!/ほかに \d+ 件/.test(text)) {
      throw new Error(`切ったことを言っていない: ${JSON.stringify(text.slice(-160))}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    // 根へ戻しておく（後の確かめが、このフォルダの中を見ないように）。
    await p.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
    await p.waitForTimeout(1200);
  }
});

/*
 * **開いているファイルをもう一度押して、書きかけを消さない。**
 *
 * 読み直しを飛ばすのは「直していないとき」だけだった。直している最中に同じ
 * ファイルを開き直すと、ディスクの中身で欄を上書きしていた。横の一覧で同じ
 * 行をもう一度押すのも、AI に `show_file` で開かせるのも、同じ道を通る。
 */
await check('開いているファイルをもう一度押しても、書きかけが消えない', async () => {
  const at = 'sweep-reopen-probe.txt';
  const made = await p.evaluate(([path]) => fetch('/api/file', {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, content: 'one\ntwo\n' }),
  }).then((r) => r.status), [at]);
  if (made !== 200) throw new Error(`試すファイルを作れない（${made}）`);
  try {
    await p.waitForTimeout(900);
    const row = p.locator('#sideFiles button').filter({ hasText: at }).first();
    if (await row.count() === 0) throw new Error('作ったファイルが一覧に出ない');
    await row.click();
    await p.waitForTimeout(900);
    const area = p.locator('.editor-area');
    if (await area.count() === 0) throw new Error('エディタが出ない');
    await area.click();
    await area.press('End');
    await area.type('-KAKIKAKE');
    const typed = await area.inputValue();
    if (!typed.includes('KAKIKAKE')) throw new Error(`打てていない: ${JSON.stringify(typed)}`);
    // 同じ行をもう一度押す。
    await row.click();
    await p.waitForTimeout(1500);
    const now = await area.inputValue();
    if (!now.includes('KAKIKAKE')) throw new Error(`書きかけが消えている: ${JSON.stringify(now)}`);
  } finally {
    const { rm } = await import('node:fs/promises');
    const root = await p.evaluate(() => fetch('/api/config').then((r) => r.json()).then((c) => c.workRootNow)).catch(() => '');
    if (root) await rm(`${root}/${at}`, { force: true }).catch(() => undefined);
  }
});

/*
 * **保存したことを、補完の返事で消さない。**
 *
 * 打つと少しあとに続きを訊きに行くので、打ってすぐ保存すると、保存が終わった
 * あとに補完が走る。出す先が同じ一行なので「保存しました（+1 -1）」が
 * 「補完なし」へ化けていた（ここで押して実測）。書けたのかが画面から消える。
 *
 * 返ってくるものは決めてから見る（モデルが在る機械では続きが返ってしまい、
 * 走らせる場所で結果が変わる）。
 */
await check('保存したことが、補完の返事で消えない', async () => {
  const at = 'sweep-save-probe.txt';
  const made = await p.evaluate(([path]) => fetch('/api/file', {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, content: 'one\ntwo\n' }),
  }).then((r) => r.status), [at]);
  if (made !== 200) throw new Error(`試すファイルを作れない（${made}）`);
  await p.route('**/api/complete', async (route) => {
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ text: '', why: 'ここには GGUF がありません。' }),
    });
  });
  try {
    await p.waitForTimeout(900);
    const row = p.locator('#sideFiles button').filter({ hasText: at }).first();
    if (await row.count() === 0) throw new Error('作ったファイルが一覧に出ない');
    await row.click();
    await p.waitForTimeout(900);
    const area = p.locator('.editor-area');
    if (await area.count() === 0) throw new Error('エディタが出ない');
    // 打って、すぐ保存する（補完の予約が入ったまま保存する形）。
    await area.click();
    await area.press('End');
    await area.type('X');
    await area.press('Control+s');
    await p.waitForFunction(
      () => document.querySelector('.editor-state')?.textContent?.startsWith('保存しました') === true,
      null, { timeout: 15000 },
    );
    // 補完が走る時刻（打った 700ms 後）を過ぎても、保存の報せが残っていること。
    await p.waitForTimeout(2500);
    const said = await p.locator('.editor-state').first().textContent();
    if (!/保存しました/.test(said ?? '')) throw new Error(`保存の報せが消えている: ${said}`);
  } finally {
    await p.unroute('**/api/complete');
    const { rm } = await import('node:fs/promises');
    const root = await p.evaluate(() => fetch('/api/config').then((r) => r.json()).then((c) => c.workRootNow)).catch(() => '');
    if (root) await rm(`${root}/${at}`, { force: true }).catch(() => undefined);
  }
});

/*
 * **探した所を、会話へ渡す。**
 *
 * 見つけた行を AI に訊くとき、道と行を打ち直していた（`src/a.ts:120`）。
 * 打ち間違えれば別の所の話になる。探して、押して、**書きかけの指示に入る**
 * ところまで見る。試すファイルはここで作って、最後に消す。
 */
await check('探した所を、依頼に添えられる', async () => {
  const at = 'sweep-search-probe.txt';
  // **この行に、探す言葉そのものを書かない。**書くと、作業場がこの置き所のときに
  // この script 自身が当たり、当たった一件目が試すファイルではなくなる（実際にそうなった）。
  const word = ['sweep', 'Needle', '42'].join('');
  const made = await p.evaluate(([path, w]) => fetch('/api/file', {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, content: `一行目\n${w} を探す\n` }),
  }).then((r) => r.status), [at, word]);
  if (made !== 200) throw new Error(`試すファイルを作れない（${made}）`);
  try {
    // 「探す」を出す。出ていなければ表示から出す。
    const shown = async () => (await p.locator('#root .panel header, #root .panel.tabs header button')
      .allInnerTexts()).some((h) => h.includes('探す'));
    if (!(await shown())) {
      await p.locator('#openView').click();
      await p.waitForTimeout(500);
      const row = p.locator('#viewList .view-row').filter({ hasText: '探す' }).first();
      if (await row.count() === 0) throw new Error('表示の一覧に探すが無い');
      await row.locator('input').click();
      await p.waitForTimeout(700);
      await p.keyboard.press('Escape');
      await p.waitForTimeout(400);
    }
    const tab = p.locator('#root .panel.tabs header button').filter({ hasText: '探す' });
    if (await tab.count() > 0) { await tab.first().click(); await p.waitForTimeout(400); }
    await p.locator('.search-q').first().fill(word);
    await p.locator('.search-head button', { hasText: '探す' }).first().click();
    await p.waitForTimeout(2500);
    // 試すファイルの行を選ぶ（他のファイルが当たっていても、そこを見る）。
    const row = p.locator('.search-hit').filter({ hasText: at }).first();
    if (await row.count() === 0) throw new Error('作ったファイルが当たらない');
    const ask = row.locator('.search-ask').first();
    if (await ask.count() === 0) throw new Error('会話へ渡す押し場所が無い');
    // 書きかけを空にしてから押す（前の確かめが書いたものと混ざらない）。
    await p.locator('.chat textarea').first().fill('');
    await ask.click();
    await p.waitForTimeout(400);
    const said = await p.locator('.chat textarea').first().inputValue();
    if (!said.includes(`${at}:2`)) throw new Error(`会話へ渡っていない: ${JSON.stringify(said)}`);
  } finally {
    await p.locator('.chat textarea').first().fill('').catch(() => undefined);
    const { rm } = await import('node:fs/promises');
    const root = await p.evaluate(() => fetch('/api/config').then((r) => r.json()).then((c) => c.workRootNow)).catch(() => '');
    if (root) await rm(`${root}/${at}`, { force: true }).catch(() => undefined);
  }
});

/*
 * **ブラウザを閉じても、書いたものを失わない。**
 *
 * 保存していない直しの預かりはパネルの中だけに在ったので、**読み直すと消えていた。**
 * 閉じる・押し間違えて再読み込み、で書いたものが消える（保存前なので戻す先も無い）。
 * ここは実際に読み直して、打ったものが戻るところまで見る。
 */
await check('保存していない直しは、読み直しても残る', async () => {
  const at = 'sweep-draft-probe.txt';
  const made = await p.evaluate(([path]) => fetch('/api/file', {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, content: 'はじめ\n' }),
  }).then((r) => r.status), [at]);
  if (made !== 200) throw new Error(`試すファイルを作れない（${made}）`);
  const openProbe = async () => {
    const row = p.locator('#sideFiles button').filter({ hasText: at }).first();
    if (await row.count() === 0) throw new Error('作ったファイルが一覧に出ない');
    await row.click();
    await p.waitForTimeout(900);
  };
  try {
    await p.waitForTimeout(900);
    await openProbe();
    const area = p.locator('.editor-area');
    if (await area.count() === 0) throw new Error('エディタが出ない');
    await area.fill('書きかけ\n');
    // 手が止まってから預ける作りなので、少し待つ。
    await p.waitForTimeout(1200);
    await p.reload({ waitUntil: 'load' });
    await opened();
    await p.waitForTimeout(1500);
    await openProbe();
    const back = await p.locator('.editor-area').inputValue();
    if (back !== '書きかけ\n') throw new Error(`読み直したら消えている: ${JSON.stringify(back)}`);
  } finally {
    // 預かりの鍵は作業場と名前の組（`aas.draft:<作業場>\n<名前>`）。名前で終わる鍵を全部消す
    await p.evaluate(([path]) => {
      try {
        const keys = [];
        for (let i = 0; i < localStorage.length; i += 1) {
          const k = localStorage.key(i);
          if (k && k.startsWith('aas.draft:') && (k === `aas.draft:${path}` || k.endsWith(`\n${path}`))) keys.push(k);
        }
        for (const k of keys) localStorage.removeItem(k);
      } catch { /* 使えない環境もある */ }
    }, [at]);
    const { rm } = await import('node:fs/promises');
    const root = await p.evaluate(() => fetch('/api/config').then((r) => r.json()).then((c) => c.workRootNow)).catch(() => '');
    if (root) await rm(`${root}/${at}`, { force: true }).catch(() => undefined);
  }
});

/*
 * **どのパネルを出しても、中身が入れ物の外へ出ない。**
 *
 * 狭いときだけ崩れる所は、既定の配置では見えない。全部出して、狭くして測る。
 * 実際にここで二つ見つけた（ロールの行が 64px 外／会話の送るボタンが 31px 外）。
 * 出したものは、出す前の状態へ戻す（利用者の配置を残さない）。
 */
await check('どのパネルを出しても、中身が外へ出ない', async () => {
  const before = await p.viewportSize();
  /*
   * **出す前の配置を控えてから出す。**
   *
   * 全部出して閉じ直す形にしたら、**閉じ方が元に戻らず**会話のパネルごと
   * 消えた（次に回したとき「会話のパネルが見つからない」で八件落ちた）。
   * 配置は本体に残るので、利用者の配置を壊すということでもある。控えを戻す。
   */
  const saved = await p.evaluate(() => fetch('/api/layout').then((r) => r.json()).then((j) => j.layout));
  const toggle = async (name) => {
    await p.locator('#openView').click();
    await p.waitForTimeout(400);
    const row = p.locator('#viewList .view-row').filter({ hasText: name }).first();
    if (await row.count() === 0) { await p.keyboard.press('Escape'); return; }
    const tick = row.locator('input');
    if (!(await tick.isChecked())) await tick.click();
    await p.waitForTimeout(500);
    await p.keyboard.press('Escape');
    await p.waitForTimeout(250);
  };
  try {
    await p.locator('#openView').click();
    await p.waitForTimeout(500);
    const names = await p.locator('#viewList .view-row').evaluateAll(
      (rows) => rows.map((r) => r.innerText.trim().split('\n')[0]));
    await p.keyboard.press('Escape');
    await p.waitForTimeout(300);
    for (const name of names) await toggle(name);
    await p.setViewportSize({ width: 420, height: 800 });
    /*
     * **横の一覧を出したままにする。**畳んだままだとパネルが広く取れてしまい、
     * 狭いときだけ崩れる所が出てこない（畳んだ状態で回したら、崩れているのに
     * 何も見つからなかった）。出ている状態が、いちばん狭い。
     */
    if (await p.locator('#sideOpen').isVisible().catch(() => false)) {
      await p.locator('#sideOpen').click();
      await p.waitForTimeout(400);
    }
    await p.waitForTimeout(900);
    /*
     * **一つずつ前に出してから測る。**タブの裏にあるものは描かれていないので、
     * まとめて測ると幅 0 で飛ばしてしまう。崩れているのに何も見つからなかった
     * （ロールの一覧がタブの裏に居た）。
     */
    const out = [];
    for (const name of names) {
      const tab = p.locator('#root .panel.tabs header button').filter({ hasText: name });
      if (await tab.count() > 0) { await tab.first().click().catch(() => undefined); await p.waitForTimeout(350); }
      const found = await p.evaluate((want) => {
        const panel = [...document.querySelectorAll('#root .panel')]
          .find((el) => (el.querySelector('header')?.innerText ?? '').includes(want));
        if (!panel) return [];
        const box = panel.getBoundingClientRect();
        if (box.width === 0) return [];
        const bad = [];
        for (const el of panel.querySelectorAll('*')) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          const over = Math.round(Math.max(r.right - box.right, box.left - r.left));
          if (over > 1) bad.push(`${want}: ${(el.textContent || el.className || el.tagName).trim().slice(0, 14)}（${over}px 外）`);
        }
        return [...new Set(bad)].slice(0, 3);
      }, name);
      out.push(...found);
    }
    if (out.length > 0) throw new Error(out.slice(0, 8).join(' / '));
  } finally {
    await p.setViewportSize(before ?? { width: 1440, height: 900 });
    await p.evaluate((l) => fetch('/api/layout', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(l),
    }), saved).catch(() => undefined);
    await p.reload({ waitUntil: 'load' }).then(opened).catch(() => undefined);
    await p.waitForTimeout(900);
  }
});

/*
 * **覚え書きに打てて、読み直しても残る。**
 *
 * 「メモ」と並んでいるのに、渡された字を出すだけで**一文字も書けなかった**。
 * 打った分は配置と一緒に残る。前に書いてあったものは、最後に書き戻す。
 */
await check('覚え書きに打てて、読み直しても残る', async () => {
  const front = async () => {
    const tab = p.locator('#root .panel.tabs header button').filter({ hasText: 'メモ' }).last();
    if (await tab.count() > 0) { await tab.first().click(); await p.waitForTimeout(350); }
  };
  await front();
  let area = p.locator('.note-area');
  if (await area.count() === 0) {
    // 出ていなければ、表示から出す。
    await p.locator('#openView').click();
    await p.waitForTimeout(400);
    const row = p.locator('#viewList .view-row').filter({ hasText: 'メモ' }).last();
    if (await row.count() === 0) throw new Error('表示の一覧にメモが無い');
    const tick = row.locator('input');
    if (!(await tick.isChecked())) await tick.click();
    await p.waitForTimeout(600);
    await p.keyboard.press('Escape');
    await p.waitForTimeout(300);
    await front();
    area = p.locator('.note-area');
    if (await area.count() === 0) throw new Error('打つ所が無い');
  }
  const was = await area.inputValue();
  try {
    await area.fill('sweep で書いた覚え書き');
    // 手が止まってから残す作りなので、少し待つ。
    await p.waitForTimeout(1400);
    await p.reload({ waitUntil: 'load' });
    await opened();
    await p.waitForTimeout(1200);
    await front();
    const back = await p.locator('.note-area').inputValue();
    if (back !== 'sweep で書いた覚え書き') throw new Error(`読み直したら消えている: ${JSON.stringify(back)}`);
  } finally {
    await p.locator('.note-area').fill(was).catch(() => undefined);
    await p.waitForTimeout(1200);
  }
});

/*
 * **まだ何も無いときに、何を書けばいいか分かる。**
 *
 * 開いた直後の会話は、空の箱と「指示を書く」だけだった。押せば入る例を出す。
 * 例は**入れるだけで送らない**（押した瞬間に走り出すと、確かめる間が無い）。
 */
/*
 * **新しい会話を始める所が、見える形で在る。**
 *
 * 入口は左上の名前を押すことだけで、その案内は指を乗せたときの吹き出しに
 * しか出ていなかった。押して探しても見つからない（実測。横の一覧の ＋ は
 * ファイルのもの）。
 */
await check('新しい会話を、横の一覧から始められる', async () => {
  const plus = p.locator('#newTalk');
  if (await plus.count() === 0) throw new Error('新しい会話の押し場所が無い');
  if (!(await plus.isVisible())) throw new Error('押し場所が見えない');
  await plus.click();
  await p.waitForTimeout(1000);
  if (await p.locator('.chat-guide').count() === 0) {
    throw new Error('押しても新しい会話にならない（案内が出ない）');
  }
});

await check('会話が空のとき、押せる例が出る', async () => {
  /*
   * **画面の道でトップへ戻す。**口を直に叩くと本体の側は新しい会話になるが、
   * 開いている画面は前の話を出したままなので、案内は出ない。配る形の中で
   * 回したとき、その形で落ちた（送って返るを見た後なので、話が残っていた）。
   */
  await p.locator('.brand').first().click();
  await p.waitForTimeout(1000);
  const guide = p.locator('.chat-guide');
  if (await guide.count() === 0) throw new Error('案内が出ていない');
  const said = await guide.innerText();
  if (!said.includes('書いてください')) throw new Error(`言い方が違う: ${said.slice(0, 40)}`);
  const chips = p.locator('.chat-chips button');
  if (await chips.count() < 3) throw new Error(`例が足りない（${await chips.count()}）`);
  // 押せると分かる形（枠が付いている）。
  const framed = await chips.first().evaluate((el) => getComputedStyle(el).borderStyle);
  if (framed === 'none') throw new Error('例に枠が無い（ただの字に見える）');
  await p.locator('.chat textarea').first().fill('');
  await chips.first().click();
  await p.waitForTimeout(300);
  const typed = await p.locator('.chat textarea').first().inputValue();
  if (typed.length === 0) throw new Error('押しても書きかけに入らない');
  // 押しただけで送っていないこと（会話に何も出ていない）。
  if (await p.locator('.log .asked').count() > 0) throw new Error('押しただけで送っている');
  await p.locator('.chat textarea').first().fill('');
});

/*
 * **保存に失敗したら、向こうが返した文を出し、画面は止めない。**
 *
 * 失敗すると `{ error }` が返る。これを受け取った画面が `layout = r.layout`（undefined）とし、
 * 次の描画で止まって「途中で止まりました」としか出ていなかった。口を横取りして 500 を返させる。
 */
await check('並びや色の保存に失敗したら、その文を出して止まらない', async () => {
  expectingSaveFailure = true;
  try {
    for (const [route, select, said] of [
      ['**/api/theme/preset', 'themes', 'SWEEP-色を保存できません'],
      ['**/api/layout/preset', 'presets', 'SWEEP-並びを保存できません'],
    ]) {
      await p.route(route, (r) => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: said }) }));
      await p.evaluate((id) => {
        const s = document.getElementById(id);
        const other = [...s.options].find((o) => o.value !== s.value);
        if (!other) throw new Error(`${id} に切り替え先が無い`);
        s.value = other.value;
        s.dispatchEvent(new Event('change'));
      }, select);
      await p.waitForTimeout(800);
      await p.unroute(route);
      const note = p.locator('#crashNote');
      if (await note.count() === 0) throw new Error(`${select}: 失敗を言っていない`);
      const text = await note.innerText();
      if (!text.includes(said)) throw new Error(`${select}: 向こうの文を出していない: ${text.slice(0, 60)}`);
      await note.click();
    }
    // 止まっていない: 並びは描けたまま
    if (await p.locator('#root').innerText().then((t) => t.length === 0)) throw new Error('並びが消えた');
  } finally {
    expectingSaveFailure = false;
  }
});

/*
 * **見た目を読めなかったら、その文を出して止まらない。**失敗の返事（`{ error }`）のまま一覧を回そうとして止まっていた。
 */
await check('見た目を読めなかったら、その文を出して止まらない', async () => {
  expectingSaveFailure = true;
  try {
    await p.route('**/api/theme', (r) => (r.request().method() === 'GET'
      ? r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'SWEEP-色を読めません' }) })
      : r.continue()));
    await p.reload({ waitUntil: 'load' });
    await opened();
    await p.waitForTimeout(800);
    const note = p.locator('#crashNote');
    if (await note.count() === 0) throw new Error('読めなかったことを言っていない');
    const text = await note.innerText();
    if (!text.includes('SWEEP-色を読めません')) throw new Error(`向こうの文を出していない: ${text.slice(0, 60)}`);
    if (text.includes('途中で止まりました')) throw new Error('止まった');
    // 止まったことの知らせが出ている間、案内（まだ話せません）は二本目の帯に出る。一本目を押して下げたら、
    // 二本目が一本目に繰り上がる（二本目だけが残って、次の案内と二本並ぶ形にしない）。
    // 「まだ話せません」はモデルが無いときだけ出る。モデルを置いて回すとき（配る形の確かめ）は見ない。
    if (noModel) {
      const more = p.locator('#crashNoteMore');
      if (await more.count() === 0 || !(await more.innerText()).includes('まだ話せません')) throw new Error('案内を二本目に出していない');
      await note.click();
      await p.waitForTimeout(200);
      if (await p.locator('#crashNoteMore').count() !== 0) throw new Error('一本目を下げても、二本目が残った');
      if (!(await p.locator('#crashNote').innerText()).includes('まだ話せません')) throw new Error('二本目が一本目に繰り上がっていない');
    }
  } finally {
    await p.unroute('**/api/theme');
    expectingSaveFailure = false;
    await p.reload({ waitUntil: 'load' }).then(opened).catch(() => undefined);
    await p.waitForTimeout(800);
  }
});

/*
 * **読み込みで直したことは、押すまで消えない帯に出す。**
 *
 * 保存していた並びや色が壊れていた・読めなかったときは、既定で出して `repairs` にそう書く。
 * それを状態の欄に件数だけ出していたので、すぐ「つながっています」に書き換わり、見えなかった。
 * 見た目の分も「配置を直しました」と出ていた。口を横取りして、直した記録を足して返させる。
 */
await check('読み込みで直したことを、押すまで消えない帯に出す', async () => {
  for (const [route, key, said, what] of [
    ['**/api/theme', 'theme', 'SWEEP-見た目が壊れていた', '見た目を直しました'],
    ['**/api/layout', 'layout', 'SWEEP-並びが壊れていた', '画面の並びを直しました'],
  ]) {
    await p.route(route, async (r) => {
      if (r.request().method() !== 'GET') return r.continue();
      const real = await r.fetch();
      const body = await real.json();
      if (!body[key]) throw new Error(`${route} の返事に ${key} が無い`);
      await r.fulfill({ response: real, json: { ...body, repairs: [{ detail: said }] } });
    });
    await p.reload({ waitUntil: 'load' });
    await opened();
    await p.waitForTimeout(1500); // 状態の欄が「つながっています」に戻った後でも残っていること
    await p.unroute(route);
    const note = p.locator('#repairNote');
    if (await note.count() === 0) throw new Error(`${what}: 帯が出ていない`);
    const text = await note.innerText();
    if (!text.includes(said)) throw new Error(`${what}: 中身を出していない: ${text.slice(0, 60)}`);
    if (!text.includes(what)) throw new Error(`何を直したかを取り違えている: ${text.slice(0, 60)}`);
    await note.click();
  }
});

/*
 * **読めずに退けた記憶の行を、メモリのパネルで言う。**覚えが 0 件のときも言う（その分岐で先に返していた）。
 * メモリのパネルは既定の並びに無いので、統制卓の並びへ切り替えて見て、最後に写しを取った並びへ戻す。状態の返事は横取りして数を足す。
 */
await check('読めない記憶の行を、メモリのパネルで言う', async () => {
  // 並びは型を選び直すのではなく、丸ごと写しを取って丸ごと戻す（型を選び直すと、大きさや出し入れを変えた並びが型の初期形になる）
  const saved = await p.evaluate(() => fetch('/api/layout').then((r) => r.json()).then((j) => j.layout));
  await p.route('**/api/state', async (r) => {
    const real = await r.fetch();
    await r.fulfill({ response: real, json: { ...(await real.json()), memory: [], memorySkipped: 3 } });
  });
  const pick = (id) => p.evaluate((v) => {
    const s = document.getElementById('presets');
    s.value = v;
    s.dispatchEvent(new Event('change'));
  }, id);
  try {
    await pick('command');
    await p.waitForTimeout(1200);
    const tab = p.locator('#root .panel.tabs header button').filter({ hasText: 'メモリ' });
    if (await tab.count() === 0) throw new Error('統制卓の並びにメモリのタブが無い');
    await tab.first().click();
    await p.waitForTimeout(500);
    const text = await p.locator('#root').innerText();
    if (!text.includes('読めない行が 3 行')) throw new Error('読めない行の数を言っていない');
  } finally {
    await p.unroute('**/api/state');
    await p.evaluate((l) => fetch('/api/layout', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(l),
    }), saved).catch(() => undefined);
    await p.reload({ waitUntil: 'load' }).then(opened).catch(() => undefined);
    await p.waitForTimeout(800);
  }
});

/*
 * **記憶の「忘れる」は、押した直後に「戻す」で取り消せる。**一押しで効くので、押し間違えを戻せないと覚え直すまで同じ失敗をする。
 * 本体が忘れられなかった（保存できなかった）ときは、その文を出し、戻す口は出さない。本体の返事は横取りする
 * （モデルが無いと、記憶を持つセッションが無い）。並びは前の場面と同じく、写しを取って最後に戻す。
 */
await check('記憶を忘れた直後に、戻せる', async () => {
  const saved = await p.evaluate(() => fetch('/api/layout').then((r) => r.json()).then((j) => j.layout));
  const entry = { id: 'm7', kind: 'fact', title: '試しの覚え', confirms: 1, helped: 0, misled: 0 };
  let memory = [entry];
  // 忘れて戻せる分（本体が持つ）。5 秒ごとの読み直しで本物の空の一覧が来ると、戻す口が消えて偶然落ちる
  let forgotten = [];
  let forgetFails = true;
  const sent = [];
  await p.route('**/api/state', async (r) => {
    const real = await r.fetch();
    await r.fulfill({ response: real, json: { ...(await real.json()), memory, memorySkipped: 0, memorySize: memory.length, memoryForgotten: forgotten } });
  });
  await p.route('**/api/memory**', async (r) => {
    const req = r.request();
    sent.push(`${req.method()} ${new URL(req.url()).pathname} ${req.postData() ?? ''}`);
    if (req.method() === 'DELETE') {
      if (forgetFails) return r.fulfill({ status: 500, json: { error: '保存できなかったので、忘れていません（試し）' } });
      memory = [];
      forgotten = [{ id: 'm7', title: entry.title, kind: entry.kind, at: Date.now() }];
      return r.fulfill({ json: { id: 'm7', title: entry.title, forgotten: true } });
    }
    memory = [entry];
    forgotten = [];
    return r.fulfill({ json: { id: 'm7', title: entry.title, restored: true } });
  });
  const said = [];
  const answer = (d) => { said.push(d.message()); void d.dismiss().catch(() => undefined); };
  p.on('dialog', answer);
  try {
    await p.evaluate(() => {
      const s = document.getElementById('presets');
      s.value = 'command';
      s.dispatchEvent(new Event('change'));
    });
    await p.waitForTimeout(1200);
    const tab = p.locator('#root .panel.tabs header button').filter({ hasText: 'メモリ' });
    if (await tab.count() === 0) throw new Error('統制卓の並びにメモリのタブが無い');
    await tab.first().click();
    await p.waitForTimeout(500);
    const forget = p.locator('#root button', { hasText: '忘れる' });
    if (await forget.count() === 0) throw new Error('忘れる口が無い');

    expectingSaveFailure = true;
    await forget.first().click();
    await p.waitForTimeout(500);
    expectingSaveFailure = false;
    if (!said.some((t) => t.includes('忘れていません'))) throw new Error(`忘れられなかったことを言っていない: ${said.join(' / ')}`);
    if ((await p.locator('#root').innerText()).includes('を忘れました')) throw new Error('忘れられなかったのに、忘れたと出した');

    forgetFails = false;
    await forget.first().click();
    await p.waitForTimeout(500);
    const after = await p.locator('#root').innerText();
    if (!after.includes('「試しの覚え」を忘れました')) throw new Error('忘れたことと、戻す口を出していない');
    // 行ではなく文そのものの幅を測る（行は幅があっても、文が潰れていることがある）
    const drawn = await p.locator('#root .row', { hasText: 'を忘れました' }).first().evaluate((row) => {
      const text = [...row.childNodes].find((n) => n.nodeType === 3 && n.textContent.includes('を忘れました'));
      if (!text) return 0;
      const r = document.createRange();
      r.selectNodeContents(text);
      return r.getBoundingClientRect().width;
    });
    if (drawn < 40) throw new Error(`忘れた知らせの文が潰れて見えない（幅 ${drawn}px）`);
    const undo = p.locator('#root button', { hasText: '戻す' });
    if (await undo.count() === 0) throw new Error('戻す口が無い');
    await undo.first().click();
    await p.waitForTimeout(800);
    const back = await p.locator('#root').innerText();
    if (back.includes('を忘れました')) throw new Error('戻したのに、忘れた知らせが残っている');
    if (!back.includes('試しの覚え')) throw new Error('戻した覚えが一覧に無い');
    const restore = sent.find((x) => x.startsWith('POST /api/memory/restore'));
    if (!restore) throw new Error(`戻すよう頼んでいない: ${sent.join(' / ')}`);
    const keys = Object.keys(JSON.parse(restore.split(' ').slice(2).join(' '))).join(',');
    if (keys !== 'id') throw new Error(`戻す中身を画面から送っている（番号だけにする）: ${keys}`);
  } finally {
    expectingSaveFailure = false;
    p.off('dialog', answer);
    await p.unroute('**/api/memory**');
    await p.unroute('**/api/state');
    await p.evaluate((l) => fetch('/api/layout', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(l),
    }), saved).catch(() => undefined);
    await p.reload({ waitUntil: 'load' }).then(opened).catch(() => undefined);
    await p.waitForTimeout(800);
  }
});

/*
 * **やり残しの「×」も、押した直後に「戻す」で取り消せる。**元の依頼の文は、やり残しの記録にしか無い。
 * やめられなかった（500）ときは、黙らずに帯で言う。本体の返事は横取りする（やり残しを作るにはモデルが要る）。
 */
await check('やめたやり残しを、戻せる', async () => {
  const item = { id: 'u-sweep', request: 'SWEEP-やり残し\n二行目', whyText: '往復の上限に届いて、途中で切れました', attempts: 1, running: false };
  const item2 = { id: 'u-sweep2', request: 'SWEEP-二つ目', whyText: '往復の上限に届いて、途中で切れました', attempts: 1, running: false };
  let list = [item, item2];
  // やめて、まだ戻せるもの（本体が新しい順に渡す）
  let canceled = [];
  let cancelFails = true;
  const sent = [];
  await p.route('**/api/unfinished**', async (r) => {
    const req = r.request();
    const url = new URL(req.url());
    if (req.method() === 'GET') return r.fulfill({ json: { list, canceled } });
    sent.push(`${req.method()} ${url.pathname} ${req.postData() ?? ''}`);
    if (req.method() === 'DELETE') {
      if (cancelFails) return r.fulfill({ status: 500, json: { error: 'SWEEP-書けません' } });
      const it = [item, item2].find((x) => x.id === url.searchParams.get('id'));
      list = list.filter((x) => x.id !== it.id);
      canceled = [{ id: it.id, request: it.request, at: Date.now() }, ...canceled.filter((c) => c.id !== it.id)];
      return r.fulfill({ json: { canceled: it.id } });
    }
    const { id } = JSON.parse(req.postData() ?? '{}');
    list = [...list, [item, item2].find((x) => x.id === id)];
    canceled = canceled.filter((c) => c.id !== id);
    return r.fulfill({ json: { reopened: id } });
  });
  try {
    await p.reload({ waitUntil: 'load' });
    await opened();
    await p.waitForTimeout(800);
    const stop = p.locator('#sideUnfinished button', { hasText: '×' });
    if (await stop.count() === 0) throw new Error('やり残しの × が無い');

    expectingSaveFailure = true;
    await stop.first().click();
    await p.waitForTimeout(500);
    expectingSaveFailure = false;
    const note = p.locator('#crashNote');
    if (await note.count() === 0 || !(await note.innerText()).includes('SWEEP-書けません')) throw new Error('やめられなかったことを言っていない');
    if ((await p.locator('#sideUnfinished').innerText()).includes('をやめました')) throw new Error('やめられなかったのに、やめたと出した');
    await note.click();

    cancelFails = false;
    await stop.first().click();
    await p.waitForTimeout(500);
    const side = await p.locator('#sideUnfinished').innerText();
    if (!side.includes('「SWEEP-やり残し」をやめました')) throw new Error(`やめたことと、戻す口を出していない: ${side.slice(0, 60)}`);
    const said = await p.locator('#sideUnfinished > .side-note .grow').boundingBox();
    if (!said || said.width < 40) throw new Error(`やめた知らせの文が潰れて見えない（幅 ${said?.width ?? 0}px）`);

    // 続けてもう一つやめる。前にやめた方は畳みに回り、そこから戻せる
    await stop.first().click();
    await p.waitForTimeout(500);
    if (await p.locator('#unfinishedSec').isHidden()) throw new Error('一覧が空になって、戻す口ごと隠れた');
    const two = await p.locator('#sideUnfinished').innerText();
    if (!two.includes('「SWEEP-二つ目」をやめました')) throw new Error(`最後にやめた方を目の前に出していない: ${two.slice(0, 80)}`);
    const more = p.locator('#sideUnfinished details');
    if (await more.count() !== 1) throw new Error('前にやめた方を畳んで並べていない');
    await more.locator('summary').click();
    await p.waitForTimeout(300);
    const older = more.locator('.side-note', { hasText: 'SWEEP-やり残し' });
    if (!(await older.isVisible())) throw new Error('畳んだ分を開いても、前にやめた方が見えない');
    await older.locator('button', { hasText: '戻す' }).click();
    await p.waitForTimeout(500);
    const back = await p.locator('#sideUnfinished').innerText();
    if (back.includes('「SWEEP-やり残し」をやめました')) throw new Error('戻したのに、やめた知らせが残っている');
    if (!back.includes('SWEEP-やり残し')) throw new Error('戻したやり残しが一覧に無い');
    if (!back.includes('「SWEEP-二つ目」をやめました')) throw new Error('戻していない方の口を消した');
    const reopen = sent.filter((x) => x.startsWith('POST /api/unfinished/reopen'));
    if (reopen.length !== 1) throw new Error(`戻すよう頼んでいない: ${sent.join(' / ')}`);
    const body = JSON.parse(reopen[0].split(' ').slice(2).join(' '));
    if (body.id !== item.id) throw new Error(`前にやめた方を戻すよう頼んでいない: ${reopen[0]}`);
    if (Object.keys(body).join(',') !== 'id') throw new Error(`戻す中身を画面から送っている（番号だけにする）: ${Object.keys(body).join(',')}`);
  } finally {
    expectingSaveFailure = false;
    await p.unroute('**/api/unfinished**');
    await p.reload({ waitUntil: 'load' }).then(opened).catch(() => undefined);
    await p.waitForTimeout(800);
  }
});

/*
 * **状態（/api/state）が断られても、画面は止まらない。**断られたときの `{ error }` を状態として全部のパネルへ配り、
 * パネルが順に止まっていた（getJson で失敗として投げる）。状態は 5 秒ごとに取り直すので、その間 500 を返させて見る。
 */
await check('状態が読めなくても、画面は止まらない', async () => {
  const before = bad.length;
  expectingSaveFailure = true;
  await p.route('**/api/state', (r) => r.fulfill({ status: 500, json: { error: 'SWEEP-状態を読めません' } }));
  try {
    await p.waitForTimeout(6500);
  } finally {
    await p.unroute('**/api/state');
    expectingSaveFailure = false;
  }
  const crashed = bad.slice(before).filter((x) => x.startsWith('落ちた'));
  if (crashed.length > 0) throw new Error(`状態が読めない間に止まった: ${crashed.join(' / ')}`);
  const notes = async () => (await p.locator('.crash-note').allInnerTexts()).join(' / ');
  const during = await notes();
  if (during.includes('途中で止まりました')) throw new Error('止まった知らせが出た');
  // 黙らない（古い状態が出たままで、何かあったことが見えない形にしない）
  if (!during.includes('状態を読めませんでした') || !during.includes('SWEEP-状態を読めません')) throw new Error(`状態が読めないことを言っていない: ${during}`);
  // 読めるようになったら下げる
  await p.waitForTimeout(6000);
  if ((await notes()).includes('状態を読めませんでした')) throw new Error('読めるようになっても、読めなかった知らせが残っている');
});

if (shot) await p.screenshot({ path: shot, fullPage: false });
await b.close();
console.log(bad.length === 0 ? '見つかった不具合: なし' : `見つかった不具合 ${bad.length} 件:\n- ${bad.join('\n- ')}`);
process.exit(bad.length === 0 ? 0 : 1);
