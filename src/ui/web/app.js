/**
 * 配置(JSON)から画面を組み立てる。
 *
 * 画面の形はここでは決めない。決めているのは配置の方。
 * ここがやるのは、配置の通りに並べることと、
 * 仕切りを掴んで動かしたら配置に書き戻すことだけ。
 */
import { PANELS, TITLES } from './panels.js';
import { openPicker } from './color.js';

const root = document.getElementById('editor');
const $ = (id) => document.getElementById(id);

let layout = null;
let theme = null;
let tokenNames = [];
const stateHandlers = [];
const eventHandlers = new Map();

const ctx = {
  /** 会話の入力欄へ寄せる。差し替えられる。 */
  focusInput: () => undefined,
  on(type, fn) {
    if (!eventHandlers.has(type)) eventHandlers.set(type, []);
    eventHandlers.get(type).push(fn);
  },
  onState(fn) { stateHandlers.push(fn); if (lastState) fn(lastState); },
};

let lastState = null;

/* ---------- 組み立て ---------- */

function buildPanel(spec) {
  const box = document.createElement('section');
  box.className = 'panel';
  const head = document.createElement('header');
  head.textContent = spec.title ?? TITLES[spec.kind] ?? spec.kind;
  const body = document.createElement('div');
  body.className = 'body';
  box.append(head, body);

  const make = PANELS[spec.kind] ?? PANELS.note;
  try {
    make(body, ctx, spec);
  } catch (e) {
    // 一つの中身が壊れても、画面全体は出す。
    body.replaceChildren();
    body.append(Object.assign(document.createElement('div'),
      { className: 'bad', textContent: `この中身を出せませんでした: ${e.message}` }));
  }
  return box;
}

function buildTabs(node, panels) {
  const box = document.createElement('section');
  box.className = 'panel tabs';
  const head = document.createElement('header');
  const body = document.createElement('div');
  body.className = 'body';
  box.append(head, body);

  // 中身だけを取り出して持っておく。
  // 一度移してしまうと元の枠からは辿れなくなるので、ここで押さえる。
  const bodies = node.panels.map((id) => {
    const spec = panels.get(id);
    return spec ? buildPanel(spec).querySelector('.body') : null;
  }).filter(Boolean);

  const show = (i) => {
    const chosen = bodies[i];
    if (!chosen) return;
    body.replaceChildren(chosen);
    [...head.children].forEach((b, j) => b.setAttribute('aria-selected', String(j === i)));
    node.active = i;
  };

  node.panels.forEach((id, i) => {
    const spec = panels.get(id);
    const b = document.createElement('button');
    b.textContent = spec?.title ?? TITLES[spec?.kind] ?? id;
    b.onclick = () => show(i);
    head.append(b);
  });

  show(Math.min(node.active ?? 0, bodies.length - 1));
  return box;
}

function buildNode(node, panels) {
  if (node.type === 'panel') {
    const spec = panels.get(node.panel);
    return spec ? buildPanel(spec) : document.createElement('div');
  }
  if (node.type === 'tabs') return buildTabs(node, panels);

  const box = document.createElement('div');
  box.className = `split ${node.direction === 'column' ? 'column' : ''}`;
  node.children.forEach((child, i) => {
    const wrap = buildNode(child, panels);
    wrap.style.flex = `${node.sizes[i]} 1 0`;
    wrap.style.minWidth = '0';
    wrap.style.minHeight = '0';
    box.append(wrap);
    if (i < node.children.length - 1) box.append(grip(node, i, box));
  });
  return box;
}

/** 仕切り。掴んで動かすと、比率が配置に書き戻る。 */
function grip(node, index, box) {
  const g = document.createElement('div');
  g.className = 'grip';
  g.onpointerdown = (down) => {
    down.preventDefault();
    g.setPointerCapture(down.pointerId);
    const vertical = node.direction === 'column';
    const rect = box.getBoundingClientRect();
    const total = vertical ? rect.height : rect.width;
    const start = vertical ? down.clientY : down.clientX;
    const a = node.sizes[index], b = node.sizes[index + 1];
    const kids = [...box.children].filter((c) => !c.classList.contains('grip'));

    const move = (e) => {
      const delta = ((vertical ? e.clientY : e.clientX) - start) / total;
      // どちらも潰さない。潰れた面は掴み直せなくなる。
      const na = Math.max(0.08, Math.min(a + b - 0.08, a + delta));
      const nb = a + b - na;
      node.sizes[index] = na;
      node.sizes[index + 1] = nb;
      kids[index].style.flex = `${na} 1 0`;
      kids[index + 1].style.flex = `${nb} 1 0`;
    };
    const up = () => {
      g.removeEventListener('pointermove', move);
      g.removeEventListener('pointerup', up);
      save(layout);
    };
    g.addEventListener('pointermove', move);
    g.addEventListener('pointerup', up);
  };
  return g;
}

