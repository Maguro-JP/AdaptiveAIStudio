/**
 * 配置(JSON)から画面を組み立てる。
 *
 * 画面の形はここでは決めない。決めているのは配置の方。
 * ここがやるのは、配置の通りに並べることと、
 * 仕切りを掴んで動かしたら配置に書き戻すことだけ。
 */
import { PANELS, TITLES } from './panels.js';
import { closePanel, openPanel, movePanel, panelsInUse } from './layout-ops.js';
import { doingText } from './doing.js';
import { isPlainEnter } from './keys.js';
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
  /** 入力欄の先頭に文字を置く（/plan など）。チャットのパネルが繋ぐ。 */
  prefill: () => undefined,
  /** 残してあるやりとりを並べ直す。会話の板が差し替える。 */
  showHistory: () => undefined,
  /** ファイルをエディタで開く。エディタのパネルが繋ぐ。 */
  openFile: () => undefined,
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
function showCrash(what, detail, tone = 'bad') {
  let box = document.getElementById('crashNote');
  if (!box) {
    box = document.createElement('div');
    box.id = 'crashNote';
    box.className = 'crash-note';
    box.onclick = () => { box.remove(); };
    document.body.append(box);
  }
  box.className = `crash-note ${tone}`;
  box.textContent = `${what}: ${detail}（押すと消えます）`;
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
  const r = await askJson('/api/theme', undefined, '色を読めませんでした');
  if (!r) return;
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
  const r = await askJson('/api/theme/preset', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: e.target.value }),
  }, '色を変えられませんでした');
  if (!r) return;
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
      const r = await askJson('/api/theme', undefined, '色を戻せませんでした');
      if (r) applyTheme(r.theme, r.vars);
      return;
    }
    const r = await askJson('/api/theme', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...draft, base: before.id, id: 'custom', name: '自分の色' }),
    }, '色を保存できませんでした');
    if (!r) return;
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
  const r = await askJson('/api/layout', undefined, '配置を読めませんでした');
  if (!r) return;
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
  const r = await askJson('/api/layout', {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(next),
  }, '配置を保存できませんでした');
  if (!r) return undefined;
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
  try {
    // **いま動かしているものを出す。**手元に入っているモデルの一覧の
    // 先頭を出していたので、使ってもいない名前が出ていた（実際に出ていた）。
    const info = await fetch('/api/info').then((x) => x.json());
    $('sbModel').textContent = `${info.runtime} · ${info.model}`;
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

$('runStop').onclick = () => fetch('/api/abort', { method: 'POST' });


function listen() {
  const src = new EventSource('/api/events');
  const status = $('status');
  src.onopen = () => {
    status.textContent = 'つながっています';
    status.className = 'status live';
    if ($('run').dataset.state === 'down') run.set('idle', '待機中');
  };
  src.onerror = () => {
    status.textContent = '本体が止まっています';
    status.className = 'status down';
    run.set('down', '本体が止まっています');
  };
  src.onmessage = (m) => {
    const e = JSON.parse(m.data);
    if (e.type === 'busy') {
      busyNow = e.busy;
      run.set(e.busy ? 'busy' : 'idle', e.busy ? '作業中' : '待機中');
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
      if (/^読み込みました/.test(e.text) && !busyNow) run.set('idle', '待機中');
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
    if (e.type === 'stateChanged') { void refreshState(); void loadFiles(filesAt); return; }
    if (e.type === 'themeChanged') return void loadTheme();
    if (e.type === 'thinkEvent') {
      if (e.event.type === 'chose') run.set('busy', `考え中: ${e.event.codename}`);
    }
    // いま触っているものを、上の帯に出す。終わったら「作業中」へ戻す
    // （**「読んでいます」のまま止まって見えるのが、いちばん困る**）。
    if (e.type === 'session' && busyNow) {
      if (e.event.type === 'toolStart') run.set('busy', doingText(e.event.name, e.event.summary));
      if (e.event.type === 'toolEnd') run.set('busy', '作業中');
    }
    for (const fn of eventHandlers.get(e.type) ?? []) fn(e);
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
    d = await fetch('/api/mcp').then((r) => r.json());
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
    d = await fetch('/api/mcp/catalog').then((r) => r.json());
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
        '次の依頼のときから使えます。',
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
        const off1 = await ask(`/api/mcp/connect?id=${encodeURIComponent(e.id)}`,
          { method: 'DELETE' }, `${e.name} を外せませんでした`);
        if (!off1) return;
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
let busyNow = false;

/**
 * やり残しを出す。
 *
 * **見えて、やめられること。**控えるだけなら覚え書きだが、こちらから
 * 勝手に続きを始めるので、何が残っているかは常に見えていないといけない。
 */
async function loadUnfinished() {
  let data;
  try {
    data = await fetch('/api/unfinished').then((x) => x.json());
  } catch { return; }
  let goals = { list: [], stride: {} };
  try {
    goals = await fetch('/api/goals').then((x) => x.json());
  } catch { /* 段取りが読めなくても、やり残しは出す */ }

  const sec = $('unfinishedSec');
  const box = $('sideUnfinished');
  const list = data.list ?? [];
  sec.hidden = list.length === 0 && goals.list.length === 0;
  box.textContent = '';

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
      await loadUnfinished();
    });

    row.append(label, stop);
    box.append(row);
  }
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
    data = await fetch('/api/undo').then((x) => x.json());
  } catch { return; }
  const list = data.list ?? [];
  const sec = $('undoSec');
  const box = $('sideUndo');
  sec.hidden = list.length === 0;
  box.textContent = '';

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
    const when = new Date(p.at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
    label.textContent = `${when} ${p.request}`;
    label.title = `${p.request}\n触ったファイル（${p.paths.length} 件）:\n${p.paths.join('\n')}`;

    const back = document.createElement('button');
    back.className = 'ghost icon';
    back.title = i === 0
      ? `ここまで戻す（${p.paths.length} 件）`
      : `ここまで戻す（この後の ${i} 回ぶんも一緒に戻ります）`;
    back.textContent = '↶';
    back.addEventListener('click', async () => {
      const also = i === 0 ? '' : `\nこの後の ${i} 回ぶんの直しも一緒に戻ります。`;
      if (!confirm(`${p.paths.length} 件のファイルを戻します。${also}\n\n${p.paths.join('\n')}`)) return;
      back.disabled = true;
      try {
        const r = await fetch('/api/undo', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: p.id }),
        });
        if (!r.ok) alert((await r.json()).error ?? '戻せませんでした');
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
  ctx.showHistory([]);
  await loadConversations();
}

async function loadConversations() {
  try {
    conversations = await fetch('/api/conversations').then((x) => x.json());
  } catch { return; }
  drawConversations();
}

function drawConversations() {
  const box = $('sideSessions');
  box.textContent = '';

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
    open.disabled = busyNow;
    open.onclick = async () => {
      const r = await ask('/api/conversations/select', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: head.id }),
      }, '開けませんでした');
      if (!r) return;
      if (!r.ok) return void alert(r.body.error ?? '開けませんでした');
      ctx.showHistory(r.body.messages ?? []);
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
    label.disabled = busyNow;
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
      if (!confirm(`「${head.title}」を消します。戻せません。`)) return;
      const r = await ask(`/api/conversations?id=${encodeURIComponent(head.id)}`,
        { method: 'DELETE' }, '消せませんでした');
      if (!r) return;
      if (!r.ok) return void alert(r.body.error ?? '消せませんでした');
      if (head.id === conversations.current) ctx.showHistory([]);
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
  const nowAt = $('workNow').textContent ?? '';
  const want = window.prompt('直してほしいコードのある場所を打ってください。\n（空にすると既定へ戻ります）', nowAt);
  if (want === null) return;
  const r = await ask('/api/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      kind: $('cfgKind')?.value || 'inproc',
      modelsDir: $('cfgModelsDir')?.value?.trim() ?? '',
      workRoot: want.trim(),
    }),
  }, 'フォルダを変えられませんでした');
  if (!r) return;
  const body = r.body;
  if (!r.ok) { alert(body.error ?? '変えられませんでした'); return; }
  // 打ち間違えても保存はできる。**そのときは言う。**
  if (body.workNote) alert(body.workNote);
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
    const r = await fetch(`/api/files?path=${encodeURIComponent(at)}`);
    const body = await r.json();
    if (!r.ok) throw new Error(body.error ?? '読めませんでした');
    filesAt = body.path;
    $('filesHead').textContent = body.path ? `ファイル / ${body.path}` : 'ファイル';
    // **いまどこを触っているのかを、常に出す。**
    // これが見えないまま指示を書くのは、暗い所で手探りをするのと同じ。
    const now = $('workNow');
    // 長い道は**真ん中を省く**。頭（どのドライブか）と末尾（どのフォルダか）が
    // 要るので、端を切ると分からなくなる。
    const full = body.root ?? '';
    now.textContent = full.length > 34 ? `${full.slice(0, 12)}…${full.slice(-20)}` : full;
    now.title = full;
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
async function openInEditor(path) {
  const shown = new Set(panelsInUse(layout.root));
  const has = layout.panels.some((p) => p.kind === 'editor' && shown.has(p.id));
  if (!has) await apply(openPanel(layout, 'editor'));
  ctx.openFile(path);
}

