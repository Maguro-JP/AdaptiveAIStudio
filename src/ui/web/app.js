/**
 * 配置(JSON)から画面を組み立てる。
 *
 * 画面の形はここでは決めない。決めているのは配置の方。
 * ここがやるのは、配置の通りに並べることと、
 * 仕切りを掴んで動かしたら配置に書き戻すことだけ。
 */
import { getJson } from './get-json.js';
import { PANELS, TITLES } from './panels.js';
import { pathActions } from './paths.js';
import { closePanel, openPanel, movePanel, panelsInUse } from './layout-ops.js';
import { doingText } from './doing.js';
import { isPlainEnter } from './keys.js';
import { willRestore, wontRestore, undoWhen } from './undo-scope.js';
import { sizeText } from './size.js';
import { openPicker } from './color.js';

const root = document.getElementById('editor');
const $ = (id) => document.getElementById(id);

let layout = null;
let theme = null;
let tokenNames = [];
const stateHandlers = [];
const eventHandlers = new Map();
/**
 * 描き直しで消えない受け手（設定の点検のように、パネルの外に一度だけ作る部品のもの）。`eventHandlers` は描き直すたびに
 * 空にするので、そこに置いた点検の受け手は消え、パネルを出し入れした後の点検は出力が出ず、押しボタンも戻らなかった
 */
const lastingHandlers = new Map();
function onLasting(type, fn) {
  if (!lastingHandlers.has(type)) lastingHandlers.set(type, []);
  lastingHandlers.get(type).push(fn);
}

/**
 * 並びを組み直した回数。組み直すと、それまでのパネルは捨てられる（新しいものが作られる）。
 * タブにまとめた中の隠れた中身も DOM から外れるので、「外れている」では捨てられたのか隠れているだけかが分からない。
 */
let renderGen = 0;

const ctx = {
  /** いまの並びの世代。パネルは作られたときの値と比べて、自分が捨てられたかを知る。 */
  gen: () => renderGen,
  onDiscard: (fn) => { discardHandlers.push(fn); },
  /** 会話の入力欄へ寄せる。差し替えられる。 */
  focusInput: () => undefined,
  /** 入力欄の先頭に文字を置く（/plan など）。チャットのパネルが繋ぐ。 */
  prefill: () => undefined,
  /** 残してあるやりとりを並べ直す。会話の板が差し替える。 */
  showHistory: () => undefined,
  /** ファイルをエディタで開く。エディタのパネルが繋ぐ。 */
  openFile: () => undefined,
  /**
   * ファイルを、エディタを出してから開く。
   *
   * `openFile` はエディタのパネルが出ているときしか効かない（出ていなければ
   * 誰も繋いでいないので、押しても何も起きない）。出す口はここに在るので、
   * **出してから開く道をパネルの側へ渡す。**
   */
  revealFile: () => undefined,
  applyPatch: () => undefined,
  insertText: () => false,
  saveNote: async () => false,
  on(type, fn) {
    if (!eventHandlers.has(type)) eventHandlers.set(type, []);
    eventHandlers.get(type).push(fn);
  },
  onState(fn) { stateHandlers.push(fn); if (lastState) fn(lastState); },
};

let lastState = null;

/*
 * **画面が黙って死ぬのを、ここで受け止める。**
 *
 * 同じ壊れ方を何度も出した。読み込みや送信の途中で例外が出ると、
 * 落ちるのは呼び出しの外（`void f()`）なので、画面には何も出ない。
 * 出るのは開発者用の記録だけで、使っている側からは無反応にしか見えない。
 * 一つずつ受け手を足しても、次に書いたところでまた同じ形になる。
 *
 * 拾い手のいない例外を、最後にここで拾って**必ず目に見える形で出す**。
 * これは受け手を書かなくてよいという話ではない（`web-catch.test.ts` が
 * 受け手の無い呼び出しの数を数えていて、増やせない）。最後の網。
 */
/** 知らせの帯（一本目と二本目）。探す・消す側は、必ず両方を見る（一本目だけ見ると、二本目の案内が消えずに残る）。 */
function crashNotes() {
  return ['crashNote', 'crashNoteMore'].map((id) => document.getElementById(id)).filter(Boolean);
}

/** その文で始まる知らせの帯を下げる（二本とも見る）。 */
function dropCrashNote(prefix) {
  for (const box of crashNotes()) if (box.textContent.startsWith(prefix)) removeCrashNote(box);
}

/** 帯を下げる。一本目を下げたら、二本目を一本目に繰り上げる（二本目だけが残り、次の知らせと並んで二本になるのを避ける）。 */
function removeCrashNote(box) {
  box.remove();
  if (box.id !== 'crashNote') return;
  const more = document.getElementById('crashNoteMore');
  if (more) more.id = 'crashNote';
}

/*
 * **止まったことの知らせ（bad）を、案内（warn）で上書きしない。**帯を一つ使い回していたので、起動直後に出た
 * 「色を読めませんでした」等を、すぐ後の「まだ話せません」が消していた（sweep で見つけた）。bad が出ている間は、
 * 案内をもう一本の帯に出す。
 */
/**
 * 押して消した注意の文。同じ文は出し直さない（配置を保存するたびに状態の見直しが走り、消した「先に一つ」「設定を読めませんでした」の帯が
 * 打つたびに戻ってきた）。止まった・落ちた（bad）は消しても次に起きれば出す
 */
const dismissedNotes = new Set();

/** 押して消す。止まった・落ちた以外は、同じ文を覚えておく */
function dismissNote(box) {
  if (box.dataset.tone !== 'bad' && box.dataset.key) dismissedNotes.add(box.dataset.key);
  removeCrashNote(box);
}

// **被せない。**浮かせると、その下の押しボタン（パネルの ×、添えたものを外す ×）が
// 押せなくなる（二度そうなった）。上の帯として流れの中に置き、中身を押し下げる。
function showCrash(what, detail, tone = 'bad', action) {
  const key = `${what}:${detail}`;
  if (tone !== 'bad' && dismissedNotes.has(key)) return;
  const id = tone !== 'bad' && document.querySelector('#crashNote.bad') ? 'crashNoteMore' : 'crashNote';
  let box = document.getElementById(id);
  if (!box) {
    box = document.createElement('div');
    box.id = id;
    box.className = 'crash-note';
    box.onclick = (e) => { if (e.target.tagName !== 'BUTTON') dismissNote(box); };
    // 被せない（上の注釈）
    const shell = document.querySelector('.shell');
    if (shell) shell.before(box); else document.body.append(box);
  }
  box.className = `crash-note ${tone}`;
  box.dataset.key = key;
  box.dataset.tone = tone;
  box.textContent = `${what}: ${detail}（押すと消えます）`;
  // 次の一手を、その場で押せるようにする（「設定で決めて」だけにしない）。
  if (action) {
    const b = document.createElement('button');
    b.className = 'crash-action';
    b.textContent = action.label;
    b.onclick = (e) => { e.stopPropagation(); void action.run(b); };
    box.append(' ', b);
  }
}

/*
 * 画面から本体へ訊く。**繋がらなかったときの受け手を、必ず通す。**
 *
 * `fetch(...)` をそのまま待つと、繋がらないときの例外が呼び出しの外へ
 * 落ちる。落ちた先には受け手が居ないので、**画面には何も出ない。**押しても
 * 何も起きない・空欄のまま、に見える。出方は違っても、元はこれ一つ。
 *
 * 返るのは `undefined` か、読めた中身。呼ぶ側は `undefined` を見て帰る。
 * 何が起きたかは、ここで画面に出してある。
 */
async function ask(path, opts, what) {
  let r;
  try {
    r = await fetch(path, { ...(opts ?? {}), signal: opts?.signal ?? AbortSignal.timeout(30000) });
  } catch (e) {
    showCrash(what ?? '繋がりませんでした', `${path}（${e?.message ?? e}）`);
    return undefined;
  }
  const body = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, body };
}

async function askJson(path, opts, what) {
  let r;
  try {
    r = await fetch(path, { ...(opts ?? {}), signal: opts?.signal ?? AbortSignal.timeout(30000) });
  } catch (e) {
    showCrash(what ?? '繋がりませんでした', `${path}（${e?.message ?? e}）`);
    return undefined;
  }
  try {
    return await r.json();
  } catch (e) {
    showCrash(what ?? '読めませんでした', `${path}（${r.status}・${e?.message ?? e}）`);
    return undefined;
  }
}

window.addEventListener('unhandledrejection', (e) => {
  showCrash('途中で止まりました', e.reason?.message ?? String(e.reason));
});
window.addEventListener('error', (e) => {
  showCrash('画面の中で落ちました', e.message ?? String(e.error));
});

/* ---------- 組み立て ---------- */

function buildPanel(spec) {
  const box = document.createElement('section');
  box.className = 'panel';
  const head = document.createElement('header');
  head.append(Object.assign(document.createElement('span'), {
    className: 'panel-name',
    textContent: spec.title ?? TITLES[spec.kind] ?? spec.kind,
  }));
  // **閉じる道を、その板の上に置く。**設定の奥にしか無いと、
  // 邪魔なものを退けるのに設定を開くことになる。
  const close = document.createElement('button');
  close.className = 'panel-x';
  close.textContent = '×';
  close.title = '閉じる';
  close.onclick = (e) => { e.stopPropagation(); apply(closePanel(layout, spec.id)); };
  head.append(close);
  draggableHead(head, spec.id);
  const body = document.createElement('div');
  body.className = 'body';
  box.append(head, body);
  dropTarget(box, spec.id);

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
    // 束ねてある一枚も、掴んで出せる／その場で閉じられる。
    draggableHead(b, id);
    const x = document.createElement('span');
    x.className = 'panel-x';
    x.textContent = '×';
    x.title = '閉じる';
    x.onclick = (e) => { e.stopPropagation(); apply(closePanel(layout, id)); };
    b.append(x);
    head.append(b);
  });

  show(Math.min(node.active ?? 0, bodies.length - 1));
  dropTarget(box, node.panels[Math.min(node.active ?? 0, node.panels.length - 1)] ?? node.panels[0]);
  return box;
}

/* ---------- 掴んで動かす ---------- */

/** 見出しを掴めるようにする。 */
function draggableHead(el, id) {
  el.draggable = true;
  el.addEventListener('dragstart', (e) => {
    e.dataTransfer?.setData('text/aas-panel', id);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  });
}

/**
 * 落とす先。**どこへ入るのかを、落とす前に見せる。**
 * 見せずに落とさせると、思っていない場所へ入って、戻し方が分からなくなる。
 */
function dropTarget(box, id) {
  if (!id) return;
  const hint = document.createElement('div');
  hint.className = 'drop-hint';
  hint.hidden = true;
  box.append(hint);

  const whereFrom = (e) => {
    const r = box.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    // 真ん中は「重ねる」。端に寄せたぶんだけ、その向きへ割る。
    const edge = 0.25;
    if (x < edge && x <= y && x <= 1 - y) return 'left';
    if (1 - x < edge && 1 - x <= y && 1 - x <= 1 - y) return 'right';
    if (y < edge) return 'top';
    if (1 - y < edge) return 'bottom';
    return 'tab';
  };

  box.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes('text/aas-panel')) return;
    e.preventDefault();
    hint.hidden = false;
    hint.dataset.where = whereFrom(e);
  });
  box.addEventListener('dragleave', (e) => {
    if (e.target === box) hint.hidden = true;
  });
  box.addEventListener('drop', (e) => {
    const moving = e.dataTransfer?.getData('text/aas-panel');
    hint.hidden = true;
    if (!moving) return;
    e.preventDefault();
    e.stopPropagation();
    apply(movePanel(layout, moving, id, whereFrom(e)));
  });
}

/** 組み替えた配置を、そのまま映して覚える。 */
async function apply(next) {
  if (!next || next === layout) return;
  layout = next;
  render();
  // 向こう側で直されることがある。直された形で描き直す。
  // 描き直さないと、画面と覚えている形がずれる。
  const before = JSON.stringify(layout);
  await save(next);
  if (JSON.stringify(layout) !== before) render();
}

/**
 * 表示するものを選ぶ。
 *
 * **ここが無いと、板を出す道が JSON しかない。**
 * 出ているものに印を付け、押すたびに出し入れする。
 */
function openViewMenu() {
  renderViewList();
  const dlg = $('viewMenu');
  if (!dlg.open) dlg.showModal();
}

/**
 * 一覧を描き直すだけ。**開き直さない。**
 * 出し入れの返事を待っている間に閉じられると、閉じた直後に開き直っていた
 * （画面で見て気づいた）。閉じたものが勝手に戻るのは、故障に見える。
 */