function render() {
  stateHandlers.length = 0;
  eventHandlers.clear();
  document.documentElement.dataset.density = layout.density ?? 'comfortable';
  const panels = new Map(layout.panels.map((p) => [p.id, p]));
  const view = buildNode(layout.root, panels);
  view.style.height = '100%';
  $('root').replaceChildren(view);
  if (lastState) for (const fn of stateHandlers) fn(lastState);
}

/* ---------- 見た目 ---------- */

/** 受け取った値をそのまま根に差す。値は向こう側で検められている。 */
function applyTheme(t, vars) {
  theme = t;
  const root = document.documentElement;
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
  root.dataset.scheme = t.scheme;
  // 効果は名前で渡す。CSS 側が [data-fx~="…"] で拾う。
  root.dataset.fx = (t.effects ?? []).join(' ');
  const sel = $('themes');
  if (!sel) return;
  // 自分でいじった色も一覧に残す。選び直したときに戻ってこられるように。
  if (![...sel.options].some((o) => o.value === t.id)) {
    const o = document.createElement('option');
    o.value = t.id; o.textContent = t.name;
    sel.append(o);
  }
  sel.value = t.id;
}

async function loadTheme() {
  const r = await fetch('/api/theme').then((x) => x.json());
  tokenNames = r.tokens;
  const sel = $('themes');
  sel.replaceChildren();
  for (const t of r.themes) {
    const o = document.createElement('option');
    o.value = t.id; o.textContent = t.name;
    sel.append(o);
  }
  applyTheme(r.theme, r.vars);
  showRepairs(r.repairs);
}

$('themes').onchange = async (e) => {
  const r = await fetch('/api/theme/preset', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: e.target.value }),
  }).then((x) => x.json());
  applyTheme(r.theme, r.vars);
};

/* 色をいじる。触っているそばから映る。気に入らなければ戻せる。 */
const COLOR_TOKENS = new Set([
  'bg', 'surface', 'surface2', 'line', 'text', 'dim', 'accent', 'accentText', 'good', 'warn', 'bad',
]);
const cssVarName = (t) => '--' + t.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);

$('editTheme').onclick = () => {
  const before = structuredClone(theme);
  const box = $('swatches');
  box.replaceChildren();
  $('themeRepairs').textContent = '';

  const draft = structuredClone(theme);
  for (const name of tokenNames) {
    const value = draft.tokens[name] ?? '';
    const label = document.createElement('label');
    label.textContent = name;

    const text = document.createElement('input');
    text.type = 'text';
    text.value = value;

    const apply = (v) => {
      draft.tokens[name] = v;
      // 検めは向こう側がやる。ここでの見え方は下書きに過ぎない。
      document.documentElement.style.setProperty(cssVarName(name), v);
    };

    // 色の項目には見本を出す。押せば地図とつまみで選べる。
    // ブラウザ標準の色選びは 16進6桁しか扱えず、rgba も hsl も渡せない。
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'color-swatch';
    const isColor = COLOR_TOKENS.has(name);
    if (!isColor) swatch.style.visibility = 'hidden';
    const paint = (v) => { swatch.style.background = v; swatch.title = `${v} — 押すと開く`; };
    paint(value);

    swatch.onclick = () => {
      openPicker(text.value, {
        // 動かしている間も、その場で見えるようにする。
        onChange: (hex) => { text.value = hex; paint(hex); apply(hex); },
        onDone: (hex) => { text.value = hex; paint(hex); apply(hex); },
        against: draft.tokens.bg ?? before.tokens.bg,
      });
    };

    text.oninput = () => { paint(text.value); apply(text.value); };

    box.append(label, swatch, text);
  }

  $('themeEditor').returnValue = '';
  $('themeEditor').showModal();
  $('themeEditor').addEventListener('close', async function once() {
    $('themeEditor').removeEventListener('close', once);
    if ($('themeEditor').returnValue !== 'save') {
      // 戻す。触っただけで決まってしまわないように。
      const r = await fetch('/api/theme').then((x) => x.json());
      applyTheme(r.theme, r.vars);
      return;
    }
    const r = await fetch('/api/theme', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...draft, base: before.id, id: 'custom', name: '自分の色' }),
    }).then((x) => x.json());
    applyTheme(r.theme, r.vars);
    if (r.repairs?.length) {
      // 受け取れなかった値は黙って捨てない。なぜ効かないのか分からなくなる。
      $('themeRepairs').textContent = r.repairs.map((x) => `・${x.detail}`).join('\n');
      $('themeEditor').showModal();
    }
  });
};

