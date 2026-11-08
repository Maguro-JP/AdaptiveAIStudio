/**
 * ブロックでつくる画面。中身（型・つなぐ・JavaScript を作る・保存の形）は blocks-core.js。
 * ここは置く・引く・つなぐ・動かすの手ざわりだけを持つ。設計は docs/BLOCKS.md。
 */
import {
  BLOCKS, TYPES, TRIGGERS, DIRECTIONS, canConnect, portOf, makeNode, emptyGraph, nextId, connect, removeNodes,
  duplicateNodes, compile, wrapForNode, run, makeHistory, searchBlocks, graphFormatGuide, emptyWorkflow, makeStep,
  walkSteps, nextStepId, availableOutputs, compileWorkflow, runWorkflow, graphToWorkflow, workflowToGraph, dailyDue,
  serializeFile, parseFile, isDirection, autoLayout, sampleFizzBuzz, sampleHello, sampleUmbrella, parseGraph,
  normalizeDirection, isBranch, WHEN_FIELDS, WHEN_OP, COMPARE_WORDS, VIEWS,
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
  /** 動かしたときに各手順が出した値（文章の形で行の横に出す）。id → { count, last, yes, no } */
  seen: new Map(),
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
function changed() { renderCode(); if (S.view === 'text') liveSoon(); }

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
    if (S.view !== 'graph') { addStepAtEnd(kind); return; }
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
  // 左上から右（折り返し）も、口は左から右と同じ（入るは左の辺、出るは右の辺）
  if ((S.dir === 'ltr' || S.dir === 'wrap') && rowEl) return { x: side === 'out' ? w : 0, y: rowEl.offsetTop + rowEl.offsetHeight / 2 };
  if (S.dir === 'ttb') return { x: (w * (index + 1)) / (count + 1), y: side === 'out' ? h : 0 };
  return { x: side === 'out' ? w : 0, y: (h * (index + 1)) / (count + 1) };
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
  return { n, box, rows };
}

/**
 * 口を置く。大きさを読むのは全部のブロックを入れたあとに一度にまとめる（読む・書くを交互にすると、
 * ブラウザが毎回並べ直して 200 個で目に見えて遅くなった。docs/knowledge/blocks-perf-2026-11-08.md）。
 */
function placePorts(built) {
  const measured = built.map(({ n, box, rows }) => {
    const def = BLOCKS[n.kind];
    const pts = [];
    for (const [side, list, rowsOf] of [['in', def.inputs, rows.in], ['out', def.outputs, rows.out]]) {
      list.forEach((p, i) => pts.push({ side, p, pt: portPoint(box, side, i, list.length, rowsOf[i]) }));
    }
    return { n, box, pts };
  });
  for (const { n, box, pts } of measured) {
    const offs = new Map();
    for (const { side, p, pt } of pts) {
      const dot = el('span', { class: `bk-port ${side}`, dataset: { port: p.name, type: p.type, node: n.id }, title: `${p.label}（${TYPES[p.type].label}）` });
      dot.style.left = `${pt.x}px`;
      dot.style.top = `${pt.y}px`;
      dot.addEventListener('pointerdown', (e) => startWire(e, n, side, p));
      box.append(dot);
      offs.set(`${side}:${p.name}`, pt);
    }
    portOffsets.set(n.id, offs);
  }
}
/** ブロックの中での口の位置（ブロックの左上から）。動かしても変わらないので、描くときに一度だけ測る。 */
const portOffsets = new Map();

let nodeById = new Map();
function portCenter(nodeId, side, port) {
  const n = nodeById.get(nodeId);
  const off = portOffsets.get(nodeId)?.get(`${side}:${port}`);
  if (!n || !off) return undefined;
  return { x: n.x + off.x, y: n.y + off.y };
}

