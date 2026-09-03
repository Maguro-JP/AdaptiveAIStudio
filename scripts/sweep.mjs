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
 * 走らせるには playwright-core と Chromium が要る（配布物には入れない）。
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
  bad.push(`画面のエラー: ${m.text()}`);
});
p.on('response', (r) => {
  if (r.status() < 400) return;
  // モデルを置いていない状態では、送りを断るのが正しい。
  if (noModel && r.status() === 503 && new URL(r.url()).pathname === '/api/send') return;
  bad.push(`${r.status()} ${new URL(r.url()).pathname}`);
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
for (const sec of ['info', 'look', 'place', 'model', 'check']) {
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

// コマンド板
await check('コマンドを開いて閉じる', async () => {
  await p.locator('#open').click();
  await p.waitForTimeout(600);
  if (!(await p.locator('#palette').isVisible())) throw new Error('開かない');
  if ((await p.locator('#paletteList').innerText()).trim().length === 0) throw new Error('中身が空');
  await p.keyboard.press('Escape');
  await p.waitForTimeout(400);
});

// 会話：新しい会話 → 送る → 一覧に出る
await check('新しい会話', async () => {
  await p.locator('#sideSessions button').first().click();
  await p.waitForTimeout(600);
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

await check('作業場を開く', async () => {
  const dirs = p.locator('#sideFiles button');
  if (await dirs.count() === 0) throw new Error('作業場が空');
  await dirs.first().click();
  await p.waitForTimeout(600);
});

if (shot) await p.screenshot({ path: shot, fullPage: false });
await b.close();
console.log(bad.length === 0 ? '見つかった不具合: なし' : `見つかった不具合 ${bad.length} 件:\n- ${bad.join('\n- ')}`);
process.exit(bad.length === 0 ? 0 : 1);
