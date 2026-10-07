/**
 * 色を選ぶ部品。
 *
 * 設定のときだけでなく、**コードを読んでいる最中**にも使う。
 * 書いてある `#7aa2f7` の隣に色を出し、押せばここが開く。
 *
 * 変換の論理は `color-core.js` にある（そちらは試験してある）。
 * ここは触り心地だけを持つ。
 */
import {
  parse, toHex, toRgbString, toHslString, rgbToHsl, hslToRgb,
  contrast, readability, findColors,
} from './color-core.js';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

/** 直近に選んだ色。選び直すことが多いので、覚えておく。 */
const recent = [];
function remember(hex) {
  const at = recent.indexOf(hex);
  if (at >= 0) recent.splice(at, 1);
  recent.unshift(hex);
  recent.length = Math.min(recent.length, 12);
}

/**
 * 色を選ぶ窓を開く。
 *
 * @param {string} initial   いまの色
 * @param {object} opts      onChange（動かすたび）/ onDone（決めたとき）/ against（読みやすさを見る相手）
 */
export function openPicker(initial, opts = {}) {
  let rgb = parse(initial) ?? { r: 128, g: 128, b: 128, a: 1 };
  let hsl = rgbToHsl(rgb);

  const dlg = document.createElement('dialog');
  dlg.className = 'color-picker';

  // ---- 色の地図（横=鮮やかさ、縦=明るさ）------------------------
  const map = el('div', 'color-map');
  const dot = el('div', 'color-dot');
  map.append(dot);

  // ---- つまみ ---------------------------------------------------
  const hue = document.createElement('input');
  hue.type = 'range'; hue.min = 0; hue.max = 360; hue.className = 'color-hue';
  const alpha = document.createElement('input');
  alpha.type = 'range'; alpha.min = 0; alpha.max = 100; alpha.className = 'color-alpha';

  // ---- 数字（16進 / rgb / hsl）-----------------------------------
  const fields = el('div', 'color-fields');
  const mk = (label) => {
    const wrap = el('label', 'color-field');
    wrap.append(el('span', 'dim', label));
    const input = document.createElement('input');
    input.type = 'text';
    wrap.append(input);
    fields.append(wrap);
    return input;
  };
  const hexIn = mk('HEX');
  const rgbIn = mk('RGB');
  const hslIn = mk('HSL');

  const swatch = el('div', 'color-swatch-big');
  const contrastNote = el('div', 'color-contrast');

  // ---- 見本 -----------------------------------------------------
  const palette = el('div', 'color-palette');
  const addSwatch = (value, title) => {
    const b = el('button', 'color-swatch');
    b.type = 'button';
    b.style.background = value;
    b.title = title ?? value;
    b.onclick = () => { set(parse(value) ?? rgb); };
    palette.append(b);
  };

  // いま使っている見た目の色。**作っているものと揃えやすくする。**
  const rootStyle = getComputedStyle(document.documentElement);
  for (const token of ['--accent', '--good', '--warn', '--bad', '--text', '--dim', '--bg', '--surface', '--line']) {
    const v = rootStyle.getPropertyValue(token).trim();
    if (v) addSwatch(v, token);
  }
  for (const v of recent) addSwatch(v, '直近');

  // ---- 出し入れ -------------------------------------------------
  let silent = false;
  const draw = () => {
    const hex = toHex(rgb);
    swatch.style.background = hex;
    map.style.background =
      `linear-gradient(to top, #000, transparent), `
      + `linear-gradient(to right, #fff, hsl(${hsl.h}, 100%, 50%))`;
    dot.style.left = `${hsl.s * 100}%`;
    dot.style.top = `${(1 - hsl.l) * 100}%`;
    if (!silent) {
      hexIn.value = hex;
      rgbIn.value = toRgbString(rgb);
      hslIn.value = toHslString(rgb);
    }
    hue.value = Math.round(hsl.h);
    alpha.value = Math.round(rgb.a * 100);

    // 読みやすさ。選べるようにすると、読めない組み合わせも選べてしまう。
    // ?? と || は括弧なしで混ぜられない（構文エラーになる）
    const other = parse(opts.against ?? (rootStyle.getPropertyValue('--bg').trim() || '#000'));
    if (other) {
      const r = readability(contrast(rgb, other));
      contrastNote.textContent = r.label;
      contrastNote.className = `color-contrast ${r.level}`;
    }
    opts.onChange?.(hex, rgb);
  };

  const set = (next) => { rgb = next; hsl = rgbToHsl(rgb); draw(); };

  // 地図をなぞる
  const pick = (e) => {
    const box = map.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
    const y = Math.min(1, Math.max(0, (e.clientY - box.top) / box.height));
    hsl = { ...hsl, s: x, l: 1 - y };
    rgb = hslToRgb(hsl);
    draw();
  };
  map.onpointerdown = (e) => { map.setPointerCapture(e.pointerId); pick(e); };
  map.onpointermove = (e) => { if (map.hasPointerCapture(e.pointerId)) pick(e); };

  hue.oninput = () => { hsl = { ...hsl, h: Number(hue.value) }; rgb = hslToRgb(hsl); draw(); };
  alpha.oninput = () => { rgb = { ...rgb, a: Number(alpha.value) / 100 }; draw(); };

  // 数字で直に入れる。読めない値は**捨てずに残す**（打っている途中なので）。
  for (const input of [hexIn, rgbIn, hslIn]) {
    input.oninput = () => {
      const next = parse(input.value);
      if (!next) { input.classList.add('bad'); return; }
      input.classList.remove('bad');
      silent = true;
      set(next);
      silent = false;
    };
  }

  const done = el('button', 'primary', '決める');
  const cancel = el('button', 'ghost', 'やめる');
  cancel.type = 'button';
  const foot = el('div', 'color-foot');
  foot.append(contrastNote, cancel, done);

  const form = document.createElement('form');
  form.method = 'dialog';
  form.append(swatch, map, hue, alpha, fields, palette, foot);
  dlg.append(form);
  document.body.append(dlg);

  const before = toHex(parse(initial) ?? rgb);
  // 決めずに閉じた（やめる・Esc）なら、元の色に戻す。Esc では戻さずに閉じ、動かした色が下書きに残っていた
  let decided = false;
  cancel.onclick = () => { dlg.close(); };
  done.onclick = () => { decided = true; remember(toHex(rgb)); opts.onDone?.(toHex(rgb), rgb); };
  dlg.addEventListener('close', () => { if (!decided) opts.onChange?.(before, parse(before)); });
  dlg.addEventListener('close', () => dlg.remove());

  draw();
  dlg.showModal();
  return dlg;
}

