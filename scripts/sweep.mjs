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
p.on('pageerror', (e) => bad.push(`落ちた: ${e.message}`));
p.on('console', (m) => {
  if (m.type() !== 'error') return;
  if (noModel && m.text().includes('503')) return;
  if (expectingRefusal && /\b(409|501)\b/.test(m.text())) return;
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
  bad.push(`${r.status()} ${at}`);
});

await p.goto(url, { waitUntil: 'networkidle' });
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
  if (!said.includes('設定')) throw new Error(`空だが、どう変えるかを言っていない: ${said.slice(0, 60)}`);
});

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
  const { writeFile, rm } = await import('node:fs/promises');
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
  const after = await move(want);
  if (!after.includes(want.split('/').at(-1))) {
    throw new Error(`押しても変わらない: ${after.slice(0, 80)}`);
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

if (shot) await p.screenshot({ path: shot, fullPage: false });
await b.close();
console.log(bad.length === 0 ? '見つかった不具合: なし' : `見つかった不具合 ${bad.length} 件:\n- ${bad.join('\n- ')}`);
process.exit(bad.length === 0 ? 0 : 1);