function renderViewList() {
  const box = $('viewList');
  box.replaceChildren();
  const shown = new Set(panelsInUse(layout.root));
  const idsOf = (kind) => layout.panels.filter((p) => p.kind === kind && shown.has(p.id)).map((p) => p.id);

  for (const [kind, name] of Object.entries(TITLES)) {
    const ids = idsOf(kind);
    const row = document.createElement('label');
    row.className = 'view-row';
    const tick = document.createElement('input');
    tick.type = 'checkbox';
    tick.checked = ids.length > 0;
    tick.onchange = async () => {
      // 同じ種類が複数出ていても、押した一度で全部は消さない。最後の一つを閉じる。
      await apply(tick.checked ? openPanel(layout, kind) : closePanel(layout, ids[ids.length - 1]));
      renderViewList();
    };
    row.append(tick, Object.assign(document.createElement('span'), { textContent: name }));
    if (ids.length > 1) {
      row.append(Object.assign(document.createElement('span'), { className: 'dim', textContent: ` ×${ids.length}` }));
    }
    box.append(row);
  }
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

/** 配置の中で target に至る子の番号の並び。見つからなければ undefined。 */
function pathTo(from, target, trail = []) {
  if (from === target) return trail;
  for (const [i, child] of (Array.isArray(from?.children) ? from.children : []).entries()) {
    const got = pathTo(child, target, [...trail, i]);
    if (got) return got;
  }
  return undefined;
}

/** 番号の並びで辿った先。辿れなければ undefined。 */
function atPath(from, path) {
  let at = from;
  for (const i of path) {
    at = Array.isArray(at?.children) ? at.children[i] : undefined;
    if (!at) return undefined;
  }
  return at;
}

/** 仕切り。掴んで動かすと、比率が配置に書き戻る。 */
function grip(built, index, box) {
  const g = document.createElement('div');
  g.className = 'grip';
  // 作った時の配置での道筋。保存すると配置は向こうが返したものに替わる（描き直さない）ので、掴むたびに今の配置から同じ仕切りを引き直す
  // （作った時の node を握ったままだと、二度目からは捨てた配置の比率を動かし、保存しても届かなかった）
  const path = pathTo(layout.root, built);
  g.onpointerdown = (down) => {
    const node = (path && atPath(layout.root, path)) ?? built;
    if (!Array.isArray(node.sizes) || node.sizes.length <= index + 1) return;
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

/** 作り直す手前でパネルに知らせる先。パネルが `ctx.onDiscard` で足す。作り直すたびに空にする。 */
const discardHandlers = [];

function render() {
  /*
   * 捨てる前のパネルに知らせる（世代を進める前。まだ生きているうちに片づけさせる）。エディタは、遅れて走る下書きの預けを
   * その場で一回だけ走らせてから止める。止めずにいると、捨てたパネルが後から預かりを書いて別のパネルに混ざり、
   * 補完も訊きに行っていた。取り消すだけにすると、最後の打鍵（400ms の預けに間に合っていない分）が消える
   */
  for (const fn of discardHandlers.splice(0)) {
    try { fn(); } catch { /* 一つのパネルの片づけの失敗で、作り直しを止めない */ }
  }
  renderGen += 1;
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
  const r = await askJson('/api/theme', undefined, '色を読めませんでした');
  if (!saved(r, 'theme', '色を読めませんでした')) return; // 失敗の返事（{ error }）で、一覧を回そうとして止まらない
  tokenNames = r.tokens;
  const sel = $('themes');
  sel.replaceChildren();
  for (const t of r.themes) {
    const o = document.createElement('option');
    o.value = t.id; o.textContent = t.name;
    sel.append(o);
  }
  applyTheme(r.theme, r.vars);
  showRepairs(r.repairs, '見た目');
}

$('themes').onchange = async (e) => {
  const r = await askJson('/api/theme/preset', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: e.target.value }),
  }, '色を変えられませんでした');
  if (!saved(r, 'theme', '色を変えられませんでした')) return;
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
  $('themeEditor').addEventListener('close', onClose);
  async function onClose() {
    $('themeEditor').removeEventListener('close', onClose);
    if ($('themeEditor').returnValue !== 'save') {
      // 戻す。触っただけで決まってしまわないように。
      const r = await askJson('/api/theme', undefined, '色を戻せませんでした');
      if (saved(r, 'theme', '色を戻せませんでした')) applyTheme(r.theme, r.vars);
      return;
    }
    const r = await askJson('/api/theme', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      // 元の見た目は、自分の色を直すときも最初の見た目（`custom` を元にすると「知らない見た目」になる）
      body: JSON.stringify({ ...draft, base: before.base ?? before.id, id: 'custom', name: '自分の色' }),
    }, '色を保存できませんでした');
    if (!saved(r, 'theme', '色を保存できませんでした')) return;
    applyTheme(r.theme, r.vars);
    if (r.repairs?.length) {
      // 受け取れなかった値は黙って捨てない。なぜ効かないのか分からなくなる。
      $('themeRepairs').textContent = r.repairs.map((x) => `・${x.detail}`).join('\n');
      // 開き直すダイアログにも、閉じたときの受け手を付け直す（付けずに開いていたので、直して「保存」しても「戻す」でも何も起きなかった）
      $('themeEditor').returnValue = '';
      $('themeEditor').showModal();
      $('themeEditor').addEventListener('close', onClose);
    }
  }
};

/* ---------- 出し入れ ---------- */

async function load() {
  const r = await askJson('/api/layout', undefined, '配置を読めませんでした');
  if (!saved(r, 'layout', '配置を読めませんでした')) return;
  layout = r.layout;
  showRepairs(r.repairs, '画面の並び');
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
  const r = await askJson('/api/layout', {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(next),
  }, '配置を保存できませんでした');
  if (!saved(r, 'layout', '配置を保存できませんでした')) return undefined;
  layout = r.layout;
  showRepairs(r.repairs, '画面の並び');
  return r;
}

/**
 * 返事に欲しいもの（`layout`・`theme`）が入っているか。入っていなければ、向こうが返した文を出して false。
 * 保存に失敗すると `{ error }` が返る。そのまま `layout = r.layout` にすると、次の描画で止まり、
 * 「途中で止まりました」としか出ず、なぜ保存できなかったかが見えなかった。
 */
function saved(r, key, what) {
  if (!r) return false;
  if (r[key]) return true;
  showCrash(what, r.error ?? '返事に中身がありませんでした');
  return false;
}

/**
 * 直したことは黙らない。黙って直すと、次も同じ壊れ方をする。
 * 中身を、押すまで消えない帯に出す（状態の欄はすぐ「つながっています」に戻るので、件数だけでは見落とす）。
 */
function showRepairs(repairs, what) {
  if (!repairs || repairs.length === 0) return;
  console.warn(`${what}を直しました:`, repairs.map((x) => x.detail));
  $('status').textContent = `${what}を直しました（${repairs.length}件）`;
  // 止まった知らせの帯（`#crashNote`）とは分ける。一つを使い回すと、起動直後の「まだ話せません」等に上書きされて消えた。
  let box = document.getElementById('repairNote');
  if (!box) {
    box = document.createElement('div');
    box.id = 'repairNote';
    box.className = 'crash-note warn';
    box.onclick = () => box.remove();
    const shell = document.querySelector('.shell');
    if (shell) shell.before(box); else document.body.append(box);
  }
  const line = `${what}を直しました: ${repairs.map((x) => x.detail).join(' ／ ')}`;
  box.textContent = box.textContent ? `${box.textContent.replace(/（押すと消えます）$/, '')} ／ ${line}（押すと消えます）` : `${line}（押すと消えます）`;
}

/** 状態を頼んだ回数。遅れて返った古い返事で、後から頼んだ分の描き直しを上書きしない（忘れた直後に戻すと踏む）。 */
let stateAsked = 0;
async function refreshState() {
  const mine = ++stateAsked;
  try {
    const got = await getJson('/api/state');
    if (mine === stateAsked) {
      dropCrashNote('状態を読めませんでした');
      lastState = got;
      for (const fn of stateHandlers) fn(lastState);
    }
  } catch (e) {
    // 繋がらない（本体が止まっている）ときは黙る（繋がりの欄が言う）。本体が断ったときは言う。黙ると、古い状態が出たままで、
    // 何かあったことが見えない。次に読めたら下げる
    if (!(e instanceof TypeError) && mine === stateAsked) showCrash('状態を読めませんでした', e?.message ?? String(e), 'warn');
  }
  try {
    // **いま動かしているものを出す。**手元に入っているモデルの一覧の
    // 先頭を出していたので、使ってもいない名前が出ていた（実際に出ていた）。
    const info = await getJson('/api/info');
    $('sbModel').textContent = `${info.runtime} · ${info.model}`;
    // 起動時の読み込みの最中に画面を開いたとき。読み始めの合図は、繋ぐ前に流れている。
    if (info.loading && !busyNow) run.set('busy', `モデルを読み込んでいます: ${info.loading.ref}`);
    // **なぜそれなのかも出す。**名前だけだと「いつのまにか変わっている」に見える。
    $('sbModel').title = info.why
      ? `動かし方: ${info.runtime} / モデル: ${info.model}\nなぜ: ${info.why}`
      : `動かし方: ${info.runtime} / モデル: ${info.model}`;
  } catch { /* 同上 */ }
}

/* ---------- いま動いているか ---------- */

/*
 * **止まっているのか動いているのかを、一目で分かるようにする。**
 * 隅の小さな字では気づけない。横の板のいちばん上に置き、
 * 経過した時間も出す（進んでいるのか固まっているのかは、時間で分かる）。
 */
const run = {
  since: 0,
  timer: 0,
  set(state, text) {
    const box = $('run');
    box.dataset.state = state;
    $('runText').textContent = text;
    // 中断できるのは、人の依頼を動かしているときだけ。
    $('runStop').hidden = state !== 'busy';
    // 下の帯には出さない。**上と同じことを二度言わない。**
    if (state === 'busy' || state === 'musing') {
      if (!this.since) this.since = Date.now();
      if (!this.timer) this.timer = setInterval(() => this.tick(), 1000);
      this.tick();
    } else {
      clearInterval(this.timer);
      this.timer = 0;
      this.since = 0;
      $('runTime').textContent = '';
    }
  },
  tick() {
    const sec = Math.floor((Date.now() - this.since) / 1000);
    $('runTime').textContent = sec < 60 ? `${sec}秒` : `${Math.floor(sec / 60)}分${sec % 60}秒`;
  },
};

// 繋がらないときに黙ると（受け手の無い失敗は「途中で止まりました」とだけ出る）、止めたつもりで止まっていない
$('runStop').onclick = () => void stopRun();

/** 動いている依頼を止める。断られた（500 等）ときも、繋がらないときも言う。止めたつもりで止まっていない、を作らない。 */
async function stopRun() {
  const r = await ask('/api/abort', { method: 'POST' }, '止められませんでした');
  if (r && !r.ok) showCrash('止められませんでした', r.body.error ?? String(r.status));
}


/**
 * 送ってから最初の一文字が来るまで。モデルが入力を読んでいる（CPU では分単位）。
 * 横の帯は狭い。**入り切る長さで言う。**「返事を待っています（…）」は途中で切れた。
 */
const WAITING_REPLY = '入力を読んでいます';
/** この依頼で、最初の一文字がもう来たか。 */
let wroteYet = false;

/** 待っている承認を出す。承認は会話によらないので、欄を空にした後や開いた時点で、見ている所によらず出し直す。 */
async function showWaitingApprovals() {
  try {
    const waiting = await getJson('/api/approvals');
    if (waiting.approvals?.length) ctx.showApprovals?.(waiting.approvals);
  } catch { /* 取れなければ、これから来る分だけ */ }
}

/** 出来事の流れが一度でも切れたか。繋ぎ直したときだけ取り直す（最初に繋がったときは、立ち上げで読んでいる）。 */
let droppedOnce = false;