/** 線の形。toTop は入る側のブロックの上の辺（折り返しで下の段へ回るときに使う）。 */
function wirePath(a, b, toTop) {
  if (S.dir === 'wrap' && toTop !== undefined && b.y - a.y > 60) {
    // 下の段へ: 右へ少し出て、段の間まで下り、左へ戻って、入る口へ横から入る
    const gap = toTop - 18;
    const r = 8;
    return `M${a.x},${a.y} H${a.x + 14} Q${a.x + 14 + r},${a.y} ${a.x + 14 + r},${a.y + r} V${gap - r} Q${a.x + 14 + r},${gap} ${a.x + 14},${gap} H${b.x - 22 + r} Q${b.x - 22},${gap} ${b.x - 22},${gap + r} V${b.y - r} Q${b.x - 22},${b.y} ${b.x - 22 + r},${b.y} H${b.x}`;
  }
  const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
  const dy = Math.max(40, Math.abs(b.y - a.y) / 2);
  if (S.dir === 'ttb') return `M${a.x},${a.y} C${a.x},${a.y + dy} ${b.x},${b.y - dy} ${b.x},${b.y}`;
  return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
}

/** 線の道。一本ずつ path を覚えておき、動かしたブロックの線だけを描き直す。 */
const wirePaths = new Map();
const linkKey = (l) => `${l.from.node}.${l.from.port}>${l.to.node}.${l.to.port}`;
function drawWire(l, p) {
  const a = portCenter(l.from.node, 'out', l.from.port);
  const b = portCenter(l.to.node, 'in', l.to.port);
  if (!a || !b) { p.removeAttribute('d'); return; }
  p.setAttribute('d', wirePath(a, b, nodeById.get(l.to.node)?.y));
}
function renderWires() {
  const svg = $('wires');
  svg.textContent = '';
  wirePaths.clear();
  nodeById = new Map(S.graph.nodes.map((n) => [n.id, n]));
  const frag = document.createDocumentFragment();
  for (const l of S.graph.links) {
    const from = nodeById.get(l.from.node);
    if (!from) continue;
    const type = portOf(from.kind, 'out', l.from.port)?.type ?? 'any';
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('stroke', `var(--port-${type})`);
    p.dataset.from = `${l.from.node}.${l.from.port}`;
    p.dataset.to = `${l.to.node}.${l.to.port}`;
    drawWire(l, p);
    if (!p.hasAttribute('d')) continue;
    wirePaths.set(linkKey(l), p);
    frag.append(p);
  }
  svg.append(frag);
}
/** 動かしたブロックに付く線だけを描き直す。 */
function updateWiresOf(ids) {
  for (const l of S.graph.links) {
    if (!ids.has(l.from.node) && !ids.has(l.to.node)) continue;
    const p = wirePaths.get(linkKey(l));
    if (p) drawWire(l, p);
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
  portOffsets.clear();
  const built = S.graph.nodes.map((n) => renderNode(n));
  const frag = document.createDocumentFragment();
  for (const b of built) frag.append(b.box);
  $('world').append(frag);
  placePorts(built);
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
  // 動かすのは画面を描く回（requestAnimationFrame）に一度だけ。線は動かしたブロックの分だけ描き直す
  const ids = new Set(moving.map((m) => m.id));
  const boxes = new Map(moving.map((m) => [m.id, document.querySelector(`.bk-node[data-id="${m.id}"]`)]));
  let last;
  let frame = 0;
  const apply = () => {
    frame = 0;
    if (!last) return;
    for (const s of start) {
      s.m.x = Math.round(s.x + (last.clientX - sx) / S.zoom);
      s.m.y = Math.round(s.y + (last.clientY - sy) / S.zoom);
      const box = boxes.get(s.m.id);
      if (box) { box.style.left = `${s.m.x}px`; box.style.top = `${s.m.y}px`; }
    }
    updateWiresOf(ids);
  };
  const move = (ev) => {
    moved = true;
    last = { clientX: ev.clientX, clientY: ev.clientY };
    if (!frame) frame = requestAnimationFrame(apply);
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    if (frame) cancelAnimationFrame(frame);
    apply();
    if (moved) remember();
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
      box.append(el('button', { type: 'button', class: 'ghost', onclick: () => { f.hidden = true; if (S.view !== 'graph') addStepAtEnd(hit.kind); else addNodeAt(hit.kind, cx, cy); } }, `${hit.title}`, el('span', { class: 'dim' }, `  ${hit.group}`)));
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
function stepTitle(s) {
  if (s.kind === 'cond') return '条件';
  if (s.kind === 'when') return 'もし（比べて分かれる）';
  return BLOCKS[s.kind]?.title ?? s.kind;
}

function menu(at, items) {
  document.querySelector('.bk-menu')?.remove();
  const r = at.getBoundingClientRect();
  const m = el('div', { class: 'bk-menu', role: 'menu' }, items.map(([label, fn]) => el('button', { type: 'button', class: 'ghost', role: 'menuitem', onclick: () => { m.remove(); fn(); } }, label)));
  m.style.left = `${r.left}px`;
  m.style.top = `${r.bottom + 4}px`;
  document.body.append(m);
}

function addMenu(at, list) {
  const items = [
    ['もし A が B で割り切れたら…（比べて分かれる）', () => insertStep(list, 'when')],
    ['条件（はい・いいえに分かれる）', () => insertStep(list, 'cond')],
  ];
  for (const [kind, d] of Object.entries(BLOCKS)) items.push([d.title, () => insertStep(list, kind)]);
  menu(at, items);
}

function insertStep(list, kind) {
  const s = makeStep(kind, nextStepId(S.workflow));
  list.push(s);
  if (kind === 'when') {
    // くり返しの中なら、A は「今の数」から始める（いちばん多い使い方。私の推測）。違えば × で外せる
    const each = availableOutputs(S.workflow, s.id).filter((o) => o.port === 'each').pop();
    if (each) s.values.a = { ref: each.node, port: each.port };
  }
  remember();
  renderBody();
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
    else if (s.kind === 'when') {
      body.append(fieldRow(s, WHEN_FIELDS[0]), fieldRow(s, WHEN_FIELDS[1]), fieldRow(s, WHEN_OP));
    } else {
      const def = BLOCKS[s.kind];
      for (const f of def.fields) body.append(fieldRow(s, { ...f, kind: f.kind }));
      for (const p of def.inputs) body.append(fieldRow(s, p));
    }
    if (S.shown.has(s.id)) body.append(el('div', { class: 'bk-shown' }, S.shown.get(s.id).join('\n')));
    if (S.failed?.node === s.id) body.append(el('div', { class: 'bk-fail' }, `ここで止まりました: ${S.failed.message}`));
    card.append(head, body);
    if (isBranch(s.kind)) {
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
  f.className = `bk-flow dir-${S.dir}`;
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

/* ---------- 文章の形（手順の形と同じ中身を、日本語の文で読む） ---------- */
/** 文の型。文字はそのまま、{ f } は書き込む欄（チップ）。words は比べ方を「で割り切れる」などの言い方で出す。 */
const SENTENCES = {
  number: ['数', { f: 'value' }, 'を用意する'],
  text: ['文字', { f: 'value' }, 'を用意する'],
  show: [{ f: 'value' }, 'を表示する'],
  calc: [{ f: 'a' }, { f: 'op' }, { f: 'b' }, 'を計算する'],
  compare: [{ f: 'a' }, 'が', { f: 'b' }, { f: 'op', words: true }, 'か調べる'],
  if: ['もし', { f: 'cond' }, 'なら', { f: 'yes' }, '、ちがえば', { f: 'no' }, 'を選ぶ'],
  repeat: [{ f: 'from' }, 'から', { f: 'to' }, 'まで数えて、その数ごとに:'],
  join: [{ f: 'a' }, 'と', { f: 'b' }, 'をつなぐ'],
  list: [{ f: 'a' }, '・', { f: 'b' }, '・', { f: 'c' }, 'を一覧にする'],
  writeFile: [{ f: 'content' }, 'を', { f: 'name' }, 'に書く'],
  readFile: [{ f: 'name' }, 'を読む'],
  weather: [{ f: 'place' }, 'の', { f: 'day' }, 'の天気を取る'],
  ask: ['AI に', { f: 'prompt' }, 'と頼む'],
  cond: ['もし', { f: 'cond' }, 'なら:'],
  when: ['もし', { f: 'a' }, 'が', { f: 'b' }, { f: 'op', words: true }, 'なら:'],
};

function slotDef(s, name) {
  if (s.kind === 'cond') return { name: 'cond', label: 'もし', type: 'bool', default: false };
  if (s.kind === 'when') return name === 'op' ? WHEN_OP : WHEN_FIELDS.find((p) => p.name === name);
  const def = BLOCKS[s.kind];
  return def?.fields.find((f) => f.name === name) ?? def?.inputs.find((p) => p.name === name);
}

/** 書き込む欄（チップ）。選ぶもの・書く値・前の出力、のどれか。押せば変えられる。 */
function slot(s, tok) {
  const p = slotDef(s, tok.f);
  if (!p) return el('span', {}, '?');
  const v = s.values[p.name];
  const done = (nv) => { s.values[p.name] = nv; remember(); renderText(); changed(); };
  if (p.kind === 'choice') {
    const sel = el('select', { class: 'bk-slot', dataset: { slot: p.name }, onchange: () => { s.values[p.name] = sel.value; remember(); changed(); } },
      p.choices.map((c) => el('option', { value: c }, tok.words ? (COMPARE_WORDS[c] ?? c) : c)));
    sel.value = v;
    return sel;
  }
  const pick = (at) => {
    const outs = availableOutputs(S.workflow, s.id).filter((o) => canConnect(o.type, p.type).ok);
    const items = outs.map((o) => [o.port === 'each' ? `その数（${o.label}）` : o.label, () => done({ ref: o.node, port: o.port })]);
    if (v && typeof v === 'object') items.push(['自分で書く', () => done(p.default ?? '')]);
    if (!items.length) { note('使える前の出力がありません（前に手順を置くと選べます）'); return; }
    menu(at, items);
  };
  if (v && typeof v === 'object' && v.ref) {
    const src = availableOutputs(S.workflow, s.id).find((o) => o.node === v.ref && o.port === v.port);
    const label = src ? (src.port === 'each' ? 'その数' : src.label) : `${v.ref} の ${v.port}（見つかりません）`;
    return el('button', { type: 'button', class: `bk-slot ref${src ? '' : ' bad'}`, dataset: { slot: p.name }, title: '前の手順の出力。押すと変えられます', onclick: (e) => pick(e.currentTarget) }, label);
  }
  const kindLike = p.type === 'any' ? 'text' : p.type;
  const box = editorFor(kindLike, v, (nv) => { s.values[p.name] = nv; remember(); changed(); });
  box.classList.add('bk-slot');
  box.dataset.slot = p.name;
  if (box.tagName === 'INPUT' && box.type !== 'checkbox') {
    // 中身の長さに合わせる（文の中で浮かないように）
    const fit = () => { box.style.width = `${Math.max(3, String(box.value).length + 1.5)}em`; };
    box.addEventListener('input', fit);
    fit();
  }
  const wrap = el('span', { class: 'bk-slot-wrap' }, box,
    el('button', { type: 'button', class: 'bk-pick', title: '前の手順の出力を使う', dataset: { pick: p.name }, onclick: (e) => pick(e.currentTarget) }, '▾'));
  return wrap;
}

function liveText(s) {
  const shown = S.shown.get(s.id);
  if (shown) return shown.length > 20 ? `${shown.slice(0, 20).join('、')}…（${shown.length} 回）` : shown.join('、');
  const seen = S.seen.get(s.id);
  if (!seen) return '';
  if (isBranch(s.kind)) return `はい ${seen.yes} 回・いいえ ${seen.no} 回`;
  const last = typeof seen.last === 'string' ? seen.last : JSON.stringify(seen.last);
  return seen.count > 1 ? `最後は ${last}（${seen.count} 回）` : `${last}`;
}

function textLines(list, host, depth) {
  list.forEach((s, i) => {
    const line = el('div', { class: `bk-line${S.failed?.node === s.id ? ' failed' : ''}`, dataset: { step: s.id, kind: s.kind } });
    line.style.setProperty('--depth', String(depth));
    const words = (SENTENCES[s.kind] ?? [stepTitle(s)]).map((tok) => (typeof tok === 'string' ? el('span', { class: 'bk-word' }, tok) : slot(s, tok)));
    const tools = el('span', { class: 'bk-line-tools' },
      el('button', { type: 'button', class: 'ghost icon', title: '前へ', onclick: () => { if (i > 0) { list.splice(i - 1, 0, list.splice(i, 1)[0]); remember(); renderText(); changed(); } } }, '↑'),
      el('button', { type: 'button', class: 'ghost icon', title: '後ろへ', onclick: () => { if (i < list.length - 1) { list.splice(i + 1, 0, list.splice(i, 1)[0]); remember(); renderText(); changed(); } } }, '↓'),
      el('button', { type: 'button', class: 'ghost icon', title: 'この文を消す（↶ で戻せます）', onclick: () => { list.splice(i, 1); remember(); renderText(); changed(); } }, '×'));
    line.append(el('span', { class: 'bk-sentence' }, words), tools, el('span', { class: 'bk-live', title: '動かした結果（変えるとすぐ動かし直します）' }, liveText(s)));
    if (S.failed?.node === s.id) line.append(el('span', { class: 'bk-fail' }, `ここで止まりました: ${S.failed.message}`));
    host.append(line);
    const addAt = (inner, d, branch) => {
      host.append(el('button', { type: 'button', class: 'ghost bk-add bk-line-add', style: `--depth:${d}`, dataset: { addIn: s.id, branch }, onclick: (e) => addMenu(e.currentTarget, inner) }, '＋ ここに足す'));
    };
    if (s.kind === 'repeat') { textLines(s.body, host, depth + 1); addAt(s.body, depth + 1, 'body'); }
    if (isBranch(s.kind)) {
      textLines(s.yes, host, depth + 1); addAt(s.yes, depth + 1, 'yes');
      const no = el('div', { class: 'bk-line else', dataset: { elseOf: s.id } }, el('span', { class: 'bk-sentence' }, el('span', { class: 'bk-word' }, 'そうでなければ:')));
      no.style.setProperty('--depth', String(depth));
      host.append(no);
      textLines(s.no, host, depth + 1); addAt(s.no, depth + 1, 'no');
    }
  });
}

function renderText() {
  const host = $('text');
  host.textContent = '';
  const t = S.workflow.trigger;
  host.append(el('p', { class: 'dim bk-text-head' }, `${TRIGGERS[t.kind]?.title ?? TRIGGERS.manual.title}とき、上から順に読んで動きます。灰色の欄を押すと書き換えられ、変えるとすぐ右に結果が出ます。`));
  textLines(S.workflow.steps, host, 0);
  host.append(el('button', { type: 'button', class: 'ghost bk-add bk-line-add', id: 'addLine', style: '--depth:0', onclick: (e) => addMenu(e.currentTarget, S.workflow.steps) }, '＋ 文を足す'));
}

/** 行の横の結果だけを書き換える（書いている欄の手を止めない）。 */
function updateLive() {
  for (const line of document.querySelectorAll('#text .bk-line[data-step]')) {
    let hit;
    walkSteps(S.workflow.steps, (x) => { if (x.id === line.dataset.step) hit = x; });
    const live = line.querySelector('.bk-live');
    if (hit && live) live.textContent = liveText(hit);
    line.classList.toggle('failed', S.failed?.node === line.dataset.step);
  }
}

/** 外に触らない（ファイル・天気・AI を使わない）なら、変えるたびに動かし直す。 */
const OUTSIDE = new Set(['writeFile', 'readFile', 'weather', 'ask']);
let liveTimer;
function liveSoon() {
  clearTimeout(liveTimer);
  let outside = false;
  walkSteps(S.workflow.steps, (x) => { if (OUTSIDE.has(x.kind)) outside = true; });
  if (outside || !S.workflow.steps.length) return;
  liveTimer = setTimeout(() => void runNow('', { quiet: true }), 200);
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
    if (S.view === 'graph') return;
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
  if (S.view !== 'graph') return compileWorkflow(S.workflow);
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
  seen(id, v) {
    const got = S.seen.get(id) ?? { count: 0, last: undefined, yes: 0, no: 0 };
    got.count += 1;
    got.last = v;
    if (v === true) got.yes += 1; else if (v === false) got.no += 1;
    S.seen.set(id, got);
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
  if (S.view !== 'graph') { let hit; walkSteps(S.workflow.steps, (s) => { if (s.id === id) hit = s; }); return hit ? stepTitle(hit) : id; }
  const n = S.graph.nodes.find((x) => x.id === id);
  return n ? BLOCKS[n.kind].title : id;
}

let running = false;
async function runNow(why = '', opts = {}) {
  if (running) { if (opts.quiet) liveSoon(); return; }
  running = true;
  $('runIt').disabled = true;
  $('out').textContent = '';
  S.shown.clear();
  S.seen.clear();
  S.failed = undefined;
  $('runState').textContent = `${why ? `${why}、` : ''}動かしています…`;
  const t0 = performance.now();
  const got = S.view !== 'graph' ? await runWorkflow(S.workflow, runtime) : await run(S.graph, runtime);
  const ms = Math.round(performance.now() - t0);
  if (got.ok) $('runState').textContent = `終わりました（${ms} ミリ秒）`;
  else {
    S.failed = { node: got.node, message: got.message };
    $('runState').textContent = '止まりました';
    $('out').append(el('div', { class: 'line err' }, `「${nameOf(got.node)}」で止まりました: ${got.message}`));
  }
  running = false;
  $('runIt').disabled = false;
  // 文章の形では、書いている欄を消さないよう、結果の所だけを書き換える
  if (S.view === 'text') updateLive();
  else renderBody();
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
const VIEW_NOTES = { graph: 'つなぐ形にしました。中身は同じです', flow: '手順の形にしました。中身は同じです', text: '文章の形にしました。中身は同じです。上から順に読めます' };
function setView(v) {
  if (v === S.view || !VIEWS.includes(v)) return;
  if (v !== 'graph' && S.view !== 'graph') {
    // 手順の形と文章の形は、同じ中身の別の見せ方。そのまま切り替える
  } else if (v !== 'graph') {
    const got = graphToWorkflow(S.graph, S.workflow.trigger);
    if (!got.workflow) { note(got.why); return; }
    S.workflow = got.workflow;
  } else {
    const got = workflowToGraph(S.workflow);
    if (!got.graph) { note(got.why); return; }
    S.graph = autoLayout(got.graph, S.dir, { width: $('stage').clientWidth || 1600 });
  }
  S.view = v;
  S.shown.clear();
  S.seen.clear();
  S.failed = undefined;
  remember();
  renderAll();
  note(VIEW_NOTES[v]);
  if (v === 'text') liveSoon();
}

async function setDir(d, save = true) {
  d = normalizeDirection(d);
  if (!d) return;
  S.dir = d;
  if (save) await api('/api/blocks/direction', { method: 'PUT', body: JSON.stringify({ direction: d }) }).catch(() => undefined);
  renderAll();
}

function renderBody() {
  if (S.view === 'flow') renderFlow();
  else if (S.view === 'text') renderText();
  else renderGraph();
}

function renderAll() {
  for (const b of document.querySelectorAll('[data-view]')) b.setAttribute('aria-pressed', String(b.dataset.view === S.view));
  for (const b of document.querySelectorAll('[data-dir]')) b.setAttribute('aria-pressed', String(b.dataset.dir === S.dir));
  $('stage').hidden = S.view !== 'graph';
  $('flow').hidden = S.view !== 'flow';
  $('text').hidden = S.view !== 'text';
  // 見えていない形の中身は空にする（同じ id が二つ出来ないように）
  if (S.view !== 'flow') $('flow').textContent = '';
  if (S.view !== 'text') $('text').textContent = '';
  $('tidy').disabled = S.view !== 'graph';
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
  S.graph = autoLayout(got.graph, S.dir, { width: $('stage').clientWidth });
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
$('tidy').onclick = () => { autoLayout(S.graph, S.dir, { width: $('stage').clientWidth }); remember(); fitView(); renderGraph(); note(`${DIRECTIONS[S.dir].title}に並べ直しました（中身は同じです）`); };
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
  S.seen.clear();
  S.failed = undefined;
  if (v === 'umbrella') { S.workflow = sampleUmbrella(); S.view = 'flow'; } else { S.graph = autoLayout(v === 'fizz' ? sampleFizzBuzz() : sampleHello(), S.dir, { width: $('stage').clientWidth || 1600 }); S.view = 'graph'; }
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
  S.dir = normalizeDirection(r.body.direction) ?? S.dir;
  remember();
  renderAll();
})();