/* ---------- 出し入れ ---------- */

async function load() {
  const r = await fetch('/api/layout').then((x) => x.json());
  layout = r.layout;
  showRepairs(r.repairs);
  const sel = $('presets');
  sel.replaceChildren();
  for (const p of r.presets) {
    const o = document.createElement('option');
    o.value = p.id; o.textContent = p.name;
    sel.append(o);
  }
  sel.value = layout.id;
  render();
}

async function save(next) {
  const r = await fetch('/api/layout', {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(next),
  }).then((x) => x.json());
  layout = r.layout;
  showRepairs(r.repairs);
  return r;
}

function showRepairs(repairs) {
  if (!repairs || repairs.length === 0) return;
  // 直したことは黙らない。黙って直すと、次も同じ壊れ方をする。
  console.warn('配置を直しました:', repairs.map((x) => x.detail));
  $('status').textContent = `配置を直しました（${repairs.length}件）`;
}

async function refreshState() {
  try {
    lastState = await fetch('/api/state').then((x) => x.json());
    const m = lastState.models?.[0];
    $('sbModel').textContent = m?.modelId ?? m?.id ?? '—';
    for (const fn of stateHandlers) fn(lastState);
  } catch { /* 本体が止まっているだけ。画面は残す。 */ }
}

function listen() {
  const src = new EventSource('/api/events');
  const status = $('status');
  src.onopen = () => { status.textContent = 'つながっています'; status.className = 'status live'; };
  src.onerror = () => { status.textContent = '本体が止まっています'; status.className = 'status down'; };
  src.onmessage = (m) => {
    const e = JSON.parse(m.data);
    if (e.type === 'busy') {
      $('sbWork').textContent = e.busy ? '作業中…' : '待機中';
      $('sbWork').classList.toggle('busy', e.busy);
    }
    if (e.type === 'stateChanged') return void refreshState();
    if (e.type === 'themeChanged') return void loadTheme();
    if (e.type === 'thinkEvent') {
      $('sbWork').textContent = e.event.type === 'chose' ? `考え中: ${e.event.codename}` : '待機中';
    }
    for (const fn of eventHandlers.get(e.type) ?? []) fn(e);
  };
}

/* ---------- 配置を直接いじる ---------- */

$('edit').onclick = () => {
  $('json').value = JSON.stringify(layout, null, 2);
  $('repairs').textContent = '';
  $('editor').showModal();
};

$('editor').addEventListener('close', async () => {
  if ($('editor').returnValue !== 'apply') return;
  let parsed;
  try {
    parsed = JSON.parse($('json').value);
  } catch (e) {
    // 読めない JSON でも捨てない。直して開き直す。
    $('repairs').textContent = `読めませんでした: ${e.message}`;
    $('editor').showModal();
    return;
  }
  const r = await save(parsed);
  render();
  if (r.repairs?.length) {
    $('json').value = JSON.stringify(r.layout, null, 2);
    $('repairs').textContent = r.repairs.map((x) => `・${x.detail}`).join('\n');
    $('editor').showModal();
  }
});

$('presets').onchange = async (e) => {
  const r = await fetch('/api/layout/preset', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: e.target.value }),
  }).then((x) => x.json());
  layout = r.layout;
  render();
};

/* ---------- コマンド ---------- */

/**
 * 更新。押した瞬間に取ってくるのではなく、まず何が入るのかを見せる。
 * 中身を見ずに新しくするのは、動いているものを賭けに出すのと同じ。
 */
async function checkForUpdate() {
  const status = await (await fetch('/api/update')).json();
  if (!status.can) {
    alert(status.reason || '更新できません');
    return;
  }
  const list = status.incoming.map((c) => `  ${c}`).join('\n');
  if (!confirm(`${status.behind}件の変更があります。\n\n${list}\n\n取り込みますか？`)) return;

  const result = await (await fetch('/api/update', { method: 'POST' })).json();
  // 取り込んだ後は、動いているコードと置いてあるコードがズレている。
  // ここで再起動せず、人に立ち上げ直してもらう。
  alert(result.message || result.error || '更新しました');
}