function listen() {
  const src = new EventSource('/api/events');
  const status = $('status');
  src.onopen = () => {
    status.textContent = 'つながっています';
    status.className = 'status live';
    // 切れる前に動いていたなら、取り直すまでは「作業中」のまま見せる（止めるボタンも残す）
    if ($('run').dataset.state === 'down') run.set(busyNow ? 'busy' : 'idle', busyNow ? WAITING_REPLY : '待機中');
    if (droppedOnce) void catchUp();
  };
  /*
   * 切れてから繋ぎ直したら、切れている間に届かなかった分を取り直す。承認の問い合わせを取り逃すと押す口が無く、
   * 本体は 10 分待ってから断る。終わった知らせを取り逃すと、本体が立ち直った後も「作業中」のまま残る。
   * 一覧と状態もここで読む（切れている間に終わった会話・増えた会話が、古いまま残らない）
   */
  const catchUp = async () => {
    void refreshState();
    void loadConversations();
    try {
      const waiting = await getJson('/api/approvals');
      if (waiting.approvals?.length) ctx.showApprovals?.(waiting.approvals);
      const id = conversations.current;
      const body = id ? await getJson(`/api/conversations/messages?id=${encodeURIComponent(id)}`) : {};
      /*
       * 見ている会話が動いていれば「作業中」に戻す（繋ぎ直した時点では「待機中」と出している）。
       * 動いていないと言えるのは、見ている会話も計画も動いていないときだけ（計画は会話の名前を付けずに動く）。
       * 本体が別の会話・考えごとで動いていても、見ている会話が止まっていれば止まったと言う
       */
      const live = Boolean(body.inFlight);
      const quiet = !live && !waiting.planning;
      if (live || (busyNow && quiet)) {
        src.onmessage({ data: JSON.stringify({ type: 'busy', busy: live, ...(id ? { conversationId: id } : {}) }) });
      }
    } catch { /* 取れなければ、これから来る分だけ */ }
  };
  src.onerror = () => {
    droppedOnce = true;
    status.textContent = '本体が止まっています';
    status.className = 'status down';
    run.set('down', '本体が止まっています');
  };
  src.onmessage = (m) => {
    const e = JSON.parse(m.data);
    /*
     * **見ている会話の動き出し・止まりだけで、上の表示を切り替える。**
     * 別の会話を横で並べて走らせるので、その会話が終わった知らせで「待機中」に戻すと、
     * 見ている会話はまだ動いているのに止まったように見える。一覧の表示だけ取り直す。
     */
    const busyForOther = e.type === 'busy' && e.conversationId && conversations
      && (conversations.current ? e.conversationId !== conversations.current : !sendingFromTop);
    if (e.type === 'busy' && busyForOther) void loadConversations();
    if (e.type === 'busy' && !busyForOther) {
      busyNow = e.busy;
      wroteYet = false;
      // **何を待っているかを出す。**「作業中」だけだと、固まっているのか
      // 入力を読んでいるのか分からない。CPU では入力を読むだけで分単位かかる。
      run.set(e.busy ? 'busy' : 'idle', e.busy ? WAITING_REPLY : '待機中');
      // 動いている間は切り替えさせない。切り替えると、返事が別の会話に混ざる。
      drawConversations();
    }
    /*
     * **読み込みの進み具合を、いつも見える所に出す。**
     *
     * 進み具合（10% ごと）は前から出していたが、出す先が「流れ」だけ
     * だった。**そこを開いていない人には、何も出ていないのと同じ。**
     * 数GBを読む間ずっと「待機中」と出ていたので、送ったのに無視された
     * ようにしか見えない（実機でそうなった）。
     *
     * 上の帯は畳んでも消えない。読み込みの間は、そこに出す。
     */
    if (e.type === 'log' && typeof e.text === 'string') {
      const loading = /^(読み込み中 \d+%|モデルを読み込んでいます|まだ読み込んでいます)/.exec(e.text);
      if (loading) run.set('busy', e.text.split('（')[0]);
      // 読み終えたあと、答えの最中なら「入力を読んでいる」に戻す。
      // 戻さないと「読み込み中 90%」のまま止まって見える。
      if (/^読み込みました/.test(e.text)) run.set(busyNow ? 'busy' : 'idle', busyNow ? WAITING_REPLY : '待機中');
      // 読み込めなかったときも戻す。戻さないと「読み込んでいます」のまま止まる
      // （読み込み中に子が消えたとき、実際にそうなった）。
      if (/^読み込めませんでした/.test(e.text) && !busyNow) run.set('idle', '待機中');
      /*
       * **モデルのプロセスが落ちたことを、見える所に出す。**
       *
       * 流れ（log）のパネルは、既定の配置には無い。そこにしか出さないと、
       * 会話には「ストリームが中断されました」だけが残って、何が起きたか
       * 分からない。上の帯は次の状態ですぐ上書きされる。知らせに出して、
       * 読み直せたら下げる。
       */
      if (/^モデルのプロセスが落ちました/.test(e.text)) showCrash('モデルが落ちました', e.text, 'warn');
      if (/^読み込みました/.test(e.text)) {
        dropCrashNote('モデルが落ちました');
      }
    }
    if (e.type === 'conversations') void loadConversations();
    if (e.type === 'unfinished') void loadUnfinished();
    if (e.type === 'undo') void loadUndo();
    if (e.type === 'musing' && !busyNow) {
      // 暇なときの考えごと。送りは止まらないので、待機中とは分けて言う。
      run.set(e.on ? 'musing' : 'idle', e.on ? '考えごと中（暇なとき）' : '待機中');
    }
    if (e.type === 'queue') {
      const box = $('queue');
      box.hidden = e.waiting === 0;
      box.textContent = `順番待ち ${e.waiting} 件`;
    }
    if (e.type === 'report') { void showReport(); return; }
    /*
     * **AI が「ここを見てください」と言ったら、その場所を開く。**
     *
     * ここまで、AI から画面へ向かう道が無かった。答えに `a.ts:120` と書かれても、
     * 人が横の一覧から探し直していた。`show_file` を呼ばれたら、エディタで開く。
     */
    if (e.type === 'show' && typeof e.path === 'string') {
      ctx.revealFile?.(e.path, typeof e.line === 'number' ? e.line : undefined);
      return;
    }
    /*
     * **AI が、選んでいる所を書き換えた（`replace_selection`）。**
     *
     * ここも AI から画面へ向かう道。ディスクではなく**欄の中だけ**を入れ替える。
     * 保存はしない（人が見て、良ければ保存する）。開いていない・選んだ所が
     * 動いていた、は画面の側で断る。
     */
    if (e.type === 'patch' && typeof e.path === 'string') {
      ctx.applyPatch?.(e);
      return;
    }
    // 裏の仕事の状態。設定 → モデル の一言と「まだ話せません」の押しボタンにも、最新を出す。
    if (e.type === 'jobs') noteJobs(e.jobs);
    if (e.type === 'stateChanged') { void refreshState(); void loadFiles(filesAt); void tellIfNotReady(); ctx.forgetCommands?.(); return; }
    if (e.type === 'themeChanged') return void loadTheme();
    if (e.type === 'thinkEvent') {
      if (e.event.type === 'chose') run.set('busy', `考え中: ${e.event.codename}`);
    }
    // いま触っているものを、上の帯に出す。終わったら「作業中」へ戻す
    // （**「読んでいます」のまま止まって見えるのが、いちばん困る**）。
    // 見ていない会話の動きで、上の帯を書き換えない
    const forOther = e.conversationId && conversations
      && (conversations.current ? e.conversationId !== conversations.current : !sendingFromTop);
    if (e.type === 'session' && busyNow && !forOther) {
      if (e.event.type === 'text' && !wroteYet) { wroteYet = true; run.set('busy', '答えています'); }
      if (e.event.type === 'toolStart') run.set('busy', doingText(e.event.name, e.event.summary));
      // ツールの結果を読んで、次の一言を待つ。
      if (e.event.type === 'toolEnd') { wroteYet = false; run.set('busy', WAITING_REPLY); }
    }
    /*
     * **見ている会話の出来事だけを描く。**
     *
     * 動いている間も別の会話を見に行ける。そのとき、動いている会話の答えが
     * 見ている会話へ流れ込むと、話が混ざる。会話の名前が添えてある出来事は、
     * 見ている会話のものだけ通す。他の会話のものは、横の一覧の「動いています」で分かる。
     */
    // 終わった会話の「写した所まで」は、見ている会話でなくても外す。外さずに残ると、選び直して送った次の答えは番号が 1 から
    // 振り直されるので、頭から写した数だけ捨てていた（答えが文の途中から始まって見えた）
    // 新しい回の始まり（busy:true）でも外す。選ぶ返事が終わりの合図より後に届くと、終わった回の値が入り直すため
    if (e.type === 'busy' && e.conversationId) copiedUpTo.delete(e.conversationId);
    if ((e.type === 'session' || e.type === 'busy') && e.conversationId && conversations
      && (conversations.current ? e.conversationId !== conversations.current : !sendingFromTop)) {
      if (e.type === 'busy' && !e.busy) void loadConversations();
      // 見ていない会話の書き換えも、ファイルは同じ。開いているエディタには届ける（会話の欄には描かない）。
      if (e.type === 'session' && e.event?.type === 'diff') for (const fn of eventHandlers.get('elsewhereDiff') ?? []) fn(e);
      return;
    }
    // 戻ったときに写した分は、もう描いてある。
    if (e.type === 'session' && typeof e.seq === 'number' && e.conversationId) {
      const upTo = copiedUpTo.get(e.conversationId);
      if (upTo !== undefined && e.seq <= upTo) return;
    }
    for (const fn of eventHandlers.get(e.type) ?? []) fn(e);
    for (const fn of lastingHandlers.get(e.type) ?? []) fn(e);
  };
}

/* ---------- 外の道具（MCP） ---------- */

/**
 * 繋がり具合を出す。**合言葉の値は決して出さない。**
 * 出すのは「入っているか」と「立ち上がったか」と「道具の数」だけ。
 */
async function loadMcp() {
  const box = $('mcpRows');
  box.replaceChildren();
  let d;
  try {
    d = await getJson('/api/mcp');
  } catch (e) {
    box.append(Object.assign(document.createElement('div'),
      { className: 'empty', textContent: `繋がり具合を読めませんでした: ${e.message ?? e}` }));
    return;
  }
  // 押した結果の表示を、読み直しで消さない。置き場は一覧の中に、行として出す
  // （一覧は二列の格子なので、直の子に混ぜると列が崩れる）。
  const where = document.createElement('div');
  where.className = 'row';
  const wk = document.createElement('span');
  wk.className = 'dim';
  wk.textContent = 'APIキーの保存先';
  const wv = document.createElement('span');
  wv.className = 'mono';
  wv.textContent = d.envPath;
  where.append(wk, wv);
  box.append(where);

  if (!d.servers?.length) {
    box.append(Object.assign(document.createElement('div'),
      { className: 'empty', textContent: 'まだ繋いでいません。上で GitHub の合言葉を入れて「繋ぐ」を押してください。' }));
    return;
  }
  for (const s of d.servers) {
    const row = document.createElement('div');
    row.className = 'row';
    const k = document.createElement('span');
    k.className = 'mono';
    k.textContent = s.name;
    const v = document.createElement('span');
    const state = !s.enabled ? '切ってあります'
      : !s.canRun ? `その命令がありません: ${s.command.split(' ')[0]}`
      : s.running ? `つながっています（道具 ${s.tools} 件）`
      : s.tried ? `つながりませんでした: ${s.failure ?? '理由は不明'}`
      : '次の依頼のときに立ち上がります';
    const secrets = (s.secrets ?? []).map((x) => `${x.name}: ${x.set ? 'あり' : 'まだ'}`).join(' / ');
    v.textContent = secrets ? `${state}  ｜  ${secrets}` : state;
    v.className = s.running ? 'good' : s.enabled ? 'dim' : 'dim';
    row.append(k, v);
    box.append(row);
  }
}

/**
 * 繋げる先の見本帳。
 *
 * **名前を一つ押せば繋がる。**要るものだけを訊く（合言葉が要るものは、それだけ）。
 * 値は入れたらすぐ消す。画面にも設定にも残さない。
 */
async function loadMcpCatalog() {
  const box = $('mcpCatalog');
  box.replaceChildren();
  let d;
  try {
    d = await getJson('/api/mcp/catalog');
  } catch (e) {
    box.append(Object.assign(document.createElement('div'),
      { className: 'empty', textContent: `見本帳を読めませんでした: ${e.message ?? e}` }));
    return;
  }
  // **元から入っているものを、先に言う。**
  // 繋ぐ先に並べていたので、持っている機能を入れ直させることになっていた。
  if (d.builtin?.length) {
    const have = document.createElement('div');
    have.className = 'mcp-builtin';
    have.append(Object.assign(document.createElement('div'),
      { className: 'mcp-name', textContent: '元から入っています（繋ぐ必要はありません）' }));
    for (const b of d.builtin) {
      const row = document.createElement('div');
      row.className = 'dim';
      row.textContent = `・${b.name} — ${b.about}`;
      have.append(row);
    }
    box.append(have);
  }

  for (const e of d.entries ?? []) {
    const card = document.createElement('div');
    card.className = 'mcp-card';

    const head = document.createElement('div');
    head.className = 'mcp-head';
    head.append(Object.assign(document.createElement('span'), { className: 'mcp-name', textContent: e.name }));
    // **繋ぐ前に、繋がらない理由が分かるようにする。**
    const tags = [[e.remote ? '遠く（npm は要りません）' : '手元', 'dim']];
    if (e.needsNpx) tags.push(['npm が要る', 'warn']);
    if (e.unverified) tags.push(['繋ぎ先は未確認', 'warn']);
    if (e.retired) tags.push(['廃止', 'bad']);
    if (e.connected) tags.push(['繋いであります', 'good']);
    for (const [text, cls] of tags) {
      head.append(Object.assign(document.createElement('span'), { className: `tag ${cls}`, textContent: text }));
    }
    card.append(head);
    card.append(Object.assign(document.createElement('div'), { className: 'dim', textContent: e.about }));
    if (e.retired) card.append(Object.assign(document.createElement('div'), { className: 'warn', textContent: e.retired }));

    // 要る合言葉。**入っているかどうかだけを言う。値は出さない。**
    const fields = [];
    for (const sec of e.secrets ?? []) {
      const row = document.createElement('label');
      row.className = 'field-row';
      const name = document.createElement('span');
      name.className = 'dim';
      name.textContent = `${sec.about}${sec.set ? '（入っています）' : ''}`;
      const input = document.createElement('input');
      input.type = 'password';
      input.spellcheck = false;
      input.autocomplete = 'off';
      input.placeholder = sec.set ? '入れ直すときだけ' : sec.where ?? sec.env;
      row.append(name, input);
      card.append(row);
      if (sec.where) {
        card.append(Object.assign(document.createElement('div'),
          { className: 'dim mono', textContent: sec.where }));
      }
      fields.push([sec.env, input]);
    }

    const bar = document.createElement('div');
    bar.className = 'btnbar';
    const connect = async (prefer) => {
      const secrets = {};
      for (const [env, input] of fields) if (input.value.trim()) secrets[env] = input.value.trim();
      $('ghNote').textContent = `${e.name} に繋いでいます…`;
      const r = await ask('/api/mcp/connect', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: e.id, secrets, ...(prefer ? { prefer } : {}) }),
      }, `${e.name} に繋げませんでした`);
      // **値は画面に残さない。**入れたら消す。
      for (const [, input] of fields) input.value = '';
      if (!r) { $('ghNote').textContent = '繋げませんでした'; return; }
      const body = r.body;
      if (!r.ok) { $('ghNote').textContent = body.error ?? '繋げませんでした'; return; }
      $('ghNote').textContent = [
        `${e.name} を設定に書きました: ${body.path}`,
        ...(body.missing ?? []).map((m) => `まだ要ります: ${m.about}（${m.env}）`),
        ...(body.notes ?? []),
        // 起こせなかったと言われたら、そう出す（読んでいなかったので、繋がらないのに「使えます」と言っていた）
        ...(body.note ? [body.note] : ['次の依頼のときから使えます。']),
      ].join('\n');
      await loadMcpCatalog();
      await loadMcp();
    };

    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'primary';
    go.textContent = e.connected ? '繋ぎ直す' : '繋ぐ';
    go.onclick = () => connect();
    bar.append(go);

    // 遠くが駄目だったときの逃げ道。**npm が要るので、そう書いておく。**
    if (e.remote && e.hasLocal) {
      const local = document.createElement('button');
      local.type = 'button';
      local.className = 'ghost';
      local.textContent = '手元で動かす（npm が要ります）';
      local.onclick = () => connect('local');
      bar.append(local);
    }
    if (e.connected) {
      const off = document.createElement('button');
      off.type = 'button';
      off.className = 'ghost';
      off.textContent = '外す';
      off.onclick = async () => {
        off.disabled = true; // 二度押すと、二本目の「繋いでいません」が、外せた知らせを上書きする
        const off1 = await ask(`/api/mcp/connect?id=${encodeURIComponent(e.id)}`,
          { method: 'DELETE' }, `${e.name} を外せませんでした`);
        if (!off1) { off.disabled = false; return; }
        // 断られたときは、外したと言わない（設定を書き換えられなかった・もう繋いでいない）。一覧は読み直す（もう外れていることがある）
        if (!off1.ok) {
          $('ghNote').textContent = off1.body?.error ?? `${e.name} を外せませんでした`;
          off.disabled = false;
          await loadMcpCatalog();
          return;
        }
        $('ghNote').textContent = `${e.name} を外しました。`;
        await loadMcpCatalog();
        await loadMcp();
      };
      bar.append(off);
    }
    card.append(bar);
    box.append(card);
  }
}

