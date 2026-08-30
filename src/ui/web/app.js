/**
 * 配置(JSON)から画面を組み立てる。
 *
 * 画面の形はここでは決めない。決めているのは配置の方。
 * ここがやるのは、配置の通りに並べることと、
 * 仕切りを掴んで動かしたら配置に書き戻すことだけ。
 */
import { PANELS, TITLES } from './panels.js';

const root = document.getElementById('editor');
const $ = (id) => document.getElementById(id);

let layout = null;
const stateHandlers = [];
const eventHandlers = new Map();

const ctx = {
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

  const built = node.panels.map((id) => {
    const spec = panels.get(id);
    return spec ? buildPanel(spec) : null;
  }).filter(Boolean);

  const show = (i) => {
    body.replaceChildren();
    const chosen = built[i];
    if (!chosen) return;
    // 見出しは重ね置き側が持つので、中身だけを移す
    body.append(chosen.querySelector('.body'));
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

  show(Math.min(node.active ?? 0, built.length - 1));
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
  document.documentElement.dataset.theme = layout.theme === 'auto' ? '' : layout.theme;
  document.documentElement.dataset.density = layout.density ?? 'comfortable';
  const panels = new Map(layout.panels.map((p) => [p.id, p]));
  const view = buildNode(layout.root, panels);
  view.style.height = '100%';
  $('root').replaceChildren(view);
  if (lastState) for (const fn of stateHandlers) fn(lastState);
}

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
    if (e.type === 'stateChanged') return void refreshState();
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

await load();
await refreshState();
listen();
setInterval(refreshState, 5000);