/**
 * 文の中の色に、見本を重ねる。
 *
 * コードや差分を読んでいる最中に効かせたいので、**元の文字は変えない**。
 * 色を消して見本だけにすると、何が書いてあったのか分からなくなる。
 */
export function decorate(node, opts = {}) {
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  const targets = [];
  while (walker.nextNode()) {
    const t = walker.currentNode;
    if (t.parentElement?.closest('.color-swatch, .color-picker')) continue;
    if (t.nodeValue && /#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\(/.test(t.nodeValue)) targets.push(t);
  }

  for (const text of targets) {
    const found = findColors(text.nodeValue);
    if (found.length === 0) continue;

    const frag = document.createDocumentFragment();
    let at = 0;
    for (const f of found) {
      frag.append(document.createTextNode(text.nodeValue.slice(at, f.start)));
      const chip = el('button', 'color-swatch inline');
      chip.type = 'button';
      chip.style.background = f.value;
      chip.title = `${f.value} — 押すと開く`;
      chip.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        openPicker(f.value, { onDone: (hex) => { opts.onPick?.(f.value, hex); } });
      };
      frag.append(chip, document.createTextNode(f.value));
      at = f.end;
    }
    frag.append(document.createTextNode(text.nodeValue.slice(at)));
    text.parentNode?.replaceChild(frag, text);
  }
}