$('ghReload').onclick = () => { void loadMcpCatalog(); void loadMcp(); };

/* ---------- 横の板：会話 ---------- */

/*
 * 残してある会話を出して、開き直せるようにする。
 * ここまでメモリの中だけだったので、窓を閉じると消えていた。
 */
let conversations = { current: null, list: [] };
// 動いている会話へ戻ったとき、写した分の番号。これ以下の出来事は二度描かない。
const copiedUpTo = new Map();
/*
 * **トップに居るときは、動いている会話の出来事を描かない。**
 *
 * トップ（どの会話も見ていない）では「見ている会話と違う」の比べようが無く、
 * 動いている会話の答えが空の会話へ流れ込んでいた（Chromium で見えた）。
 * 送った直後だけは別で、自分の会話の名前を本体から受け取るまでの間、
 * 出来事はまだ名前を知らない自分の会話のもの。そこだけ通す。
 */
let sendingFromTop = false;
/**
 * いま見ている会話の id。**パネルが自分で取り直すために要る。**
 *
 * ここまで、会話の中身は「頁を開いた最初の一回」と「横の一覧から選んだとき」
 * にしか流し込んでいなかった。パネルを一枚でも出し入れすると `render()` が
 * 全部作り直すので、**話している途中でも、やり取りが画面から消える。**
 * 本体には残っているので、頁を読み直すまで戻らない（消えたと思われる）。
 */
ctx.conversationId = () => conversations.current;
ctx.sending = () => { sendingFromTop = !conversations.current; };
// トップから送って決まった会話を見る。返事を待つ間に別の会話を選んでいたら、そちらを見たまま（引き戻さない）
ctx.adopt = (id) => {
  if (id && !conversations.current) { conversations.current = id; drawConversations(); }
  sendingFromTop = false;
};
// 見ていた会話が無くなっていた（別のタブで消された）。まだその会話を見ていれば、トップへ戻す
ctx.conversationGone = (id) => {
  if (conversations.current !== id) return;
  conversations.current = null;
  ctx.showHistory([]);
  void showWaitingApprovals();
  void loadConversations();
};
let busyNow = false;

/**
 * 見ている会話が動いているかで、上の帯と止めるボタンを決め直す。会話を選ぶ・トップへ戻る・開き直すたびに呼ぶ。
 * 前は見ている会話の busy の知らせでしか変えなかったので、走っている会話から別の会話へ移ると「作業中」が持ち越され
 * （止めるボタンは前の会話を止めた）、走っている会話を開いたときは「待機中」のままで止めるボタンも出なかった
 */
function showBusyOfViewed(live) {
  busyNow = live;
  wroteYet = false;
  run.set(live ? 'busy' : 'idle', live ? WAITING_REPLY : '待機中');
  drawConversations();
}

/**
 * やり残しを出す。
 *
 * **見えて、やめられること。**控えるだけなら覚え書きだが、こちらから
 * 勝手に続きを始めるので、何が残っているかは常に見えていないといけない。
 */
/*
 * やめて、まだ戻せるやり残し（本体が、立ち上げてからやめた分を新しい順に `canceled` で渡す）。押し間違えを、その場で戻せるようにする
 * （元の依頼の文は、やり残しの記録にしか無い）。最後の一件は目の前に、それより前は畳んで並べる
 * （前は画面が最後の一件だけを持っていたので、続けて二つやめると一つ目を戻せず、読み直すと戻す口ごと消えた）。
 */
// 「閉じる」を押したら、次にやめるまで出さない（本体には残っていて、開き直せばまた出る）
let hideCanceled = false;
// 畳んだ分を開いているか。一覧は何度も描き直すので、覚えておかないと開いたそばから閉じる
let canceledMoreOpen = false;

async function loadUnfinished() {
  let data;
  try {
    data = await getJson('/api/unfinished');
  } catch { return; }
  let goals = { list: [], stride: {} };
  try {
    goals = await getJson('/api/goals');
  } catch { /* 段取りが読めなくても、やり残しは出す */ }

  const sec = $('unfinishedSec');
  const box = $('sideUnfinished');
  const list = data.list ?? [];
  // 戻せるものは本体が知っている（別のタブで戻した・畳んだものは、もう並ばない）
  const canceled = hideCanceled || !Array.isArray(data.canceled) ? [] : data.canceled;
  // 読めなかったことは言う（空の一覧を「やり残しなし」と見せない）
  const unreadable = [data.error, goals.error].filter((t) => typeof t === 'string' && t);
  sec.hidden = list.length === 0 && goals.list.length === 0 && canceled.length === 0 && unreadable.length === 0;
  box.textContent = '';
  for (const t of unreadable) {
    const row = document.createElement('div');
    row.className = 'side-row warn';
    row.textContent = t;
    box.append(row);
  }

  // 段取り。**どこまで進んだかを出す。**一段ずつ進むので、見えないと
  // 「止まっている」のか「一段ずつ進んでいる」のかが区別できない。
  for (const g of goals.list) {
    const head = document.createElement('div');
    head.className = 'side-row';
    const label = document.createElement('span');
    label.className = 'grow';
    label.textContent = `${g.request.split('\n')[0].slice(0, 24)}（${g.progress.done}/${g.progress.total}）`;
    label.title = g.request;
    head.append(label);
    box.append(head);
    for (const st of g.steps) {
      if (st.state === 'split') continue; // 割られた段そのものは出さない
      const row = document.createElement('div');
      row.className = 'side-step';
      const mark = st.state === 'done' ? '✓' : st.state === 'blocked' ? '×' : '·';
      row.textContent = `${mark} ${st.instruction}`;
      row.title = st.state === 'blocked' ? '手が付きませんでした' : st.instruction;
      if (st.state === 'done') row.classList.add('done');
      if (st.state === 'blocked') row.classList.add('blocked');
      box.append(row);
    }
  }
  for (const u of list) {
    const row = document.createElement('div');
    row.className = 'side-row';

    const label = document.createElement('button');
    label.className = 'ghost row grow';
    label.title = `${u.whyText}（${u.attempts} 回試しました）`;
    label.textContent = (u.running ? '▶ ' : '') + u.request.split('\n')[0].slice(0, 40);
    label.disabled = true;

    const stop = document.createElement('button');
    stop.className = 'ghost icon';
    stop.title = 'これはもうやらない';
    stop.textContent = '×';
    stop.addEventListener('click', async () => {
      const done = await ask(`/api/unfinished?id=${encodeURIComponent(u.id)}`,
        { method: 'DELETE' }, 'やり残しを消せませんでした');
      if (!done) return;
      // 断られたときも黙らない（前は 500 でも何も出さず、押しても消えないだけに見えた）
      if (!done.ok) return showCrash('やり残しを消せませんでした', done.body?.error ?? `${done.status}`);
      hideCanceled = false;
      await loadUnfinished();
    });

    row.append(label, stop);
    box.append(row);
  }
  box.append(...canceledNotes(canceled));
}

/** やめたやり残しの見出し（依頼の一行目の頭）。 */
const canceledText = (c) => String(c.request ?? '').split('\n')[0].slice(0, 40);

/** 「〜をやめました [戻す] [閉じる]」と、それより前にやめた分の畳み。 */
function canceledNotes(canceled) {
  if (canceled.length === 0) return [];
  const [latest, ...older] = canceled;
  const row = canceledNote({ id: latest.id, text: canceledText(latest) });
  if (older.length === 0) return [row];
  const more = document.createElement('details');
  more.className = 'removed-more';
  more.open = canceledMoreOpen;
  more.addEventListener('toggle', () => { canceledMoreOpen = more.open; });
  const summary = document.createElement('summary');
  summary.className = 'dim';
  summary.textContent = `ほかにも ${older.length} 件戻せます`;
  more.append(summary);
  for (const c of older) {
    const r = document.createElement('div');
    r.className = 'side-note dim';
    const t = document.createElement('span');
    t.className = 'grow';
    t.textContent = `「${canceledText(c)}」`;
    r.append(t, reopenButton(c.id));
    more.append(r);
  }
  return [row, more];
}

/** やめたやり残しを戻す口。戻すときは番号だけを送る。 */
function reopenButton(id) {
  const undo = document.createElement('button');
  undo.className = 'ghost tiny';
  undo.textContent = '戻す';
  undo.title = 'やめたやり残しを元に戻す';
  undo.addEventListener('click', async () => {
    undo.disabled = true; // 二度押すと、二本目が「やめたものの中にありません」になる
    const got = await ask('/api/unfinished/reopen', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }),
    }, 'やり残しを戻せませんでした');
    if (!got) { undo.disabled = false; return; }
    if (!got.ok) {
      showCrash('やり残しを戻せませんでした', got.body?.error ?? `${got.status}`);
      // 押しても戻らない口は残さない（畳んだ・同じ依頼をもう一度記録した・上限まで溜まっている）。本体の一覧からも消えている
      if (!got.body?.gone) { undo.disabled = false; return; }
    }
    await loadUnfinished();
  });
  return undo;
}

/** 「〜をやめました [戻す] [閉じる]」。 */
function canceledNote({ id, text }) {
  const row = document.createElement('div');
  row.className = 'side-note dim';
  const label = document.createElement('span');
  label.className = 'grow';
  label.textContent = `「${text}」をやめました`;
  const close = document.createElement('button');
  close.className = 'ghost tiny';
  close.textContent = '閉じる';
  close.addEventListener('click', () => { hideCanceled = true; void loadUnfinished(); });
  row.append(label, reopenButton(id), close);
  return row;
}

/**
 * 戻せるところを出す。
 *
 * **手元の小さいモデルは、間違った直しを当てる。**そのとき利用者にできることが
 * 「自分で書き戻す」しか無いなら、任せられない。git があってもコミット前は
 * 戻せないし、社用PC には git が無い。
 *
 * 一つだけ戻すのではなく、**そこまで戻す**。後の直しが上に乗っているので、
 * 途中だけ古い状態にすると、どこにも無かった形になる。押す前にそう言う。
 */