function insertPath(path) {
  const input = document.querySelector('.chat textarea');
  if (!input) return;
  // **`@` を付ける。**印が付いていると、送るときに中身ごと渡る。
  // 道の文字だけだと、開かずに書き始めることがある。
  const at = `@${path}`;
  input.value = input.value ? `${input.value.replace(/\s+$/, '')} ${at} ` : `${at} `;
  input.focus();
}

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
  if (!r) return;
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
    alert(status.reason || '更新できません');
    return;
  }
  const list = status.incoming.map((c) => `  ${c}`).join('\n');
  if (!confirm(`${status.behind}件の変更があります。\n\n${list}\n\n取り込みますか？`)) return;

  const r = await ask('/api/update', { method: 'POST' }, '更新できませんでした');
  if (!r) return;
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
 */
function commands() {
  const list = [
    { name: '入力へ移動', hint: 'Ctrl+/', run: () => ctx.focusInput() },
    { name: '分解して進める', hint: '/plan を先頭に付けて送る', run: () => ctx.prefill('/plan ') },
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
    else if (isPlainEnter(e)) { e.preventDefault(); const c = shown[cursor]; dlg.close(); c?.run(); }
  };
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
  const c = await fetch('/api/config', { signal: AbortSignal.timeout(15000) }).then((r) => r.json()).catch((e) => ({ failed: String(e.message ?? e) }));
  // **黙って空欄にしない。**選択肢が一つも無い画面を出されても、
  // 利用者には何が起きたのか分からない（実際にそう出た）。
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
  $('cfgNote').textContent = (c.restartNeeded
    ? `保存済み。いま動いているのは「${c.active?.kind ?? '?'}」です。立ち上げ直すと切り替わります。`
    : `設定ファイル: ${c.path}`) + (dirNote ? `\n${dirNote}` : '');
  $('cfgNote').style.whiteSpace = 'pre-line';

  const box = $('cfgGguf');
  box.replaceChildren();
  if (!c.gguf?.length) {
    const e = document.createElement('div');
    e.className = 'empty';
    // ここで止まる人がいちばん多い。**次に何をすればいいかまで書く。**
    e.textContent = (DIR_NOTES[c.dirState] ? `${DIR_NOTES[c.dirState]}\n` : '')
      + 'ありません。上のフォルダに .gguf を1つ入れると、ここに出ます。\n'
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
    v.textContent = (m.sizeBytes ? `${(m.sizeBytes / 1024 ** 3).toFixed(1)} GB` : '')
      + (m.tooBig ? '　⚠ この機械の記憶に載りません' : '')
      + (m.notGguf ? '　⚠ GGUF ではありません（中身が別物）' : '');
    // どれを使うかを、ここで決められる。決めなければ最初の一つ。
    const use = document.createElement('button');
    use.type = 'button';
    use.className = 'ghost';
    const chosen = c.model === m.ref;
    use.textContent = chosen ? '使う（いまこれ）' : 'これを使う';
    use.disabled = chosen;
    use.onclick = async () => {
      const r = await ask('/api/config', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: $('cfgKind').value, modelsDir: $('cfgModelsDir').value.trim(), model: m.ref }),
      }, '保存できませんでした');
      if (!r) return;
      const body = r.body;
      $('cfgNote').textContent = r.ok
        ? (body.restartNeeded ? `${m.ref} を使います。立ち上げ直すと効きます。` : `${m.ref} を使います。`)
        : (body.error ?? '保存できませんでした');
      await loadCfg();
    };
    row.append(k, v, use);
    box.append(row);
  }
}

