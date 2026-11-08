/**
 * ブロックでつくる画面。中身（型・つなぐ・JavaScript を作る・保存の形）は blocks-core.js。
 * ここは置く・引く・つなぐ・動かすの手ざわりだけを持つ。設計は docs/BLOCKS.md。
 */
import {
  BLOCKS, TYPES, TRIGGERS, DIRECTIONS, canConnect, portOf, makeNode, emptyGraph, nextId, connect, removeNodes,
  duplicateNodes, compile, wrapForNode, run, makeHistory, searchBlocks, graphFormatGuide, emptyWorkflow, makeStep,
  walkSteps, nextStepId, availableOutputs, compileWorkflow, runWorkflow, graphToWorkflow, workflowToGraph, dailyDue,
  serializeFile, parseFile, isDirection, autoLayout, sampleFizzBuzz, sampleHello, sampleUmbrella, parseGraph,
} from './blocks-core.js';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c !== undefined && c !== null) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
};
const api = async (path, init) => {
  try {
    const r = await fetch(path, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
    const body = await r.json().catch(() => ({ error: `返事を読めませんでした（${r.status}）` }));
    return { status: r.status, body: r.ok ? body : { error: `${r.status}`, ...body } };
  } catch (e) {
    // 本体に繋がらない（止まっている）。黙らずに言う
    return { status: 0, body: { error: `本体に繋がりません: ${e.message}` } };
  }
};

/* ---------- 状態 ---------- */
const S = {
  view: 'graph',
  dir: 'ltr',
  graph: emptyGraph(),
  workflow: emptyWorkflow(),
  fileName: '',
  selected: new Set(),
  pan: { x: 0, y: 0 },
  zoom: 1,
  shown: new Map(),
  failed: undefined,
};
const history = makeHistory();
const snapshot = () => serializeFile(S.graph, S.workflow, S.view);
let lastSnap;
/** 変えたあとに呼ぶ。変える前の形を「元に戻す」へ積む。 */
function remember() {
  const now = snapshot();
  if (lastSnap !== undefined && lastSnap !== now) history.push(lastSnap);
  lastSnap = now;
  updateUndo();
}
function restore(text) {
  const got = parseFile(text);
  S.graph = got.graph;
  S.workflow = got.workflow ?? emptyWorkflow();
  S.view = got.view;
  S.selected.clear();
  lastSnap = text;
  renderAll();
}
function changed() { renderCode(); }

const note = (text) => { $('note').textContent = text; };

/* ---------- ブロックの一覧 ---------- */
function renderPalette() {
  const box = $('blockList');
  box.textContent = '';
  const groups = new Map();
  for (const [kind, d] of Object.entries(BLOCKS)) {
    if (!groups.has(d.group)) groups.set(d.group, []);
    groups.get(d.group).push([kind, d]);
  }
  for (const [g, items] of groups) {
    box.append(el('h4', {}, g));
    for (const [kind, d] of items) {
      const b = el('button', { type: 'button', class: 'bk-pal-item', dataset: { kind }, title: `${d.title}を置く（引いて置くか、押すと真ん中に置きます）` }, d.title);
      b.addEventListener('pointerdown', (e) => startPaletteDrag(e, kind));
      box.append(b);
    }
  }
}

function startPaletteDrag(e, kind) {
  e.preventDefault();
  const sx = e.clientX;
  const sy = e.clientY;
  let ghost;
  const move = (ev) => {
    if (!ghost && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 4) {
      ghost = el('div', { class: 'bk-node', style: 'pointer-events:none;opacity:.8;position:fixed;z-index:30' }, el('div', { class: 'bk-node-head' }, BLOCKS[kind].title));
      document.body.append(ghost);
    }
    if (ghost) { ghost.style.left = `${ev.clientX - 20}px`; ghost.style.top = `${ev.clientY - 12}px`; }
  };
  const up = (ev) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    ghost?.remove();
    if (S.view === 'flow') { addStepAtEnd(kind); return; }
    const r = $('stage').getBoundingClientRect();
    const inside = ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
    if (ghost && inside) addNodeAt(kind, ev.clientX, ev.clientY);
    else if (!ghost) addNodeAt(kind, r.left + r.width / 2 + (S.graph.nodes.length % 5) * 20, r.top + r.height / 3 + (S.graph.nodes.length % 5) * 20);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function toWorld(cx, cy) {
  const r = $('stage').getBoundingClientRect();
  return { x: (cx - r.left - S.pan.x) / S.zoom, y: (cy - r.top - S.pan.y) / S.zoom };
}

function addNodeAt(kind, cx, cy) {
  const p = toWorld(cx, cy);
  const n = makeNode(kind, nextId(S.graph), Math.round(p.x - 20), Math.round(p.y - 12));
  S.graph.nodes.push(n);
  S.selected = new Set([n.id]);
  remember();
  renderGraph();
  changed();
  note(`「${BLOCKS[kind].title}」を置きました。丸い口を引いて、ほかのブロックの口へつなぎます`);
}

/* ---------- つなぐ形 ---------- */
function portPoint(nodeEl, side, index, count, rowEl) {
  const w = nodeEl.offsetWidth;
  const h = nodeEl.offsetHeight;
  if (S.dir === 'ltr' && rowEl) return { x: side === 'out' ? w : 0, y: rowEl.offsetTop + rowEl.offsetHeight / 2 };
  if (S.dir === 'ttb') return { x: (w * (index + 1)) / (count + 1), y: side === 'out' ? h : 0 };
  // 左上から右下: 入る口は上の左半分、出る口は下の右半分
  return side === 'out' ? { x: w / 2 + (w / 2) * ((index + 1) / (count + 1)), y: h } : { x: (w / 2) * ((index + 1) / (count + 1)), y: 0 };
}

function linkInto(nodeId, port) {
  return S.graph.links.find((l) => l.to.node === nodeId && l.to.port === port);
}

function editorFor(kindLike, value, onChange, choices) {
  if (kindLike === 'choice') {
    const s = el('select', { onchange: () => onChange(s.value) }, choices.map((c) => el('option', { value: c }, c)));
    s.value = value;
    return s;
  }
  if (kindLike === 'bool') {
    const c = el('input', { type: 'checkbox', onchange: () => onChange(c.checked) });
    c.checked = value === true;
    return c;
  }
  const i = el('input', { type: kindLike === 'num' ? 'number' : 'text', value: value ?? '', onchange: () => onChange(kindLike === 'num' ? Number(i.value) : i.value) });
  i.addEventListener('keydown', (e) => e.stopPropagation());
  return i;
}

function renderNode(n) {
  const def = BLOCKS[n.kind];
  const box = el('div', { class: `bk-node${S.selected.has(n.id) ? ' selected' : ''}${S.failed?.node === n.id ? ' failed' : ''}`, dataset: { id: n.id, kind: n.kind } });
  box.style.left = `${n.x}px`;
  box.style.top = `${n.y}px`;
  const head = el('div', { class: 'bk-node-head', title: '引いて動かす' }, def.title,
    el('button', { type: 'button', class: 'ghost icon bk-x', title: 'このブロックを消す (Delete)', onclick: (e) => { e.stopPropagation(); deleteNodes([n.id]); } }, '×'));
  head.addEventListener('pointerdown', (e) => startNodeDrag(e, n));
  const body = el('div', { class: 'bk-node-body' });
  const rows = { in: [], out: [] };
  for (const f of def.fields) {
    body.append(el('div', { class: 'bk-row field' }, el('span', {}, f.label),
      editorFor(f.kind, n.values[f.name], (v) => { n.values[f.name] = v; remember(); changed(); }, f.choices)));
  }
  for (const p of def.inputs) {
    const linked = linkInto(n.id, p.name);
    const row = el('div', { class: 'bk-row in', dataset: { port: p.name } }, el('span', {}, p.label));
    if (linked) row.append(el('span', { class: 'bk-linked' }, '← つないだ値'));
    else row.append(editorFor(p.type === 'any' ? 'text' : p.type, n.values[p.name], (v) => { n.values[p.name] = v; remember(); changed(); }));
    body.append(row);
    rows.in.push(row);
  }
  for (const p of def.outputs) {
    const row = el('div', { class: 'bk-row out', dataset: { port: p.name } }, `${p.label}（${TYPES[p.type].label}）`);
    body.append(row);
    rows.out.push(row);
  }
  box.append(head, body);
  if (S.shown.has(n.id)) box.append(el('div', { class: 'bk-shown', title: '動かしたときに出したもの' }, S.shown.get(n.id).join('\n')));
  if (S.failed?.node === n.id) box.append(el('div', { class: 'bk-fail' }, `ここで止まりました: ${S.failed.message}`));
  box.addEventListener('pointerdown', (e) => {
    if (e.target.closest('input,select,button,.bk-port')) return;
    if (e.shiftKey) S.selected.has(n.id) ? S.selected.delete(n.id) : S.selected.add(n.id);
    else if (!S.selected.has(n.id)) S.selected = new Set([n.id]);
    for (const x of document.querySelectorAll('.bk-node')) x.classList.toggle('selected', S.selected.has(x.dataset.id));
  });
  $('world').append(box);
  // 口は描いたあとに置く（大きさが要る）
  const place = (side, list, rowsOf) => list.forEach((p, i) => {
    const pt = portPoint(box, side, i, list.length, rowsOf[i]);
    const dot = el('span', { class: `bk-port ${side}`, dataset: { port: p.name, type: p.type, node: n.id }, title: `${p.label}（${TYPES[p.type].label}）` });
    dot.style.left = `${pt.x}px`;
    dot.style.top = `${pt.y}px`;
    dot.addEventListener('pointerdown', (e) => startWire(e, n, side, p));
    box.append(dot);
  });
  place('in', def.inputs, rows.in);
  place('out', def.outputs, rows.out);
}

function portCenter(nodeId, side, port) {
  const dot = document.querySelector(`.bk-node[data-id="${nodeId}"] .bk-port.${side}[data-port="${port}"]`);
  const box = dot?.parentElement;
  if (!dot || !box) return undefined;
  return { x: box.offsetLeft + dot.offsetLeft, y: box.offsetTop + dot.offsetTop };
}

function wirePath(a, b) {
  const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
  const dy = Math.max(40, Math.abs(b.y - a.y) / 2);
  if (S.dir === 'ltr') return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
  if (S.dir === 'ttb') return `M${a.x},${a.y} C${a.x},${a.y + dy} ${b.x},${b.y - dy} ${b.x},${b.y}`;
  return `M${a.x},${a.y} C${a.x + dx / 2},${a.y + dy} ${b.x - dx / 2},${b.y - dy} ${b.x},${b.y}`;
}

function renderWires() {
  const svg = $('wires');
  svg.textContent = '';
  for (const l of S.graph.links) {
    const a = portCenter(l.from.node, 'out', l.from.port);
    const b = portCenter(l.to.node, 'in', l.to.port);
    if (!a || !b) continue;
    const from = S.graph.nodes.find((n) => n.id === l.from.node);
    const type = portOf(from.kind, 'out', l.from.port).type;
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', wirePath(a, b));
    p.setAttribute('stroke', `var(--port-${type})`);
    p.dataset.from = `${l.from.node}.${l.from.port}`;
    p.dataset.to = `${l.to.node}.${l.to.port}`;
    svg.append(p);
  }
}

function applyView() {
  $('world').style.transform = `translate(${S.pan.x}px, ${S.pan.y}px) scale(${S.zoom})`;
}

/** 全部のブロックが見えるように、大きさと位置を合わせる（大きくはしない） */
function fitView() {
  if (!S.graph.nodes.length) { S.pan = { x: 0, y: 0 }; S.zoom = 1; return; }
  const r = $('stage').getBoundingClientRect();
  const xs = S.graph.nodes.map((n) => n.x);
  const ys = S.graph.nodes.map((n) => n.y);
  const x0 = Math.min(...xs) - 20;
  const y0 = Math.min(...ys) - 20;
  const w = Math.max(...xs) + 240 - x0;
  const h = Math.max(...ys) + 280 - y0;
  S.zoom = Math.max(0.3, Math.min(1, r.width / w, r.height / h));
  S.pan = { x: -x0 * S.zoom, y: -y0 * S.zoom };
}

function renderGraph() {
  for (const x of [...document.querySelectorAll('.bk-node')]) x.remove();
  for (const n of S.graph.nodes) renderNode(n);
  renderWires();
  applyView();
  $('emptyHint').hidden = S.graph.nodes.length > 0;
}

function startNodeDrag(e, n) {
  if (e.target.closest('button')) return;
  e.preventDefault();
  if (!S.selected.has(n.id)) S.selected = new Set([n.id]);
  const moving = S.graph.nodes.filter((m) => S.selected.has(m.id));
  const start = moving.map((m) => ({ m, x: m.x, y: m.y }));
  const sx = e.clientX;
  const sy = e.clientY;
  let moved = false;
  const move = (ev) => {
    moved = true;
    for (const s of start) {
      s.m.x = Math.round(s.x + (ev.clientX - sx) / S.zoom);
      s.m.y = Math.round(s.y + (ev.clientY - sy) / S.zoom);
      const box = document.querySelector(`.bk-node[data-id="${s.m.id}"]`);
      if (box) { box.style.left = `${s.m.x}px`; box.style.top = `${s.m.y}px`; }
    }
    renderWires();
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    if (moved) remember();
    renderGraph();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

/** 口を引いて線をつなぐ。入る口から引くと、つないでいた線を外して付け替える。 */
function startWire(e, n, side, p) {
  e.preventDefault();
  e.stopPropagation();
  let from = side === 'out' ? { node: n.id, port: p.name, type: p.type } : undefined;
  if (side === 'in') {
    const l = linkInto(n.id, p.name);
    if (!l) { note('入る口からは引けません。出る口（右や下の丸）から引いて、ここへつないでください'); return; }
    S.graph.links = S.graph.links.filter((x) => x !== l);
    const src = S.graph.nodes.find((m) => m.id === l.from.node);
    from = { node: l.from.node, port: l.from.port, type: portOf(src.kind, 'out', l.from.port).type };
    renderWires();
  }
  const a = portCenter(from.node, 'out', from.port);
  const svg = $('wires');
  const temp = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  temp.setAttribute('class', 'temp');
  temp.setAttribute('stroke', `var(--port-${from.type})`);
  svg.append(temp);
  let over;
  const move = (ev) => {
    const b = toWorld(ev.clientX, ev.clientY);
    temp.setAttribute('d', wirePath(a, b));
    over?.classList.remove('drop-ok', 'drop-ng');
    over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.bk-port.in');
    if (over) over.classList.add(canConnect(from.type, over.dataset.type).ok ? 'drop-ok' : 'drop-ng');
  };
  const up = (ev) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    temp.remove();
    over?.classList.remove('drop-ok', 'drop-ng');
    const target = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.bk-port.in');
    if (target) {
      const got = connect(S.graph, { node: from.node, port: from.port }, { node: target.dataset.node, port: target.dataset.port });
      if (!got.ok) note(`つなげません: ${got.why}`);
      else note('');
    }
    remember();
    renderGraph();
    changed();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function deleteNodes(ids) {
  if (!ids.length) return;
  removeNodes(S.graph, ids);
  for (const id of ids) S.selected.delete(id);
  remember();
  renderGraph();
  changed();
  note(`${ids.length} 個のブロックを消しました（↶ で戻せます）`);
}

/* 何も無い所: 引くと全体を動かす、回すと大きさ、ダブルクリックで探して足す */
function wireStage() {
  const stage = $('stage');
  stage.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.bk-node')) return;
    S.selected.clear();
    for (const x of document.querySelectorAll('.bk-node.selected')) x.classList.remove('selected');
    const sx = e.clientX - S.pan.x;
    const sy = e.clientY - S.pan.y;
    const move = (ev) => { S.pan.x = ev.clientX - sx; S.pan.y = ev.clientY - sy; applyView(); };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = stage.getBoundingClientRect();
    const before = toWorld(e.clientX, e.clientY);
    S.zoom = Math.min(2, Math.max(0.3, S.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
    S.pan.x = e.clientX - r.left - before.x * S.zoom;
    S.pan.y = e.clientY - r.top - before.y * S.zoom;
    applyView();
  }, { passive: false });
  stage.addEventListener('dblclick', (e) => {
    if (e.target.closest('.bk-node')) return;
    openFinder(e.clientX, e.clientY);
  });
}

function openFinder(cx, cy) {
  const f = $('finder');
  f.hidden = false;
  f.style.left = `${cx}px`;
  f.style.top = `${cy}px`;
  const input = $('finderInput');
  input.value = '';
  const list = () => {
    const box = $('finderList');
    box.textContent = '';
    for (const hit of searchBlocks(input.value)) {
      box.append(el('button', { type: 'button', class: 'ghost', onclick: () => { f.hidden = true; if (S.view === 'flow') addStepAtEnd(hit.kind); else addNodeAt(hit.kind, cx, cy); } }, `${hit.title}`, el('span', { class: 'dim' }, `  ${hit.group}`)));
    }
  };
  input.oninput = list;
  input.onkeydown = (e) => {
    if (e.key === 'Escape') f.hidden = true;
    if (e.key === 'Enter' && !e.isComposing) $('finderList').querySelector('button')?.click();
    e.stopPropagation();
  };
  list();
  input.focus();
}
document.addEventListener('pointerdown', (e) => { if (!e.target.closest('#finder')) $('finder').hidden = true; if (!e.target.closest('.bk-menu')) document.querySelector('.bk-menu')?.remove(); }, true);

/* ---------- 手順の形 ---------- */
function stepTitle(s) { return s.kind === 'cond' ? '条件' : BLOCKS[s.kind]?.title ?? s.kind; }

function menu(at, items) {
  document.querySelector('.bk-menu')?.remove();
  const r = at.getBoundingClientRect();
  const m = el('div', { class: 'bk-menu', role: 'menu' }, items.map(([label, fn]) => el('button', { type: 'button', class: 'ghost', role: 'menuitem', onclick: () => { m.remove(); fn(); } }, label)));
  m.style.left = `${r.left}px`;
  m.style.top = `${r.bottom + 4}px`;
  document.body.append(m);
}

function addMenu(at, list) {
  const items = [['条件（はい・いいえに分かれる）', () => insertStep(list, 'cond')]];
  for (const [kind, d] of Object.entries(BLOCKS)) items.push([d.title, () => insertStep(list, kind)]);
  menu(at, items);
}

function insertStep(list, kind) {
  const s = makeStep(kind, nextStepId(S.workflow));
  list.push(s);
  remember();
  renderFlow();
  changed();
}
function addStepAtEnd(kind) { insertStep(S.workflow.steps, kind); }

function fieldRow(step, p, wfList) {
  const v = step.values[p.name];
  const row = el('div', { class: 'bk-field', dataset: { field: p.name } }, el('span', {}, p.label));
  if (v && typeof v === 'object' && v.ref) {
    const src = availableOutputs(S.workflow, step.id).find((o) => o.node === v.ref && o.port === v.port);
    row.append(el('span', { class: 'bk-chip', title: '前の手順の出力' }, src?.label ?? `${v.ref} の ${v.port}（見つかりません）`,
      el('button', { type: 'button', title: 'はずす', onclick: () => { step.values[p.name] = p.default ?? ''; remember(); renderFlow(); changed(); } }, '×')));
  } else {
    const kindLike = p.kind ?? (p.type === 'any' ? 'text' : p.type);
    row.append(editorFor(kindLike, v, (nv) => { step.values[p.name] = nv; remember(); changed(); }, p.choices));
  }
  if (!p.kind) {
    row.append(el('button', { type: 'button', class: 'ghost', title: '前の手順の出力を使う', onclick: (e) => {
      const outs = availableOutputs(S.workflow, step.id).filter((o) => canConnect(o.type, p.type).ok);
      if (!outs.length) { note('使える前の出力がありません（前に手順を置くと選べます）'); return; }
      menu(e.currentTarget, outs.map((o) => [o.label, () => { step.values[p.name] = { ref: o.node, port: o.port }; remember(); renderFlow(); changed(); }]));
    } }, '＋ 前の出力'));
  } else row.append(el('span'));
  return row;
}

function renderSteps(list, host) {
  const box = el('div', { class: 'bk-steps' });
  list.forEach((s, i) => {
    if (i > 0) box.append(el('div', { class: 'bk-join' }));
    const card = el('div', { class: `bk-step${S.failed?.node === s.id ? ' failed' : ''}`, dataset: { step: s.id, kind: s.kind } });
    const head = el('div', { class: 'bk-step-head' }, el('span', { class: 'grow' }, `${i + 1}. ${stepTitle(s)}`),
      el('button', { type: 'button', class: 'ghost icon', title: '前へ', onclick: () => { if (i > 0) { list.splice(i - 1, 0, list.splice(i, 1)[0]); remember(); renderFlow(); changed(); } } }, '↑'),
      el('button', { type: 'button', class: 'ghost icon', title: '後ろへ', onclick: () => { if (i < list.length - 1) { list.splice(i + 1, 0, list.splice(i, 1)[0]); remember(); renderFlow(); changed(); } } }, '↓'),
      el('button', { type: 'button', class: 'ghost icon', title: 'この手順を消す', onclick: () => { list.splice(i, 1); remember(); renderFlow(); changed(); } }, '×'));
    const body = el('div', { class: 'bk-step-body' });
    if (s.kind === 'cond') body.append(fieldRow(s, { name: 'cond', label: 'もし', type: 'bool', default: false }));
    else {
      const def = BLOCKS[s.kind];
      for (const f of def.fields) body.append(fieldRow(s, { ...f, kind: f.kind }));
      for (const p of def.inputs) body.append(fieldRow(s, p));
    }
    if (S.shown.has(s.id)) body.append(el('div', { class: 'bk-shown' }, S.shown.get(s.id).join('\n')));
    if (S.failed?.node === s.id) body.append(el('div', { class: 'bk-fail' }, `ここで止まりました: ${S.failed.message}`));
    card.append(head, body);
    if (s.kind === 'cond') {
      const br = el('div', { class: 'bk-branches' });
      for (const [key, label] of [['yes', 'はいのとき'], ['no', 'いいえのとき']]) {
        const b = el('div', { class: 'bk-branch', dataset: { branch: key } }, el('h5', {}, label));
        renderSteps(s[key], b);
        b.append(el('button', { type: 'button', class: 'ghost bk-add', onclick: (e) => addMenu(e.currentTarget, s[key]) }, '＋ 手順を足す'));
        br.append(b);
      }
      card.append(br);
    }
    if (s.kind === 'repeat') {
      const b = el('div', { class: 'bk-body', dataset: { branch: 'body' } }, el('h5', { class: 'dim' }, 'くり返す中身（「今の数」を前の出力から選べます）'));
      renderSteps(s.body, b);
      b.append(el('button', { type: 'button', class: 'ghost bk-add', onclick: (e) => addMenu(e.currentTarget, s.body) }, '＋ 手順を足す'));
      card.append(b);
    }
    box.append(card);
  });
  host.append(box);
}

function renderFlow() {
  const f = $('flow');
  f.textContent = '';
  f.className = `bk-flow dir-${S.dir === 'ltr' ? 'ltr' : 'ttb'}`;
  const t = S.workflow.trigger;
  const kindSel = editorFor('choice', TRIGGERS[t.kind] ? TRIGGERS[t.kind].title : TRIGGERS.manual.title, (v) => {
    t.kind = Object.entries(TRIGGERS).find(([, d]) => d.title === v)?.[0] ?? 'manual';
    remember(); renderFlow(); changed(); armTrigger();
  }, Object.values(TRIGGERS).map((d) => d.title));
  kindSel.id = 'triggerKind';
  const trig = el('div', { class: 'bk-step trigger', dataset: { step: 'trigger' } },
    el('div', { class: 'bk-step-head' }, el('span', { class: 'grow' }, 'きっかけ')),
    el('div', { class: 'bk-step-body' },
      el('div', { class: 'bk-field' }, el('span', {}, 'いつ'), kindSel, el('span')),
      t.kind === 'daily' ? el('div', { class: 'bk-field' }, el('span', {}, '時刻'), editorFor('text', t.time ?? '08:00', (v) => { t.time = v; remember(); armTrigger(); }), el('span')) : null,
      t.kind === 'newFile' ? el('div', { class: 'bk-field' }, el('span', {}, 'フォルダ'), editorFor('text', t.folder ?? '.', (v) => { t.folder = v; remember(); armTrigger(); }), el('span')) : null,
      t.kind !== 'manual' ? el('p', { class: 'dim' }, 'この画面を開いている間だけ見張ります（閉じると止まります）。▶ 動かす でいつでも試せます') : null));
  f.append(trig, el('div', { class: 'bk-join' }));
  renderSteps(S.workflow.steps, f);
  f.append(el('button', { type: 'button', class: 'ghost bk-add', id: 'addStep', onclick: (e) => addMenu(e.currentTarget, S.workflow.steps) }, '＋ 手順を足す'));
}

/* ---------- きっかけの見張り（画面を開いている間だけ） ---------- */
let timer;
let lastDaily = '';
let fileCount;
async function countFiles(folder) {
  const r = await api(`/api/files?path=${encodeURIComponent(folder || '.')}`);
  return Array.isArray(r.body.entries) ? r.body.entries.length : undefined;
}
function armTrigger() {
  clearInterval(timer);
  fileCount = undefined;
  const t = S.workflow.trigger;
  if (t.kind === 'manual') return;
  if (t.kind === 'newFile') void countFiles(t.folder).then((n) => { fileCount = n; });
  timer = setInterval(async () => {
    if (S.view !== 'flow') return;
    if (t.kind === 'daily' && dailyDue(t.time)) {
      const key = new Date().toISOString().slice(0, 16);
      if (key !== lastDaily) { lastDaily = key; await runNow(`毎日 ${t.time} になったので`); }
    }
    if (t.kind === 'newFile') {
      const n = await countFiles(t.folder);
      if (n !== undefined && fileCount !== undefined && n > fileCount) await runNow('フォルダにファイルが増えたので');
      if (n !== undefined) fileCount = n;
    }
  }, 15_000);
}

/* ---------- JavaScript ---------- */
function currentCode() {
  if (S.view === 'flow') return compileWorkflow(S.workflow);
  return compile(S.graph);
}
function renderCode() {
  const { code, errors } = currentCode();
  $('code').textContent = code || '// ブロックを置くと、ここに同じ中身の JavaScript が出ます';
  if (errors.length) note(`直すところがあります: ${errors[0].message}`);
}

/* ---------- 動かす ---------- */
function askApproval(name, content) {
  return new Promise((resolve) => {
    const d = $('approve');
    $('approveText').textContent = `作業場の「${name}」に書きます。よければ「許可」を押してください。`;
    $('approvePreview').textContent = content.slice(0, 2000);
    d.onclose = () => resolve(d.returnValue === 'yes');
    d.returnValue = '';
    d.showModal();
  });
}

const runtime = {
  show(v, id) {
    const text = typeof v === 'string' ? v : JSON.stringify(v);
    $('out').append(el('div', { class: 'line' }, text));
    if (!S.shown.has(id)) S.shown.set(id, []);
    S.shown.get(id).push(text);
  },
  async readFile(name) {
    const r = await api(`/api/file?path=${encodeURIComponent(name)}`);
    if (r.status !== 200) throw new Error(r.body.error ?? `${name} を読めませんでした`);
    return r.body.content;
  },
  async writeFile(name, content) {
    if (!(await askApproval(name, content))) throw new Error(`「${name}」に書くのをやめました（許可されませんでした）`);
    const r = await api('/api/file', { method: 'PUT', body: JSON.stringify({ path: name, content }) });
    if (r.status !== 200) throw new Error(r.body.error ?? `${name} に書けませんでした`);
  },
  async weather(place, day) {
    const r = await api('/api/blocks/weather', { method: 'POST', body: JSON.stringify({ place, day }) });
    if (r.body.error) throw new Error(r.body.error);
    return { text: r.body.text, rain: r.body.rain === true };
  },
  async ask(prompt) {
    const r = await api('/api/blocks/ask', { method: 'POST', body: JSON.stringify({ prompt }) });
    if (r.body.error) throw new Error(r.body.error);
    return r.body.text;
  },
};

function nameOf(id) {
  if (S.view === 'flow') { let hit; walkSteps(S.workflow.steps, (s) => { if (s.id === id) hit = s; }); return hit ? stepTitle(hit) : id; }
  const n = S.graph.nodes.find((x) => x.id === id);
  return n ? BLOCKS[n.kind].title : id;
}

let running = false;
async function runNow(why = '') {
  if (running) return;
  running = true;
  $('runIt').disabled = true;
  $('out').textContent = '';
  S.shown.clear();
  S.failed = undefined;
  $('runState').textContent = `${why ? `${why}、` : ''}動かしています…`;
  const t0 = performance.now();
  const got = S.view === 'flow' ? await runWorkflow(S.workflow, runtime) : await run(S.graph, runtime);
  const ms = Math.round(performance.now() - t0);
  if (got.ok) $('runState').textContent = `終わりました（${ms} ミリ秒）`;
  else {
    S.failed = { node: got.node, message: got.message };
    $('runState').textContent = '止まりました';
    $('out').append(el('div', { class: 'line err' }, `「${nameOf(got.node)}」で止まりました: ${got.message}`));
  }
  running = false;
  $('runIt').disabled = false;
  renderBody();
}

/* ---------- 保存・開く ---------- */
function askFor(title, hint, value, choices = []) {
  return new Promise((resolve) => {
    const d = $('ask');
    $('askTitle').textContent = title;
    $('askHint').textContent = hint;
    $('askInput').value = value;
    const list = $('askList');
    list.textContent = '';
    for (const c of choices) list.append(el('button', { type: 'button', class: 'ghost', onclick: () => { $('askInput').value = c; d.close('yes'); } }, c));
    d.returnValue = '';
    d.onclose = () => resolve(d.returnValue === 'yes' ? $('askInput').value.trim() : undefined);
    d.showModal();
    $('askInput').focus();
  });
}

async function save() {
  const name = await askFor('保存する', '作業場に保存します。名前の最後は .blocks.json になります。', S.fileName || 'my.blocks.json');
  if (!name) return;
  const path = name.endsWith('.blocks.json') ? name : `${name.replace(/\.json$/, '')}.blocks.json`;
  const r = await api('/api/file', { method: 'PUT', body: JSON.stringify({ path, content: snapshot() }) });
  if (r.status !== 200) { note(`保存できませんでした: ${r.body.error ?? r.status}`); return; }
  S.fileName = path;
  note(`保存しました: ${path}`);
}

async function open() {
  const r = await api('/api/files?path=.');
  const names = (Array.isArray(r.body.entries) ? r.body.entries : []).map((e) => (typeof e === 'string' ? e : e.name ?? e.path ?? '')).filter((n) => n.endsWith('.blocks.json'));
  const name = await askFor('開く', names.length ? '作業場の .blocks.json から選ぶか、名前を書いてください。' : '作業場に .blocks.json がまだありません。名前を書いて開けます。', S.fileName, names);
  if (!name) return;
  const got = await api(`/api/file?path=${encodeURIComponent(name)}`);
  if (got.status !== 200) { note(`開けませんでした: ${got.body.error ?? got.status}`); return; }
  const parsed = parseFile(got.body.content);
  S.graph = parsed.graph;
  S.workflow = parsed.workflow ?? emptyWorkflow();
  S.view = parsed.view;
  S.fileName = name;
  remember();
  renderAll();
  if (S.view === 'graph') { fitView(); applyView(); }
  note(parsed.problems.length ? `開きました（${parsed.problems.join('、')}）` : `開きました: ${name}`);
}

/* ---------- 見方と向き ---------- */
function setView(v) {
  if (v === S.view) return;
  if (v === 'flow') {
    const got = graphToWorkflow(S.graph, S.workflow.trigger);
    if (!got.workflow) { note(got.why); return; }
    S.workflow = got.workflow;
  } else {
    const got = workflowToGraph(S.workflow);
    if (!got.graph) { note(got.why); return; }
    S.graph = autoLayout(got.graph, S.dir);
  }
  S.view = v;
  S.shown.clear();
  S.failed = undefined;
  remember();
  renderAll();
  note(v === 'flow' ? '手順の形にしました。中身は同じです' : 'つなぐ形にしました。中身は同じです');
}

async function setDir(d, save = true) {
  if (!isDirection(d)) return;
  S.dir = d;
  if (save) await api('/api/blocks/direction', { method: 'PUT', body: JSON.stringify({ direction: d }) }).catch(() => undefined);
  renderAll();
}

function renderBody() {
  if (S.view === 'flow') renderFlow();
  else renderGraph();
}

function renderAll() {
  for (const b of document.querySelectorAll('[data-view]')) b.setAttribute('aria-pressed', String(b.dataset.view === S.view));
  for (const b of document.querySelectorAll('[data-dir]')) b.setAttribute('aria-pressed', String(b.dataset.dir === S.dir));
  $('stage').hidden = S.view === 'flow';
  $('flow').hidden = S.view !== 'flow';
  $('tidy').disabled = S.view === 'flow';
  renderBody();
  renderCode();
  updateUndo();
}

function updateUndo() {
  $('undo').disabled = !history.canUndo;
  $('redo').disabled = !history.canRedo;
}

function doUndo() { const t = history.undo(snapshot()); if (t) restore(t); }
function doRedo() { const t = history.redo(snapshot()); if (t) restore(t); }

/* ---------- AI に組んでもらう ---------- */
async function aiBuild() {
  const want = await askFor('AI に組んでもらう', 'やりたいことを書いてください（例: 1 から 10 まで数えて、偶数だけ表示）。返ってきた形をそのまま置きます。', '');
  if (!want) return;
  note('AI に頼んでいます…');
  const r = await api('/api/blocks/ask', { method: 'POST', body: JSON.stringify({ prompt: want, system: graphFormatGuide() }) });
  if (r.body.error) { note(`組めませんでした: ${r.body.error}`); return; }
  const json = /\{[\s\S]*\}/.exec(r.body.text ?? '')?.[0] ?? '';
  const got = parseGraph(json);
  if (!got.graph.nodes.length) { note(`組めませんでした（返ってきた形を読めません）: ${got.problems[0] ?? ''}`); return; }
  S.graph = autoLayout(got.graph, S.dir);
  S.view = 'graph';
  remember();
  renderAll();
  note(got.problems.length ? `組みました（${got.problems.join('、')}）。▶ 動かす で試せます` : '組みました。▶ 動かす で試せます');
}

/* ---------- つなぐ ---------- */
renderPalette();
wireStage();
for (const b of document.querySelectorAll('[data-view]')) b.addEventListener('click', () => setView(b.dataset.view));
for (const b of document.querySelectorAll('[data-dir]')) b.addEventListener('click', () => void setDir(b.dataset.dir));
$('runIt').onclick = () => void runNow();
$('saveOne').onclick = () => void save();
$('openOne').onclick = () => void open();
$('newOne').onclick = () => { S.pan = { x: 0, y: 0 }; S.zoom = 1; S.graph = emptyGraph(); S.workflow = emptyWorkflow(); S.fileName = ''; S.shown.clear(); S.failed = undefined; remember(); renderAll(); armTrigger(); note('空にしました（↶ で戻せます）'); };
$('undo').onclick = doUndo;
$('redo').onclick = doRedo;
$('tidy').onclick = () => { autoLayout(S.graph, S.dir); remember(); fitView(); renderGraph(); note(`${DIRECTIONS[S.dir].title}に並べ直しました（中身は同じです）`); };
$('aiBuild').onclick = () => void aiBuild();
$('copyCode').onclick = async () => {
  const text = wrapForNode(currentCode().code);
  try { await navigator.clipboard.writeText(text); note('JavaScript を写しました。node 名前.mjs で動きます'); } catch { note('写せませんでした。右の欄を選んで写してください'); }
};
$('exportCode').onclick = async () => {
  const base = (S.fileName || 'blocks.blocks.json').replace(/\.blocks\.json$/, '');
  const name = await askFor('JavaScript を書き出す', '作業場に .mjs で書き出します。', `${base}.mjs`);
  if (!name) return;
  const r = await api('/api/file', { method: 'PUT', body: JSON.stringify({ path: name, content: wrapForNode(currentCode().code) }) });
  note(r.status === 200 ? `書き出しました: ${name}` : `書き出せませんでした: ${r.body.error ?? r.status}`);
};
$('sample').onchange = () => {
  const v = $('sample').value;
  $('sample').value = '';
  if (!v) return;
  S.shown.clear();
  S.failed = undefined;
  if (v === 'umbrella') { S.workflow = sampleUmbrella(); S.view = 'flow'; } else { S.graph = autoLayout(v === 'fizz' ? sampleFizzBuzz() : sampleHello(), S.dir); S.view = 'graph'; }
  remember();
  renderAll();
  if (S.view === 'graph') { fitView(); applyView(); }
  note('見本を置きました。▶ 動かす で動きます');
};
document.addEventListener('keydown', (e) => {
  if (e.target.closest?.('input,textarea,select,dialog')) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key === 'Enter') { e.preventDefault(); void runNow(); }
  else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); void save(); }
  else if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); doUndo(); }
  else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); doRedo(); }
  else if (mod && e.key.toLowerCase() === 'd' && S.view === 'graph') {
    e.preventDefault();
    const made = duplicateNodes(S.graph, [...S.selected]);
    S.selected = new Set(made);
    remember(); renderGraph(); changed();
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && S.view === 'graph') deleteNodes([...S.selected]);
});

(async () => {
  const r = await api('/api/blocks/direction').catch(() => ({ body: {} }));
  if (isDirection(r.body.direction)) S.dir = r.body.direction;
  remember();
  renderAll();
})();