async function loadUndo() {
  let data;
  try {
    data = await getJson('/api/undo');
  } catch { return; }
  const list = data.list ?? [];
  const sec = $('undoSec');
  const box = $('sideUndo');
  sec.hidden = list.length === 0 && !data.error;
  box.textContent = '';
  if (data.error) {
    // 読めないのを「戻せるものは無い」と見せない
    const note = document.createElement('div');
    note.className = 'side-note dim';
    note.textContent = `戻り先を読めません（${data.error}）`;
    box.append(note);
    return;
  }

  /*
   * **少しだけ出す。**
   *
   * 全部出していたら、30 件が横の並びを丸ごと占領して、その下の「会話」と
   * 「作業場」が画面の外へ押し出された。押せないので、**在るのに無いのと
   * 同じ**になっていた。`scripts/sweep.mjs` で押して回って見つけた
   * （試験は全部通っていた）。
   *
   * 戻すのは、たいてい直後の一件か二件。古いものは畳んでおく。
   */
  const shown = undoOpen ? list : list.slice(0, UNDO_SHOWN);

  shown.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'side-row';

    // **一行に収める。**span で置いたら三行に折れて、押す印が浮いた（見て直した）。
    // 一覧の行は button に切り詰めの決まりが掛かっているので、それに合わせる。
    const label = document.createElement('button');
    label.className = 'ghost row grow';
    label.disabled = true;
    const when = undoWhen(p.at);
    label.textContent = `${when} ${p.request}`;
    label.title = `${p.request}\n触ったファイル（${p.paths.length} 件）:\n${p.paths.join('\n')}`;

    /*
     * **戻るファイルを、全部並べてから訊く。**
     *
     * ここは選んだ一件の `paths` だけを出していた。戻るのはこの後の回の分も
     * 含む（`src/core/undo.ts` の `restore`）ので、**並べていないファイルまで
     * 書き戻る。**消える直しが在るのに、名前が出ていない形だった。
     */
    const willTouch = willRestore(list, i);
    // 大きすぎて控えていない分は、戻らない。押す前に、そう言う。
    const wont = wontRestore(list, i);
    const wontSay = wont.length > 0
      ? `\n戻らないファイルが ${wont.length} 件あります（大きすぎて控えていません）:\n${wont.join('\n')}`
      : '';
    const back = document.createElement('button');
    back.className = 'ghost icon';
    back.title = (i === 0
      ? `ここまで戻す（${willTouch.length} 件）`
      : `ここまで戻す（この後の ${i} 回ぶんも一緒に、${willTouch.length} 件）`)
      + (wont.length > 0 ? `／戻らない ${wont.length} 件` : '');
    back.textContent = '↶';
    back.addEventListener('click', async () => {
      const also = i === 0 ? '' : `\nこの後の ${i} 回ぶんの直しも一緒に戻ります。`;
      if (!confirm(`「${when} ${p.request}」の前まで、${willTouch.length} 件のファイルを戻します。${also}\n\n${willTouch.join('\n')}${wontSay}`)) return;
      back.disabled = true;
      try {
        // 見ていた一番新しい戻り先を添える（確かめている間に新しい回ができたら、名前を出していない回まで戻さない）
        const ask = (force) => JSON.stringify({ id: p.id, latest: list[0]?.id, force });
        let r = await fetch('/api/undo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: ask(false) });
        let body = await r.json().catch(() => ({}));
        // 戻り先の後に変わったファイルがある。黙って消さず、それでも戻すかを訊く
        if (r.status === 409 && Array.isArray(body.conflict)) {
          if (!confirm(`戻り先の後に変わったファイルがあります。戻すと、その変更も消えます。\n\n${body.conflict.join('\n')}\n\nそれでも戻しますか？`)) return;
          r = await fetch('/api/undo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: ask(true) });
          body = await r.json().catch(() => ({}));
        }
        if (!r.ok) alert(body.error ?? '戻せませんでした');
        // 戻せたが、言わなければいけないことがある（戻せなかったファイル・片づけられなかった戻り先）
        else if (Array.isArray(body.warnings) && body.warnings.length > 0) alert(body.warnings.join('\n\n'));
      } finally {
        back.disabled = false;
        await loadUndo();
      }
    });

    row.append(label, back);
    box.append(row);
  });

  // 隠したぶんは、**黙って隠さない。**何件あるかを言って、押せば出す。
  if (list.length > UNDO_SHOWN) {
    const more = document.createElement('button');
    more.className = 'ghost';
    more.textContent = undoOpen
      ? '少なく表示'
      : `ほかに ${list.length - UNDO_SHOWN} 件`;
    more.addEventListener('click', () => { undoOpen = !undoOpen; void loadUndo(); });
    box.append(more);
  }
}

/** 畳んでいるときに出す数。戻すのは、たいてい直後の一件か二件。 */
const UNDO_SHOWN = 3;
let undoOpen = false;

/** トップへ戻る。何も開いていない画面。そこで書き始めると、新しい会話になる。 */
async function goTop() {
  const r = await ask('/api/conversations', { method: 'POST' }, 'トップへ戻れませんでした');
  if (!r) return;
  if (!r.ok) return void showCrash('トップへ戻れません', r.body.error ?? '', 'warn');
  conversations.current = null;
  ctx.showHistory([]);
  showBusyOfViewed(false);
  void showWaitingApprovals();
  await loadConversations();
}

/*
 * このタブが見ている会話（`conversations.current`）は、最初の一回だけ本体から受け取り、後はこのタブが持つ。
 * 本体の「見ている会話」は一つで、全部のタブと見回りの再開が書き換える。読み直すたびに受け取っていたので、
 * 別のタブで選び直すと、こちらの欄は前の会話のまま「見ている会話」だけが替わり、その会話の答えが欄に描かれていた。
 */
let currentKnown = false;
async function loadConversations() {
  let got;
  try {
    got = await getJson('/api/conversations');
  } catch { return; }
  if (currentKnown) got.current = conversations.current ?? null;
  else currentKnown = true;
  conversations = got;
  drawConversations();
}

/*
 * 消して、まだ戻せる会話（本体が `trash/` に持っている分を、新しい順に `conversations.trash` で受け取る）。
 * 押し間違えを、その場で戻せるようにする。最後の一件は目の前に、それより前は畳んで並べる
 * （前は画面が最後の一件だけを持っていたので、続けて二つ消すと一つ目を戻せず、読み直すと戻す口ごと消えた）。
 */
// 「閉じる」を押したら、次に消すまで出さない（本体には残っていて、開き直せばまた出る）
let hideRemoved = false;
// 畳んだ分を開いているか。一覧は何度も描き直すので、覚えておかないと開いたそばから閉じる
let removedMoreOpen = false;

/** 消した会話を戻す口。戻すときは名前だけを送る。 */
function restoreButton(id) {
  const undo = document.createElement('button');
  undo.className = 'ghost tiny';
  undo.textContent = '戻す';
  undo.title = '消した会話を元に戻す';
  undo.addEventListener('click', async () => {
    undo.disabled = true; // 二度押すと、二本目が「戻せる会話がありません」になる
    const got = await ask('/api/conversations/restore', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }),
    }, '会話を戻せませんでした');
    if (!got) { undo.disabled = false; return; }
    if (!got.ok) {
      showCrash('会話を戻せませんでした', got.body?.error ?? `${got.status}`);
      // 押しても戻らない口は、読み直した一覧から消える（本体の `trash` に無い）
      if (!got.body?.gone) { undo.disabled = false; return; }
    }
    await loadConversations();
  });
  return undo;
}

/** 「〜を消しました [戻す] [閉じる]」と、それより前に消した分の畳み。 */
function removedNotes() {
  const trash = Array.isArray(conversations.trash) ? conversations.trash : [];
  if (conversations.trashError) {
    // 読めないのを「消した会話は無い」と見せない
    const note = document.createElement('div');
    note.className = 'side-note dim';
    note.textContent = conversations.trashError;
    return [note];
  }
  if (trash.length === 0 || hideRemoved) return [];
  const [latest, ...older] = trash;
  const row = document.createElement('div');
  row.className = 'side-note dim';
  const label = document.createElement('span');
  label.className = 'grow';
  label.textContent = `「${latest.title}」を消しました`;
  const close = document.createElement('button');
  close.className = 'ghost tiny';
  close.textContent = '閉じる';
  close.addEventListener('click', () => { hideRemoved = true; drawConversations(); });
  row.append(label, restoreButton(latest.id), close);
  if (older.length === 0) return [row];
  const more = document.createElement('details');
  more.className = 'removed-more';
  more.open = removedMoreOpen;
  more.addEventListener('toggle', () => { removedMoreOpen = more.open; });
  const summary = document.createElement('summary');
  summary.className = 'dim';
  summary.textContent = `ほかにも ${older.length} 件戻せます`;
  more.append(summary);
  for (const item of older) {
    const r = document.createElement('div');
    r.className = 'side-note dim';
    const t = document.createElement('span');
    t.className = 'grow';
    t.textContent = `「${item.title}」`;
    r.append(t, restoreButton(item.id));
    more.append(r);
  }
  return [row, more];
}

function drawConversations() {
  const box = $('sideSessions');
  box.textContent = '';
  // 戻せるものは本体が知っている（別のタブで戻したもの・立ち上げ直して消えたものは、もう並ばない）
  box.append(...removedNotes());

  // 「新しい会話」の押しボタンは置かない。**トップ（何も開いていない画面）で
  // 書き始めれば新しい会話になる。**トップへは名前（左上）を押して戻る。

  if (conversations.list.length === 0) {
    box.append(Object.assign(document.createElement('div'),
      { className: 'empty', textContent: 'まだありません' }));
    return;
  }

  for (const head of conversations.list) {
    const row = document.createElement('div');
    row.className = 'side-row';
    const open = document.createElement('button');
    open.textContent = head.title;
    // 数え切れていないときは、そう見せる（頭しか読んでいない）。
    open.title = `${head.title}（${head.messages}${head.more ? '+' : ''}）`;
    open.className = head.id === conversations.current ? 'on' : '';
    // 動いている会話には ● を付ける。**動いている間も切り替えられる**ので、押せる。
    if ((conversations.runningAll ?? [conversations.running]).includes(head.id)) {
      open.textContent = `● ${head.title}`;
      open.title += '（動いています）';
    }
    open.onclick = async () => {
      const r = await ask('/api/conversations/select', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: head.id }),
      }, '開けませんでした');
      if (!r) return;
      if (!r.ok) return void alert(r.body.error ?? '開けませんでした');
      conversations.current = head.id;
      ctx.showHistory(r.body.messages ?? []);
      // 欄を描き直すと承認の箱も消える。待っている承認は会話によらないので、出し直す
      if (r.body.approvals?.length) ctx.showApprovals?.(r.body.approvals);
      if (r.body.inFlight) {
        // 動いている会話へ戻った。途中までを写し、続きの出来事を通す。
        copiedUpTo.set(head.id, r.body.inFlight.seq);
        ctx.showInFlight(r.body.inFlight);
      } else {
        // 動いていない。前に写した所までの記録が残っていても使わない（次の答えの番号は 1 から振り直される）
        copiedUpTo.delete(head.id);
      }
      showBusyOfViewed(Boolean(r.body.inFlight));
      await loadConversations();
    };
    /*
     * **名前を付け替えられるようにする。**
     *
     * 見出しは最初の依頼から自動で付くだけだった。話が進むほど中身と
     * ずれるが、直す口が無いので、消して作り直すしかない。
     * 消せば話も消えるので、実際には直せない。
     */
    const label = document.createElement('button');
    label.className = 'rename';
    label.textContent = '✎';
    label.title = '名前を変える';
    label.onclick = async () => {
      const want = window.prompt('この会話の名前', head.title);
      if (want === null) return;
      const r = await ask('/api/conversations/title', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: head.id, title: want }),
      }, '名前を変えられませんでした');
      if (!r) return;
      if (!r.ok) return void alert(r.body.error ?? '変えられませんでした');
      await loadConversations();
    };
    // 消すのは、押し間違えると取り返しがつかない。一度訊く。
    const drop = document.createElement('button');
    drop.className = 'drop';
    drop.textContent = '×';
    drop.title = '消す';
    drop.disabled = busyNow;
    drop.onclick = async () => {
      if (!confirm(`「${head.title}」を消します。\n\n消した直後は、一覧の「戻す」で戻せます（立ち上げ直すと、本当に消えます）。`)) return;
      const r = await ask(`/api/conversations?id=${encodeURIComponent(head.id)}`,
        { method: 'DELETE' }, '消せませんでした');
      if (!r) return;
      if (!r.ok) return void alert(r.body.error ?? '消せませんでした');
      if (head.id === conversations.current) { conversations.current = null; ctx.showHistory([]); void showWaitingApprovals(); }
      hideRemoved = false;
      await loadConversations();
    };
    row.append(open, label, drop);
    box.append(row);
  }

  // **出していない分を、黙って隠さない。**古い会話は消えていない。
  // 一覧に全部出すと、増えるほど開くのが重くなるので、新しい方から出す。
  if (conversations.hidden > 0) {
    box.append(Object.assign(document.createElement('div'), {
      className: 'dim',
      textContent: `ほかに ${conversations.hidden} 件（古いものは一覧に出していません。消えてはいません）`,
    }));
  }
}

/**
 * 作業場を変える。
 *
 * **ここが、作業場を決める場所。**設定の奥（モデルの頁）に置いていたので、
 * 誰も辿り着けなかった。作業場を見ている、その場で変える。
 */
async function pickWorkRoot() {
  // 初めの値は、省いていない道（title）から取る。表示の文字（省いた道と、隣の「開く」「コピー」）から取ると、
  // そのまま OK を押しただけで偽の道が保存され、その名前のフォルダが作られて、そこで作業していた
  const nowAt = $('workNow').title ?? '';
  const want = window.prompt('直してほしいコードのある場所を打ってください。\n（空にすると既定へ戻ります）', nowAt);
  if (want === null) return;
  /*
   * **作業場だけを送る。**
   *
   * ここは `kind` と `modelsDir` も一緒に送っていた。値は設定の頁の入力欄から
   * 取るが、その欄は設定→モデルを開いたときしか埋まらない。開いていない頁では
   * 空なので、**llamacpp や Ollama の指定と、GGUF の保存先が黙って消える。**
   * 触らないものは送らない（本体側も、送られてこなければ触らない）。
   */
  const r = await ask('/api/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workRoot: want.trim() }),
  }, 'フォルダを変えられませんでした');
  if (!r) return;
  const body = r.body;
  if (!r.ok) { alert(body.error ?? '変えられませんでした'); return; }
  // 打ち間違えても保存はできる。**そのときは言う。**
  if (body.workNote) alert(body.workNote);
  /*
   * **開いている場所を、根へ戻してから引き直す。**
   *
   * `filesAt` は前の作業場の中の道。変えたあとにそのまま引くと、
   * 新しい作業場の外なので 400 になり、画面に赤い字が出る。
   * 下の `loadFiles` には受け皿を置いてあるが、**そもそも訊かない。**
   */
  filesAt = '';
  await loadFiles();
}