/** 取ってこられるものを並べる。一覧は必ず古くなるので、名前も直に打てる。 */
async function loadCatalog() {
  const d = await fetch('/api/models').then((r) => r.json()).catch(() => null);
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
    ? `取ってきています: ${id}\n進み具合は「流れ」の板に出ます。終わったら「読み直す」を押してください。`
    : (body.error ?? '始められませんでした');
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
  // 止まって、起き上がるまで待つ。起きたら読み直す。
  await new Promise((res) => setTimeout(res, 1500));
  for (let i = 0; i < 60; i++) {
    await new Promise((res) => setTimeout(res, 1000));
    const ok = await fetch('/api/info', { cache: 'no-store' }).then((x) => x.ok).catch(() => false);
    if (ok) { location.reload(); return; }
  }
  note.textContent = '1分待ちましたが戻ってきません。start.cmd の窓を見てください。';
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
  $('cfgNote').style.whiteSpace = 'pre-line';
  $('cfgNote').textContent = (body.restartNeeded
    ? `保存しました。立ち上げ直すと効きます。 ${body.path}`
    : `保存しました。${body.path}`)
    + (saveNote ? `\n${saveNote}` : '')
    // 打ち間違えても保存はできる。**保存したときに言う。**
    + (body.workNote ? `\n${body.workNote}` : '');
  await loadCfg();
  await loadFiles();
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
  if (name === 'info') return void loadInfo();
  if (name === 'model') { void loadCfg(); void loadCatalog(); return; }
  if (name === 'mcp') { void loadMcpCatalog(); void loadMcp(); }
}

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
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); openPalette(); }
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
// 開き直したときは、続きの会話をそのまま出す。空の画面から始めない。
if (conversations.current) {
  try {
    const body = await fetch(`/api/conversations/messages?id=${encodeURIComponent(conversations.current)}`)
      .then((x) => x.json());
    if (body.messages?.length) ctx.showHistory(body.messages);
  } catch { /* 出せなくても、新しく書き始められる */ }
}
/*
 * **開いた時点で、使える状態かを言う。**
 *
 * モデルが無い機械では、書いて、送って、はじめて「まだ使えません」と
 * 返っていた。開いた人からは、何をすればいいのか分からないまま
 * 送る手間だけが無駄になる。開いた時点で、次に打つ一手まで出す。
 */
async function tellIfNotReady() {
  const r = await fetch('/api/ready', { signal: AbortSignal.timeout(20000) })
    .then((x) => x.json())
    .catch((e) => ({ ready: false, why: `見に行けませんでした（${e.message ?? e}）` }));
  if (r.ready) {
    // 話せるが、待たされそうなら先に言う（GPU なしで大きいモデルのとき）。
    if (r.heads) showCrash('先に一つ', r.heads, 'warn');
    return;
  }
  showCrash('まだ話せません', `${r.why}　⚙ 設定 → モデル で決められます`, 'warn');
}
void tellIfNotReady();

listen();
setInterval(refreshState, 5000);

$('openView').onclick = () => openViewMenu();
// 名前を押すとトップへ。普通のチャットの作法（左上の名前が入口）に合わせる。
for (const b of document.querySelectorAll('.brand')) {
  b.title = 'トップへ（ここで書き始めると新しい会話）';
  b.onclick = () => { void goTop(); };
}