/**
 * 何ができるかを、覚えていなくても引ける形にする。
 * 隠し機能は無い機能と同じなので、全部ここに並べる。
 */
function commands() {
  const list = [
    { name: '入力へ移動', hint: 'Ctrl+/', run: () => ctx.focusInput() },
    { name: '中断する', hint: '', run: () => fetch('/api/abort', { method: 'POST' }) },
    { name: 'いま考えさせる', hint: '', run: () => fetch('/api/think', { method: 'POST' }) },
    { name: '更新を確認する', hint: '', run: () => checkForUpdate() },
    { name: '配置を編集', hint: '', run: () => $('edit').click() },
    { name: '色を編集', hint: '', run: () => $('editTheme').click() },
  ];
  for (const o of $('themes').options) {
    list.push({ name: `見た目: ${o.textContent}`, hint: '', run: () => {
      $('themes').value = o.value; $('themes').onchange({ target: $('themes') });
    } });
  }
  for (const o of $('presets').options) {
    list.push({ name: `配置: ${o.textContent}`, hint: '', run: () => {
      $('presets').value = o.value; $('presets').onchange({ target: $('presets') });
    } });
  }
  return list;
}

function openPalette() {
  const dlg = $('palette');
  const input = $('paletteInput');
  const listBox = $('paletteList');
  const all = commands();
  let cursor = 0;
  let shown = all;

  const draw = () => {
    listBox.replaceChildren();
    shown.forEach((cmd, i) => {
      const row = document.createElement('div');
      row.className = `palette-row${i === cursor ? ' on' : ''}`;
      const name = document.createElement('span');
      name.textContent = cmd.name;
      const hint = document.createElement('span');
      hint.className = 'dim';
      hint.textContent = cmd.hint;
      row.append(name, hint);
      row.onclick = () => { dlg.close(); cmd.run(); };
      listBox.append(row);
    });
  };

  input.value = '';
  input.oninput = () => {
    const q = input.value.trim().toLowerCase();
    shown = q ? all.filter((c) => c.name.toLowerCase().includes(q)) : all;
    cursor = 0;
    draw();
  };
  input.onkeydown = (e) => {
    if (e.key === 'ArrowDown') { cursor = Math.min(cursor + 1, shown.length - 1); draw(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { cursor = Math.max(cursor - 1, 0); draw(); e.preventDefault(); }
    else if (e.key === 'Enter') { e.preventDefault(); const c = shown[cursor]; dlg.close(); c?.run(); }
  };
  draw();
  dlg.showModal();
  input.focus();
}

$('open').onclick = openPalette;

/* ---------- 設定 ----------
 *
 * cmd の窓でしか見られなかったもの（版・置き場・環境）と、
 * 見た目・配置・点検を、一つにまとめる。**探し回らせない。**
 */
function showSection(name) {
  for (const b of $('settings').querySelectorAll('.tabs-lite button')) {
    b.classList.toggle('on', b.dataset.sec === name);
  }
  for (const sec of $('settings').querySelectorAll('section[data-sec]')) {
    sec.hidden = sec.dataset.sec !== name;
  }
}

const INFO_LABELS = {
  version: '版', node: 'Node', platform: 'この機械', portable: '持ち運び',
  productRoot: 'プログラム', home: '置き場（根）', stateDir: '記録',
  modelsDir: 'モデル', binDir: '実行ファイル', url: '画面',
  runtime: 'モデルの土台', model: 'いまのモデル',
};

async function loadInfo() {
  const info = await fetch('/api/info').then((r) => r.json()).catch(() => null);
  const box = $('infoRows');
  box.replaceChildren();
  if (!info) {
    box.append(Object.assign(document.createElement('div'), {
      className: 'empty', textContent: '情報を取れませんでした。' }));
    return;
  }
  for (const [key, label] of Object.entries(INFO_LABELS)) {
    if (!(key in info)) continue;
    const row = document.createElement('div');
    row.className = 'row';
    const k = document.createElement('span');
    k.className = 'dim';
    k.textContent = label;
    const v = document.createElement('span');
    v.className = 'mono';
    v.textContent = typeof info[key] === 'boolean'
      ? (info[key] ? 'はい' : 'いいえ')
      : String(info[key]);
    row.append(k, v);
    box.append(row);
  }
}

/** いまの設定を読み出して、画面へ映す。 */
async function loadCfg() {
  const c = await fetch('/api/config').then((r) => r.json()).catch(() => null);
  if (!c) return;
  const sel = $('cfgKind');
  sel.replaceChildren();
  for (const k of c.kinds ?? []) {
    const o = document.createElement('option');
    o.value = k.id;
    o.textContent = k.name;
    if (k.id === c.kind) o.selected = true;
    sel.append(o);
  }
  $('cfgModelsDir').value = c.modelsDir ?? '';
  // 保存してあるものと、いま動いているものは別。黙って同じ顔をさせない。
  $('cfgNote').textContent = c.restartNeeded
    ? `保存済み。いま動いているのは「${c.active?.kind ?? '?'}」です。立ち上げ直すと切り替わります。`
    : `設定ファイル: ${c.path}`;

  const box = $('cfgGguf');
  box.replaceChildren();
  if (!c.gguf?.length) {
    const e = document.createElement('div');
    e.className = 'empty';
    // ここで止まる人がいちばん多い。**次に何をすればいいかまで書く。**
    e.textContent = 'ありません。上の置き場に .gguf を1つ入れると、ここに出ます。\n'
      + '取ってくる先の例: https://huggingface.co/Qwen （名前に GGUF が付いたもの）\n'
      + '迷ったら 3B の Q4_K_M（約2GB）。要約や下書きなら足ります。';
    e.style.whiteSpace = 'pre-line';
    box.append(e);
    return;
  }
  for (const m of c.gguf) {
    const row = document.createElement('div');
    row.className = 'row';
    const k = document.createElement('span');
    k.className = 'mono';
    k.textContent = m.ref;
    const v = document.createElement('span');
    v.className = 'dim mono';
    v.textContent = m.sizeBytes ? `${(m.sizeBytes / 1024 ** 3).toFixed(1)} GB` : '';
    row.append(k, v);
    box.append(row);
  }
}

$('cfgReload').onclick = () => { void loadCfg(); };
$('cfgSave').onclick = async () => {
  const r = await fetch('/api/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: $('cfgKind').value, modelsDir: $('cfgModelsDir').value.trim() }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) { $('cfgNote').textContent = body.error ?? '保存できませんでした'; return; }
  // 黙って効いた顔をしない。切り替えは立ち上げ直すまで効かない。
  $('cfgNote').textContent = body.restartNeeded
    ? `保存しました。**立ち上げ直すと効きます。** ${body.path}`
    : `保存しました。${body.path}`;
  await loadCfg();
};

let checksReady = false;
async function loadChecks() {
  if (checksReady) return;
  checksReady = true;
  const bar = $('settingsChecks');
  const out = $('settingsCheckOut');
  const { tasks } = await fetch('/api/tasks').then((r) => r.json()).catch(() => ({ tasks: [] }));
  const buttons = [];
  for (const t of tasks ?? []) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = t.name;
    b.onclick = async () => {
      out.textContent = '';
      for (const x of buttons) x.disabled = true;
      const r = await fetch('/api/task', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: t.id }),
      });
      if (!r.ok) {
        for (const x of buttons) x.disabled = false;
        out.textContent = (await r.json().catch(() => ({}))).error ?? '始められませんでした';
      }
    };
    buttons.push(b);
    bar.append(b);
  }
  ctx.on('task', (e) => {
    out.append(document.createTextNode(e.text));
    out.scrollTop = out.scrollHeight;
  });
  ctx.on('taskDone', (e) => {
    for (const x of buttons) x.disabled = false;
    out.append(document.createTextNode(
      e.code === 0 ? '\n— 終わりました —\n' : `\n— 終了コード ${e.code} —\n`));
    out.scrollTop = out.scrollHeight;
  });
}

async function openSettings(section = 'info') {
  showSection(section);
  await loadInfo();
  if (section === 'check') await loadChecks();
  if (section === 'model') await loadCfg();
  $('settings').showModal();
}

for (const b of $('settings').querySelectorAll('.tabs-lite button')) {
  b.onclick = async () => {
    showSection(b.dataset.sec);
    if (b.dataset.sec === 'check') await loadChecks();
    if (b.dataset.sec === 'info') await loadInfo();
    if (b.dataset.sec === 'model') await loadCfg();
  };
}
$('openSettings').onclick = () => { void openSettings(); };

window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); openPalette(); }
  else if ((e.ctrlKey || e.metaKey) && e.key === '/') { e.preventDefault(); ctx.focusInput(); }
  else if ((e.ctrlKey || e.metaKey) && e.key === ',') { e.preventDefault(); void openSettings(); }
});

await loadTheme();
await load();
await refreshState();
listen();
setInterval(refreshState, 5000);