/* ---------- 横の板：作業場 ---------- */

/*
 * どこで何を触っているのかが見えないまま指示を書くのは、
 * 暗い所で手探りをするのと同じ。一階層ずつ開く。
 */
let filesAt = '';

async function loadFiles(at = '') {
  const box = $('sideFiles');
  try {
    let r = await fetch(`/api/files?path=${encodeURIComponent(at)}`);
    let body = await r.json();
    /*
     * **作業場が変わったら、根から見直す。**
     *
     * 開いている場所（`filesAt`）は前の作業場の中の道。作業場を変えると、
     * その道は新しい作業場の外になるので 400 が返る。画面には赤い字が出て、
     * 一覧は前のまま。**変えたのに変わっていないように見える。**
     * 一度だけ根で引き直す（それでも駄目なら、下の catch で理由を出す）。
     */
    // 読めないフォルダ（409）は根で引き直さず、理由を出す
    if (!r.ok && r.status !== 409 && at !== '') {
      r = await fetch('/api/files?path=');
      body = await r.json();
    }
    if (!r.ok) throw new Error(body.error ?? '読めませんでした');
    filesAt = body.path;
    $('filesHead').textContent = body.path ? `ファイル / ${body.path}` : 'ファイル';
    // **いまどこを触っているのかを、常に出す。**
    // これが見えないまま指示を書くのは、暗い所で手探りをするのと同じ。
    const now = $('workNow');
    // 長い道は**真ん中を省く**。頭（どのドライブか）と末尾（どのフォルダか）が
    // 要るので、端を切ると分からなくなる。
    const full = body.root ?? '';
    // 道は省いた形で一行に、隣に「開く」「コピー」。道の箱そのものを nowrap にすると
    // 押し場所まで切れて見えない（画面で見て直した）。
    const shown = document.createElement('span');
    shown.className = 'side-path-text';
    shown.textContent = full.length > 34 ? `${full.slice(0, 12)}…${full.slice(-20)}` : full;
    now.replaceChildren(shown);
    now.title = full;
    if (full) now.append(pathActions(full));
    // **空のときに、何も言わない板を出さない。**入れた直後はここが空で、
    // 何も出ないと壊れているようにしか見えない。何の場所で、どう変えるかを書く。
    if (!body.path && (body.entries ?? []).length === 0) {
      box.textContent = '';
      /*
       * **無い場所を案内しない。**
       *
       * ここは「設定 → モデル の『フォルダ』で指す」と書いていた。
       * その頁に「フォルダ」は無い（作業場を変える口は、ここの 📂）。
       * 言われたとおりに開いた人は、無いものを探すことになる。
       *
       * 押せる形にして、その場で変えられるようにする。
       */
      const note = document.createElement('button');
      note.className = 'side-empty';
      note.textContent = 'ここは空です。直したいコードのあるフォルダを選んでください（上の 📂 でも変えられます）。';
      note.title = body.root ?? '';
      note.onclick = () => { void pickWorkRoot(); };
      box.append(note);
      return;
    }
    box.textContent = '';

    if (body.path) {
      const up = document.createElement('button');
      up.textContent = '‹ 上へ';
      up.onclick = () => loadFiles(body.path.includes('/') ? body.path.slice(0, body.path.lastIndexOf('/')) : '');
      box.append(up);
    }
    if (body.entries.length === 0) box.append(Object.assign(document.createElement('div'), { className: 'empty', textContent: '空です' }));
    for (const entry of body.entries) {
      const b = document.createElement('button');
      b.textContent = `${entry.dir ? '📁' : '📄'} ${entry.name}`;
      b.title = entry.path;
      // フォルダは開く。ファイルはエディタで開く（その場で直せる）。
      // 依頼に添えたいときは、隣の @ を押す。
      b.onclick = () => (entry.dir ? loadFiles(entry.path) : openInEditor(entry.path));
      if (entry.dir) { box.append(b); continue; }
      const row = document.createElement('div');
      row.className = 'side-row';
      const at = document.createElement('button');
      at.className = 'icon file-at';
      at.textContent = '@';
      at.title = '依頼に添える（中身ごと渡る）';
      at.onclick = () => insertPath(entry.path);
      row.append(b, at);
      box.append(row);
    }
    /*
     * **出していない分を、黙って隠さない。**
     *
     * 一覧は多すぎると切る（開くのが重くなるため）。切ったことを言わないので、
     * 5000 件のフォルダでは 400 件だけ出て、**残りは無いように見えていた**
     * （押して実測）。戻せる一覧や会話の一覧と同じように、何件あるかを言う。
     */
    const hidden = (body.total ?? body.entries.length) - body.entries.length;
    if (hidden > 0) {
      box.append(Object.assign(document.createElement('div'), {
        className: 'dim',
        textContent: `ほかに ${hidden} 件（多いので一覧に出していません。探すパネルか、依頼の中で名前を書けば届きます）`,
      }));
    }
  } catch (e) {
    box.textContent = '';
    box.append(Object.assign(document.createElement('div'), { className: 'empty', textContent: String(e.message ?? e) }));
  }
}

/** 押したファイルの道を、書きかけの指示に足す。 */
/**
 * エディタで開く。出ていなければ出してから開く。
 *
 * 出す口が「表示するもの」の一覧だけだと、ファイルを押しても何も起きない
 * ように見える。押した人が最初に見るのはここなので、ここで出す。
 */
async function openInEditor(path, line) {
  const shown = new Set(panelsInUse(layout.root));
  const has = layout.panels.some((p) => p.kind === 'editor' && shown.has(p.id));
  if (!has) await apply(openPanel(layout, 'editor'));
  ctx.openFile(path, line);
}

ctx.revealFile = (path, line) => { void openInEditor(path, line); };

/** 書きかけの指示に、言葉を足す。押した所から会話へ渡る道は、全部ここを通る。 */
function appendToInstruction(text) {
  const input = document.querySelector('.chat textarea');
  if (!input) return false;
  input.value = input.value ? `${input.value.replace(/\s+$/, '')} ${text} ` : `${text} `;
  input.focus();
  return true;
}

function insertPath(path) {
  // **`@` を付ける。**印が付いていると、送るときに中身ごと渡る。
  // 道の文字だけだと、開かずに書き始めることがある。
  appendToInstruction(`@${path}`);
}

/*
 * **探した所を、会話へ渡す。**
 *
 * 探して見つけた行を AI に訊くとき、道と行を**打ち直していた**（`src/a.ts:120`）。
 * 打ち間違えれば別の所の話になる。押した所から渡す。
 */
ctx.insertText = (text) => appendToInstruction(text);

/*
 * **覚え書きを、残す。**
 *
 * 打った分は配置と一緒に残す（`spec.options.text`）。**描き直さない**のが肝心で、
 * 描き直すと打っている最中に欄が作り直され、手が飛ぶ。
 */
ctx.saveNote = async (id, text) => {
  const spec = layout.panels.find((p) => p.id === id);
  if (!spec) return false;
  spec.options = { ...(spec.options ?? {}), text };
  return Boolean(await save(layout));
};

/**
 * 横の板の開け閉め。
 *
 * **閉じたら開けない、を作らない。**つまみを板の中に置いていたので、
 * 畳むと押すものごと消えて、二度と開けなかった（利用者から言われた）。
 * 開き直すつまみは板の外にあり、畳んだときだけ出る。
 */
function showSide(on) {
  $('side').hidden = !on;
  $('sideOpen').hidden = on;
  try { localStorage.setItem('aas.side', on ? '1' : '0'); } catch { /* 使えない環境もある */ }
}
$('sideToggle').onclick = () => showSide(false);
$('sideOpen').onclick = () => showSide(true);
// 前回どうしていたかを覚えておく。毎回畳み直させない。
try { if (localStorage.getItem('aas.side') === '0') showSide(false); } catch { /* 同上 */ }

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
  if (!r) return;
  render();
  if (r.repairs?.length) {
    $('json').value = JSON.stringify(r.layout, null, 2);
    $('repairs').textContent = r.repairs.map((x) => `・${x.detail}`).join('\n');
    $('editor').showModal();
  }
});

$('presets').onchange = async (e) => {
  const r = await askJson('/api/layout/preset', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: e.target.value }),
  }, '配置を変えられませんでした');
  if (!saved(r, 'layout', '配置を変えられませんでした')) return;
  layout = r.layout;
  render();
};

/* ---------- コマンド ---------- */

/**
 * 更新。押した瞬間に取ってくるのではなく、まず何が入るのかを見せる。
 * 中身を見ずに新しくするのは、動いているものを賭けに出すのと同じ。
 */
async function checkForUpdate() {
  const status = await askJson('/api/update', undefined, '更新を見に行けませんでした');
  if (!status) return;
  if (!status.can) {
    alert(status.reason || status.error || '更新できません'); // 見に行けなかった理由（{ error }）も言う
    return;
  }
  const list = status.incoming.map((c) => `  ${c}`).join('\n');
  if (!confirm(`${status.behind}件の変更があります。\n\n${list}\n\n取り込みますか？`)) return;

  // 取り込みは本体の中でもう一度取りに行くので、遅い回線では 30 秒を超える。上限を長くし、それでも切れたら「分からない」と言う
  // （前は 30 秒で切って「更新できませんでした」と出したが、本体は取り込みを済ませていて、動いているコードと置いてあるコードがずれたままになった）
  const r = await ask('/api/update', { method: 'POST', signal: AbortSignal.timeout(10 * 60_000) }, '更新の返事が届きませんでした');
  if (!r) {
    alert('更新が終わったかどうか分かりません。取り込みが済んでいることがあるので、設定の「立ち上げ直す」から立ち上げ直してください。');
    $('cfgRestart').hidden = false;
    return;
  }
  const result = r.body;
  // 取り込んだ後は、動いているコードと置いてあるコードがズレている。
  // 黙って立ち上げ直さず、訊いてから。断られたら、ズレたまま使わせる
  // のではなく、後で押せる場所（設定）を示す。
  if (!r.ok) { alert(result.message || result.error || '更新できませんでした'); return; }
  if (confirm(`${result.message || '更新しました'}\n\nいま立ち上げ直しますか？`)) {
    await restartAndReload($('cfgNote'));
  } else {
    alert('設定の「立ち上げ直す」から、いつでも立ち上げ直せます。');
    $('cfgRestart').hidden = false;
  }
}

/**
 * 何ができるかを、覚えていなくても引ける形にする。
 * 隠し機能は無い機能と同じなので、全部ここに並べる。
 *
 * **並べるのは動作。**ここは見た目と配置の切り替えが大半で、押した人には
 * 設定の一覧にしか見えなかった（実機でそうなった）。会話・ファイル・モデル・
 * 診断の順に、その場でやることを前に置く。見た目と配置は末尾に「設定:」と付けて残す。
 */
async function commands() {
  const list = [];
  const add = (name, hint, run) => list.push({ name, hint, run });
  const json = async (path) => { try { const r = await fetch(path, { signal: AbortSignal.timeout(5000) }); return r.ok ? await r.json() : null; } catch { return null; } };

  // 会話
  add('新しい会話（トップへ）', '', () => goTop());
  add('/plan', '分解して、一段ずつ進める', () => ctx.prefill('/plan '));
  // 打ち込みのコマンドと、作業場の skill。選ぶと入力欄に `/名前 ` が入る。
  const cmds = await json('/api/commands');
  for (const c of cmds?.commands ?? []) {
    add(`/${c.name}`, c.description + (c.source === 'skill' ? `（skill: ${c.path}）` : ''), () => ctx.prefill(`/${c.name} `));
  }
  add('中断する', '動いている依頼を止める', () => void stopRun());
  add('いま考えさせる', '暇なときの考えごとを今やる', async () => {
    const r = await ask('/api/think', { method: 'POST' }, '考えさせられませんでした');
    // 作業中は断られる（409）。黙らない
    if (r && !r.ok) showCrash('考えさせられませんでした', r.body?.error ?? `${r.status}`, 'warn');
  });
  add('入力へ移動', 'Ctrl+/', () => ctx.focusInput());

  // ファイル。**一つ一つのファイルは並べない。**
  // 数百並べると、コマンドがその中に沈む。ファイルはファイルのパネルで開く。
  add('作業場を選ぶ', '直したいコードのあるフォルダ', () => pickWorkRoot());

  // モデル
  const cfg = await json('/api/config');
  const now = cfg?.active?.model ?? cfg?.model;
  for (const g of cfg?.gguf ?? []) {
    if (g.ref === now || g.notGguf) continue;
    add(`モデルを切り替える: ${g.ref}`, g.tooBig ? '（この機械には載りません）' : sizeText(g.sizeBytes), async () => {
      const r = await ask('/api/config', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: cfg.kind, modelsDir: cfg.modelsDir ?? '', model: g.ref }),
      }, '切り替えられませんでした');
      if (!r) return;
      if (!r.ok) return void showCrash('切り替えられません', r.body.error ?? '', 'warn');
      showCrash('モデル', r.body.restartNeeded ? `${g.ref} を使います。いまは作業中なので、終わってから立ち上げ直すと効きます。` : `${g.ref} を使います。次の送信で読みます。`, 'warn');
      void refreshState();
    });
  }
  add('モデルを取ってくる・選ぶ', '設定 → モデル', () => openSettings('model'));

  // 診断（点検のパネルの押しボタンと同じものを押す。出力はそのパネルに出る）
  const tasks = await json('/api/tasks');
  for (const t of tasks?.tasks ?? []) {
    add(`診断: ${t.name}`, '', async () => {
      const shown = new Set(panelsInUse(layout.root));
      if (!layout.panels.some((p) => p.kind === 'checks' && shown.has(p.id))) await apply(openPanel(layout, 'checks'));
      // タブの中にあるときは、その見出しを押して表に出す（表に出ていない中身は画面に無い）。
      const tab = [...document.querySelectorAll('.panel.tabs > header > button')].find((b) => b.childNodes[0]?.textContent === '診断');
      if (tab) tab.click();
      const btn = [...document.querySelectorAll('.panel button')].find((b) => b.textContent === t.name);
      if (btn) btn.click(); else showCrash('診断', '押す場所が見つかりませんでした。診断のパネルから押してください。', 'warn');
    });
  }

  // 設定は設定で。**コマンドの一覧に、設定の項目を混ぜない。**
  // 見た目や配置の選択肢を並べたら、コマンドが埋もれて探せなくなった。
  add('設定を開く', '', () => openSettings());
  add('サポート用レポートを作る', '困ったときに送る一つのファイル', async () => { await openSettings('info'); $('makeReport').click(); });
  add('更新を確認する', '', () => checkForUpdate());
  return list;
}

