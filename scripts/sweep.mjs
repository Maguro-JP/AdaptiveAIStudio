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
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const noModel = process.argv.includes('--no-model');
const url = args[0];
const shot = args[1];
if (!url) {
  console.error('使い方: node scripts/sweep.mjs <画面のURL> [撮る先.png] [--no-model]');
  process.exit(2);
}
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const bad = [];
p.on('pageerror', (e) => bad.push(`落ちた: ${e.message}`));
p.on('console', (m) => {
  if (m.type() !== 'error') return;
  if (noModel && m.text().includes('503')) return;
  // 立ち上げ直せない入口の 501 は、正しい断り。
  if (m.text().includes('501')) return;
  bad.push(`画面のエラー: ${m.text()}`);
});
p.on('response', (r) => {
  if (r.status() < 400) return;
  const at = new URL(r.url()).pathname;
  // モデルを置いていない状態では、送りを断るのが正しい。
  if (noModel && r.status() === 503 && at === '/api/send') return;
  // **起こし直してもらえない入口では、断るのが正しい。**
  // ここで止めると誰も起こさず、二度と戻らない（実際にそうなっていた）。
  if (r.status() === 501 && at === '/api/restart') return;
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

const check = async (name, fn) => {
  try { await fn(); } catch (e) { bad.push(`${name}: ${String(e.message ?? e).split('\n')[0]}`); }
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
  const xs = p.locator('#root .panel > header > .panel-x');
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

await check('会話を開く', async () => {
  if (await convRows().count() === 0) throw new Error('一覧が空（溜めた状態で押していない）');
  const row = convRows().last();
  const name = (await row.locator('button').first().innerText()).trim();
  await row.locator('button').first().click();
  await p.waitForTimeout(800);
  // 選ばれている印が、押したものに付くこと。
  const on = await p.locator('#sideSessions .side-row button.on').first().innerText().catch(() => '');
  if (on.trim() !== name) throw new Error(`押したものが選ばれていない: ${name} / ${on.trim()}`);
});

await check('新しい会話', async () => {
  const before = await convRows().count();
  await p.locator('#sideSessions > button').first().click();
  await p.waitForTimeout(900);
  const after = await convRows().count();
  // 増えるか、使い回したと言うか。**どちらも起きないなら、押し損。**
  const reused = await p.locator('#convNote').isVisible().catch(() => false);
  if (after <= before && !reused) {
    throw new Error(`押しても増えず、何も言われない（${before} → ${after}）`);
  }
});

await check('会話を消す', async () => {
  const before = await convRows().count();
  if (before === 0) throw new Error('消す相手がいない');
  const row = convRows().last();
  const name = (await row.locator('button').first().innerText()).trim();
  // 消すのは訊いてくる。訊かれなければ、それ自体が不具合。
  let asked = false;
  const answer = (d) => { asked = true; void d.accept(); };
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
  if (noModel) {
    // モデルが無いなら、断る理由が画面に出ていること。**黙って何も起きない、を作らない。**
    await p.locator('.chat textarea').fill('モデルが無いときの確かめ');
    await p.locator('.chat textarea').press('Enter');
    await p.waitForTimeout(1500);
    const log = await p.locator('.chat .log').innerText();
    if (!log.includes('GGUF') && !log.includes('モデル')) throw new Error('断った理由が出ていない');
    return;
  }
  await p.locator('.chat textarea').fill('掃除の確かめ');
  await p.locator('.chat textarea').press('Enter');
  await p.waitForFunction(() => document.getElementById('run')?.dataset.state === 'busy', null, { timeout: 30000 });
  await p.waitForFunction(() => document.getElementById('run')?.dataset.state !== 'busy', null, { timeout: 120000 });
  const log = await p.locator('.chat .log').innerText();
  if (!log.includes('掃除の確かめ')) throw new Error('送ったものが出ていない');
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
    const before = await p.locator('#root .panel').count();
    await p.selectOption('#presets', other);
    await p.waitForTimeout(1000);
    const after = await p.locator('#root .panel').count();
    if (after === 0) throw new Error('板が一つも無くなった');
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
});

await check('空の区画を出さない', async () => {
  // hidden は既定の display を消すだけなので、こちらで display: を当てている
  // 要素では**素通りする**。実際に「やり残し」が空のまま出ていた。
  for (const id of ['unfinishedSec', 'queue']) {
    const box = p.locator(`#${id}`);
    if (await box.count() === 0) continue;
    const isHidden = await box.evaluate((e) => e.hasAttribute('hidden'));
    if (isHidden && await box.isVisible()) throw new Error(`隠したはずが出ている: #${id}`);
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
  const r = await p.evaluate(async () => {
    const res = await fetch('/api/restart', { method: 'POST' });
    return { status: res.status, body: await res.text() };
  });
  if (r.status === 200) return; // 起こし直せる入口なら、それでよい
  if (![409, 501].includes(r.status)) throw new Error(`思わぬ返事: ${r.status} ${r.body.slice(0, 80)}`);
  if (!r.body.includes('error')) throw new Error('断る理由が無い');
});

await check('作業場を開く', async () => {
  const dirs = p.locator('#sideFiles button');
  if (await dirs.count() > 0) {
    await dirs.first().click();
    await p.waitForTimeout(600);
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
  await again.first().click();
  await p.waitForTimeout(900);
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

if (shot) await p.screenshot({ path: shot, fullPage: false });
await b.close();
console.log(bad.length === 0 ? '見つかった不具合: なし' : `見つかった不具合 ${bad.length} 件:\n- ${bad.join('\n- ')}`);
process.exit(bad.length === 0 ? 0 : 1);