async function openPalette() {
  const dlg = $('palette');
  const input = $('paletteInput');
  const listBox = $('paletteList');
  const all = await commands();
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
    else if (isPlainEnter(e)) { e.preventDefault(); const c = shown[cursor]; dlg.close(); c?.run(); }
  };
  $('paletteClose').onclick = () => dlg.close();
  draw();
  dlg.showModal();
  input.focus();
}

// コマンドは入力欄の中に置いた（書く手の隣）。板の並びからは外した。
window.aasOpenPalette = openPalette;

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
  productRoot: 'プログラム', home: '保存先（ルート）', stateDir: '記録の保存先',
  modelsDir: 'モデル', binDir: '実行ファイル', url: '画面',
  runtime: 'ランタイム', model: 'いまのモデル', mcp: '外部ツール（MCP）',
};

async function loadInfo() {
  const info = await getJson('/api/info').catch(() => null);
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
    // 道は、開ける・コピーできる形で出す。読めるだけでは、打ち直すしかない。
    if (INFO_PATH_KEYS.has(key) && typeof info[key] === 'string') v.append(pathActions(info[key]));
    row.append(k, v);
    box.append(row);
  }
}

/** 情報のうち、道であるもの。 */
const INFO_PATH_KEYS = new Set(['productRoot', 'home', 'stateDir', 'modelsDir', 'binDir']);

/** 置き場の符丁を、人の言葉へ引き直す。基幹には符丁のまま置く。 */
const DIR_NOTES = {
  OK: '',
  MISSING: 'そのフォルダはまだありません。作ってから .gguf を入れてください。',
  NOT_A_DIR: 'それはフォルダではなくファイルです。フォルダを指してください。',
  UNREADABLE: 'そのフォルダは読めませんでした（権限か、繋がっていないドライブ）。',
  // 読むのに時間がかかって、待つのをやめた。空だと言い切らない。
  SLOW: 'そのフォルダを読むのに時間がかかっています（繋がっていないドライブか、'
    + '必要になるまで実体を持たない置き方かもしれません）。「読み直す」で、もう一度見に行きます。',
};

/** いまの設定を読み出して、画面へ映す。 */
async function loadCfg() {
  // 返ってくるまでの間、空欄のまま黙らない。**読んでいることを出す。**
  $('cfgNote').style.whiteSpace = 'pre-line';
  $('cfgNote').textContent = '読んでいます…';
  // **返らない口で、黙って待ち続けない。**繋がっていないドライブを読みに
  // 行くと、応答そのものが返らないことがある。上限で切って、理由を出す。
  const c = await getJson('/api/config', { signal: AbortSignal.timeout(15000) }).catch((e) => ({ failed: String(e.message ?? e) }));
  // **黙って空欄にしない。**選択肢が一つも無い画面を出されても、
  // 利用者には何が起きたのか分からない（実際にそう出た）。
  // 読めなかったときは保存させない。見えている保存先は空欄（読めていない）なので、押すと決めてある保存先を消す
  $('cfgSave').disabled = Boolean(!c || c.failed || c.error);
  if (!c || c.failed || c.error) {
    $('cfgNote').style.whiteSpace = 'pre-line';
    $('cfgNote').textContent = `設定を読めませんでした。\n${c?.failed ?? c?.error ?? '理由が取れませんでした'}\n`
      + '「点検」を開くと、どこで止まっているかが出ます。';
    if (!c?.kinds?.length) {
      /*
       * **空の選択肢を出したまま帰らない。**
       *
       * ここは黙って return していたので、動かし方の欄が空のまま残った。
       * 空の select は「選べるものが無い」のか「読めていない」のかが
       * 見分けられない。読めていないことを、その欄自体に出す。
       */
      const sel0 = $('cfgKind');
      sel0.replaceChildren(Object.assign(document.createElement('option'),
        { value: '', textContent: '（読めませんでした。「読み直す」を押してください）' }));
      return;
    }
  }
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
  // 作業場は横の板で決める（設定の奥では誰も辿り着けなかった）。
  // 保存してあるものと、いま動いているものは別。黙って同じ顔をさせない。
  // 立ち上げ直しが要るときだけ、そのボタンを出す。要らないのに出すと押される。
  $('cfgRestart').hidden = !c.restartNeeded;
  const dirNote = DIR_NOTES[c.dirState] ?? '';
  {
    const note = $('cfgNote');
    note.replaceChildren(document.createTextNode(c.restartNeeded
      ? `保存済み。いま動いているのは「${c.active?.kind ?? '?'}」です。立ち上げ直すと切り替わります。`
      : `設定ファイル: ${c.path}`));
    // 道の隣に「開く」「コピー」。道の直後に置く（注意書きの後ろだと、何の道か分からない）。
    if (!c.restartNeeded && c.path) note.append(pathActions(c.path));
    if (dirNote) note.append(document.createTextNode(`\n${dirNote}`));
    note.style.whiteSpace = 'pre-line';
  }

  const box = $('cfgGguf');
  box.replaceChildren();
  if (!c.gguf?.length) {
    const e = document.createElement('div');
    e.className = 'empty';
    /*
     * ここで止まる人がいちばん多い。**次に何をすればいいかまで書く。**
     *
     * **同じ案内を二度出さない。**フォルダの様子（「そのフォルダはまだありません」）は
     * すぐ上の一行に出ている。ここにも足していたので、同じ文が 60px 離れて二度
     * 並んでいた（撮って見つけた）。二度言われると、別のことかと読み直す。
     */
    e.classList.add('guide');
    e.textContent = 'ありません。上のフォルダに .gguf を1つ入れると、ここに出ます。\n'
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
    // モデルの道。どこに在るかを、開いて・コピーして確かめられる。
    if (m.path) k.append(pathActions(m.path));
    const v = document.createElement('span');
    v.className = 'dim mono';
    v.textContent = sizeText(m.sizeBytes)
      + (m.tooBig ? '　⚠ この機械の記憶に載りません' : '')
      + (m.notGguf ? '　⚠ GGUF ではありません（中身が別物）' : '');
    // どれを使うかを、ここで決められる。決めなければ最初の一つ。
    const use = document.createElement('button');
    use.type = 'button';
    use.className = 'ghost';
    // 「いまこれ」は、保存したものではなく**いま使っているもの**。
    const chosen = (c.active?.model ?? c.model) === m.ref;
    use.textContent = chosen ? '使う（いまこれ）' : 'これを使う';
    use.disabled = chosen;
    use.onclick = async () => {
      const r = await ask('/api/config', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: $('cfgKind').value, modelsDir: $('cfgModelsDir').value.trim(), model: m.ref }),
      }, '保存できませんでした');
      if (!r) return;
      const body = r.body;
      // 一覧を読み直してから言う。先に言うと、読み直しが知らせを上書きする。
      await loadCfg();
      void refreshState();
      $('cfgNote').textContent = r.ok
        ? (body.restartNeeded ? `${m.ref} を使います。いまは作業中なので、終わってから立ち上げ直すと効きます。` : `${m.ref} を使います。次の送信で読みます。`)
        : (body.error ?? '保存できませんでした');
    };
    row.append(k, v, use);
    box.append(row);
  }
}

/** 取ってこられるものを並べる。一覧は必ず古くなるので、名前も直に打てる。 */
async function loadCatalog() {
  const d = await getJson('/api/models').catch(() => null);
  const sel = $('cfgCatalog');
  sel.replaceChildren();
  for (const m of d?.catalog ?? []) {
    const o = document.createElement('option');
    o.value = m.ref ?? m.id;
    o.textContent = `${m.id}（約${m.approxGB}GB・${m.note}）`;
    sel.append(o);
  }
  if (sel.children.length === 0) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = '一覧を取れませんでした';
    sel.append(o);
  }
}

/** 取ってくる。名前でも URL でも、一覧からでも、同じ道を通す。 */
async function getModel(id) {
  if (!id) { $('cfgGetNote').textContent = '取ってくる先がありません。'; return; }
  const r = await ask('/api/models/get', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  }, '取ってこられませんでした');
  if (!r) return;
  const body = r.body;
  // 数GBかかる。**終わるまで待たせない**ので、どこを見ればいいかを言う。
  $('cfgGetNote').style.whiteSpace = 'pre-line';
  $('cfgGetNote').textContent = r.ok
    ? `取ってきています: ${id}\n進み具合はここと「実行中のタスク」に出ます。`
    : (body.error ?? '始められませんでした');
}

/**
 * 裏の仕事の最新を、押した場所に出す。
 *
 * 取得の進み具合は記録に 1.5 秒ごとに流れるだけで、押した設定の頁は「流れの板を
 * 見てください」の固定文のままだった。最新の一言を、押した所と「まだ話せません」の
 * 押しボタンに出す。仕事が終わったら、次に押すもの（読み直す）を言う。
 */
function noteJobs(jobs) {
  const fetching = (jobs ?? []).find((j) => j.kind === 'fetch');
  if (!fetching) return;
  const note = $('cfgGetNote');
  if (note) {
    note.style.whiteSpace = 'pre-line';
    note.className = `repairs${fetching.state === 'failed' ? ' bad' : ''}`;
    note.textContent = fetching.state === 'running'
      ? `取ってきています: ${fetching.id}\n${fetching.detail}`
      : fetching.state === 'done'
        ? `${fetching.detail}\n「読み直す」を押すと一覧に出ます。`
        : fetching.detail;
  }
  const btn = crashNotes().map((b) => b.querySelector('.crash-action')).find(Boolean);
  if (btn && fetching.state === 'running') btn.textContent = `取ってきています… ${fetching.detail}`;
}

$('cfgGet').onclick = () => { void getModel($('cfgCatalog').value); };
$('cfgGetRepo').onclick = () => { void getModel($('cfgRepo').value.trim()); };

$('cfgReload').onclick = () => { void loadCfg(); };
/** 止めて、起き上がるまで待って、読み直す。設定の後と更新の後、どちらからも呼ぶ。 */
async function restartAndReload(note) {
  note.style.whiteSpace = 'pre-line';
  const r = await ask('/api/restart', { method: 'POST' }, '立ち上げ直せませんでした');
  if (!r) { note.textContent = '立ち上げ直せませんでした'; return; }
  const body = r.body;
  if (!r.ok) { note.textContent = body.error ?? '立ち上げ直せませんでした'; return; }
  if (!body.relaunches) {
    // 入口が起こし直してくれない（npm run ui など）。閉じることだけ伝える。
    note.textContent = '止めました。この画面を閉じて、もう一度 start.cmd から開いてください。';
    return;
  }
  note.textContent = '立ち上げ直しています。戻ってきたら、この頁を読み直します。';
  /*
   * 止まって、起き上がるまで待つ。読み直すのは、新しい本体が答えたとき（番号が変わったか、一度落ちてから戻ったとき）だけ。
   * 前は 2.5 秒待って答えがあれば読み直していたが、古い本体は後片づけ（書き出し・モデルを降ろす）に 2 秒を超えることがあり、
   * 止まる途中の古い本体から読み直して「接続できません」や空の画面になった
   */
  const before = await getJson('/api/info', { cache: 'no-store' }).then((j) => j.pid).catch(() => undefined);
  let wentDown = false;
  for (let i = 0; i < 90; i++) {
    await new Promise((res) => setTimeout(res, 1000));
    const info = await getJson('/api/info', { cache: 'no-store' }).catch(() => undefined);
    if (!info) { wentDown = true; continue; }
    if (wentDown || (before !== undefined && info.pid !== undefined && info.pid !== before)) { location.reload(); return; }
  }
  note.textContent = '1分半待ちましたが戻ってきません。start.cmd の窓を見てください。';
}

$('cfgRestart').onclick = () => restartAndReload($('cfgNote'));
$('cfgSave').onclick = async () => {
  const r = await ask('/api/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      kind: $('cfgKind').value,
      modelsDir: $('cfgModelsDir').value.trim(),
    }),
  }, '保存できませんでした');
  if (!r) { $('cfgNote').textContent = '保存できませんでした'; return; }
  const body = r.body;
  if (!r.ok) { $('cfgNote').textContent = body.error ?? '保存できませんでした'; return; }
  // 黙って効いた顔をしない。切り替えは立ち上げ直すまで効かない。
  // 置き場が無いまま保存できてしまう。保存できたことと、動くことは別。
  const saveNote = DIR_NOTES[body.dirState] ?? '';
  // 先に読み直す。読み直しは同じ欄を書き換えるので、後に回すと保存の知らせ（打ち間違いの注意・立ち上げ直しの案内）が消えた
  await loadCfg();
  $('cfgNote').style.whiteSpace = 'pre-line';
  $('cfgNote').textContent = (body.restartNeeded
    ? `保存しました。立ち上げ直すと効きます。 ${body.path}`
    : `保存しました。${body.path}`)
    + (saveNote ? `\n${saveNote}` : '')
    // 打ち間違えても保存はできる。**保存したときに言う。**
    + (body.workNote ? `\n${body.workNote}` : '');
  await loadFiles();
};

let checksReady = false;
async function loadChecks() {
  if (checksReady) return;
  checksReady = true;
  const bar = $('settingsChecks');
  const out = $('settingsCheckOut');
  let tasks;
  try {
    ({ tasks } = await getJson('/api/tasks'));
  } catch {
    // 読めなければ、次に開いたときにもう一度読む（前は「読んだ」扱いのまま空にし、以後ボタンが出なかった）
    checksReady = false;
    return;
  }
  const buttons = [];
  for (const t of tasks ?? []) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = t.name;
    b.onclick = async () => {
      out.textContent = '';
      for (const x of buttons) x.disabled = true;
      const r = await ask('/api/task', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: t.id }),
      }, '始められませんでした');
      if (!r || !r.ok) {
        for (const x of buttons) x.disabled = false;
        out.textContent = r?.body?.error ?? '始められませんでした';
      }
    };
    buttons.push(b);
    bar.append(b);
  }
  onLasting('task', (e) => {
    out.append(document.createTextNode(e.text));
    out.scrollTop = out.scrollHeight;
  });
  onLasting('taskDone', (e) => {
    for (const x of buttons) x.disabled = false;
    out.append(document.createTextNode(
      e.code === 0 ? '\n— 終わりました —\n' : `\n— 終了コード ${e.code} —\n`));
    out.scrollTop = out.scrollHeight;
  });
}

/*
 * **開いてから埋める。埋まるのを待って開かない。**
 *
 * ここは読み終えてから設定を出していた。一つでも返ってこないと、
 * **設定は出るのに中身が全部空になる**（動かし方の一覧まで空になり、
 * 何も選べない。実際にそう出た）。しかも順に待つので、前のものが
 * 返らなければ後のものは読みに行きもしない。
 *
 * 出すのが先。中身は別々に、返ったものから埋める。
 */
function fillSection(name) {
  if (name === 'check') return void loadChecks();
  if (name === 'info') { void loadInfo(); void showReport(); return; }
  if (name === 'model') { void loadCfg(); void loadCatalog(); return; }
  if (name === 'mcp') { void loadMcpCatalog(); void loadMcp(); void loadAcks(); }
}

/**
 * この作業場で了解した警告。
 *
 * **閉じたら開けない、を作らない。**会話で「了解」を押した警告は、ここで「また出す」に戻せる。
 * 記憶は本体（`/api/acks`）にあり、CLI の `/ack` と同じもの。
 */
async function loadAcks() {
  const box = $('ackRows');
  // 続けて呼ばれたら、後の呼び出しだけが描く（先の結果が後から届いて二重に並ぶのを防ぐ）。
  const seq = (loadAcks.seq = (loadAcks.seq ?? 0) + 1);
  const mine = () => loadAcks.seq === seq;
  box.replaceChildren();
  const empty = (text) => Object.assign(document.createElement('div'), { className: 'empty', textContent: text });
  let d;
  try {
    const r = await fetch('/api/acks');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    d = await r.json();
  } catch (e) {
    // 読めなかったのに「ありません」と言わない。
    if (mine()) box.append(empty(`了解した警告を読めませんでした: ${e.message ?? e}`));
    return;
  }
  if (!mine()) return;
  if (!d.acks?.length) {
    box.append(empty('この作業場で了解した警告はありません。'));
    return;
  }
  for (const a of d.acks) {
    const row = document.createElement('div');
    row.className = 'row';
    const k = document.createElement('span');
    k.className = 'dim';
    k.textContent = a.text;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ghost';
    b.textContent = 'また出す';
    b.onclick = async () => {
      b.disabled = true;
      try {
        const r = await fetch('/api/acks', {
          method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: a.id }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        await loadAcks();
      } catch (e) {
        b.disabled = false;
        b.textContent = `また出すに戻せませんでした（${e.message ?? e}）。もう一度押してください`;
      }
    };
    row.append(k, b);
    box.append(row);
  }
}

/* ---------- サポート用レポート ----------
 *
 * 押した所に結果を出す。出来るまで 1〜2 分かかるので、本体の合図（report）と
 * 取りに行く（GET /api/report）の両方で追う。合図を取りこぼしても止まらない。
 */
async function showReport() {
  const r = await getJson('/api/report').catch(() => null);
  const rep = r?.report;
  const status = $('reportStatus');
  const path = $('reportPath');
  $('makeReport').disabled = rep?.state === 'running';
  if (!rep) { status.textContent = ''; path.hidden = true; return; }
  status.textContent = rep.message;
  status.className = rep.state === 'failed' ? 'bad' : rep.state === 'done' ? 'good' : 'dim';
  path.hidden = rep.state !== 'done';
  if (rep.state === 'done') { path.textContent = rep.path; path.append(pathActions(rep.path)); }
  return rep.state;
}

let reportWatch = null;
async function makeReport() {
  const r = await ask('/api/report', { method: 'POST' }, 'まとめを始められませんでした');
  if (!r) return;
  if (!r.ok) return void showCrash('サポート用レポート', r.body.error ?? '', 'warn');
  await showReport();
  clearInterval(reportWatch);
  reportWatch = setInterval(async () => {
    const state = await showReport();
    if (state !== 'running') clearInterval(reportWatch);
  }, 2000);
}
$('makeReport').onclick = () => void makeReport();

async function openSettings(section = 'info') {
  showSection(section);
  $('settings').showModal();
  fillSection(section);
}

for (const b of $('settings').querySelectorAll('.tabs-lite button')) {
  b.onclick = () => {
    showSection(b.dataset.sec);
    fillSection(b.dataset.sec);
  };
}
$('openSettings').onclick = () => { void openSettings(); };

window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); void openPalette(); }
  else if ((e.ctrlKey || e.metaKey) && e.key === '/') { e.preventDefault(); ctx.focusInput(); }
  else if ((e.ctrlKey || e.metaKey) && e.key === ',') { e.preventDefault(); void openSettings(); }
});

await loadTheme();
await load();
await refreshState();
await loadFiles();
await loadConversations();
await loadUnfinished();
await loadUndo();
$('pickWork').onclick = () => { void pickWorkRoot(); };

/**
 * 横の一覧から作る。**いま見ている場所の中に**作る（別の場所に作られると探すことになる）。
 * ファイルは空で作って、そのままエディタで開く。作り直しは戻り先（↶）から。
 */
async function makeEntry(kind) {
  const where = filesAt ? `${filesAt}/` : '';
  const name = window.prompt(kind === 'dir'
    ? `作るフォルダの名前（${where || '作業場'} の中に作ります）`
    : `作るファイルの名前（${where || '作業場'} の中に作ります）`);
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  const path = `${where}${trimmed}`;
  let r = await ask('/api/files/new', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, kind }),
  }, '作れませんでした');
  if (!r) return;
  // 守っているファイル（.env など）は、確かめてから作る
  const mustConfirm = !r.ok && r.status === 409 && r.body.confirm && r.body.protected;
  if (!r.ok && !mustConfirm) { alert(r.body.error ?? '作れませんでした'); return; }
  if (mustConfirm) {
    if (!confirm(r.body.error)) return;
    r = await ask('/api/files/new', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, kind, confirmProtected: true }),
    }, '作れませんでした');
    if (!r) return;
    if (!r.ok) { alert(r.body.error ?? '作れませんでした'); return; }
  }
  await loadFiles(filesAt);
  // 本体が作った名前で開く（`\` を区切りに直して作るので、打った綴りのままでは見つからない）
  if (kind === 'file') await openInEditor(r.body.created ?? path);
}
$('newFile').onclick = () => { void makeEntry('file'); };
$('newDir').onclick = () => { void makeEntry('dir'); };
// 開き直したときは、続きの会話をそのまま出す。空の画面から始めない。
if (conversations.current) {
  try {
    const body = await getJson(`/api/conversations/messages?id=${encodeURIComponent(conversations.current)}`);
    if (body.messages?.length || body.inFlight) ctx.showHistory(body.messages ?? []);
    // 動いている最中に開き直しても、途中までは見える。
    if (body.inFlight) {
      copiedUpTo.set(conversations.current, body.inFlight.seq);
      ctx.showInFlight(body.inFlight);
      showBusyOfViewed(true);
    }
  } catch { /* 出せなくても、新しく書き始められる */ }
}
// 開いた時点で待っている承認。見ている会話によらず出す（出さないと押す口が無い）
void showWaitingApprovals();
/*
 * **開いた時点で、使える状態かを言う。**
 *
 * モデルが無い機械では、書いて、送って、はじめて「まだ使えません」と
 * 返っていた。開いた人からは、何をすればいいのか分からないまま
 * 送る手間だけが無駄になる。開いた時点で、次に打つ一手まで出す。
 */
async function tellIfNotReady() {
  const r = await getJson('/api/ready', { signal: AbortSignal.timeout(20000) })
    .catch((e) => ({ ready: false, why: `見に行けませんでした（${e.message ?? e}）` }));
  /*
   * **設定が読めていないことを、一緒に言う。**
   *
   * 読めなければ既定で開く作りだが、理由は端末にしか出ていなかった。
   * `start.cmd` から起こすとその端末は隠れるので、開いた人は気づけない
   * （書いたはずの繋ぎ先が使われていない、が黙って起きる）。
   *
   * **帯は一本しかない。**別々に出すと、後から出した方が前のを消す
   * （実際、モデルが無い帯に消されて何も見えなかった）。文の側で足す。
   */
  const configNote = r.configProblem
    ? `設定を読めませんでした（既定のまま開いています）: ${r.configProblem}\n`
    : '';
  if (r.ready) {
    // 話せるようになったなら、「まだ話せません」は下げる（取ってき終わったとき）。
    dropCrashNote('まだ話せません');
    // 話せるが、待たされそうなら先に言う（GPU なしで大きいモデルのとき）。
    if (configNote) showCrash('設定', configNote.trim(), 'warn');
    else if (r.heads) showCrash('先に一つ', r.heads, 'warn');
    return;
  }
  /*
   * **初めて開いた人が、その場で使い始められるようにする。**
   *
   * 既定は「この中で読む」で、GGUF が無ければ話せない。本体が「最初の一つ」を
   * 返してきたら、一押しで取ってくる。取ってきている間は進み具合が流れ、
   * 終われば話せるようになる（stateChanged で見直す）。
   */
  const f = r.canFetch;
  if (f) {
    const label = f.fetching ? `取ってきています… ${f.message || ''}`.trim() : `小さいモデル（約${f.approxGB}GB）を取ってくる`;
    // 取ってこられなかったときは、その理由をここに出す（ログを開かせない）。
    const why = configNote + (f.failed ? `${r.why}\n${f.failed}` : r.why);
    showCrash('まだ話せません', why, 'warn', {
      label,
      run: async (btn) => {
        btn.disabled = true;
        btn.textContent = '取ってきています…';
        const got = await ask('/api/models/get', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: f.id }),
        }, '取ってこられませんでした');
        if (!got || !got.ok) { btn.disabled = false; btn.textContent = got?.body?.error ?? '取ってこられませんでした'; }
      },
    });
    return;
  }
  showCrash('まだ話せません', `${configNote}${r.why}　⚙ 設定 → モデル で決められます`, 'warn');
}
void tellIfNotReady();
// 開いた時点で裏の仕事が動いていれば、その最新を押した場所に出す（合図は繋ぐ前に流れている）。
void getJson('/api/jobs').then((j) => noteJobs(j.jobs)).catch(() => undefined);

listen();
setInterval(refreshState, 5000);

$('openView').onclick = () => openViewMenu();
// 新しい会話。名前を押すのと同じ所へ行く（入口が二つあっても、行き先は一つ）。
$('newTalk').onclick = () => { void goTop(); };
// 名前を押すとトップへ。普通のチャットの作法（左上の名前が入口）に合わせる。
for (const b of document.querySelectorAll('.brand')) {
  b.title = 'トップへ（ここで書き始めると新しい会話）';
  b.onclick = () => { void goTop(); };
}
