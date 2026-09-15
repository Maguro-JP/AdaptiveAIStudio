/**
 * 配置をいじる操作。
 *
 * 配置はデータで持っているのに、画面から触れるのは**型を選ぶ**のと
 * **JSON を直に打つ**の二つだけだった。人は JSON で窓を並べない。
 *
 * ここに置くのは、木を組み替える計算だけ（画面には触らない）。
 * 掴んで動かす方は `app.js` が持つ。分けてあるので、この計算は
 * 画面が無くても試せる（`test/layout-ops.test.ts`）。
 *
 * **決して空の画面を返さない。**全部閉じたら、会話だけの形へ戻す。
 * 真っ白な画面から復帰する道は、利用者には無い。
 */

/** 木の中で使われている板の名前。 */
export function panelsInUse(node, out = []) {
  if (!node) return out;
  if (node.type === 'panel') out.push(node.panel);
  else if (node.type === 'tabs') out.push(...node.panels);
  else if (node.type === 'split') for (const c of node.children ?? []) panelsInUse(c, out);
  return out;
}

const clone = (x) => JSON.parse(JSON.stringify(x));

/** 均等に割り直す。合計は必ず 1。 */
function evenly(n) {
  return Array.from({ length: n }, () => 1 / n);
}

/**
 * 木から一つ外す。空いた入れ物は畳む。
 * 外した結果、何も無くなったら `null` を返す（呼ぶ側が受け皿を用意する）。
 */
function pluck(node, id) {
  if (!node) return null;
  if (node.type === 'panel') return node.panel === id ? null : node;
  if (node.type === 'tabs') {
    const left = node.panels.filter((p) => p !== id);
    if (left.length === 0) return null;
    if (left.length === 1) return { type: 'panel', panel: left[0] };
    const active = Math.min(node.active ?? 0, left.length - 1);
    return { type: 'tabs', panels: left, active };
  }
  const kids = [];
  const sizes = [];
  (node.children ?? []).forEach((c, i) => {
    const kept = pluck(c, id);
    if (!kept) return;
    kids.push(kept);
    sizes.push(node.sizes?.[i] ?? 0);
  });
  if (kids.length === 0) return null;
  if (kids.length === 1) return kids[0];
  const total = sizes.reduce((a, b) => a + b, 0);
  return {
    type: 'split', direction: node.direction,
    sizes: total > 0 ? sizes.map((s) => s / total) : evenly(kids.length),
    children: kids,
  };
}

/** 木の中の一つを、別のものに差し替える。 */
function swap(node, id, made) {
  if (!node) return node;
  if (node.type === 'panel') return node.panel === id ? made : node;
  if (node.type === 'tabs') return node.panels.includes(id) ? made : node;
  if (node.type === 'split') {
    return { ...node, children: node.children.map((c) => swap(c, id, made)) };
  }
  return node;
}

/** その板を抱えている入れ物（板そのもの、または束ねている tabs）。 */
function holderOf(node, id) {
  if (!node) return undefined;
  if (node.type === 'panel') return node.panel === id ? node : undefined;
  if (node.type === 'tabs') return node.panels.includes(id) ? node : undefined;
  for (const c of node.children ?? []) {
    const got = holderOf(c, id);
    if (got) return got;
  }
  return undefined;
}

/** 使われていない名前を作る。 */
function freshId(layout, kind) {
  const taken = new Set(layout.panels.map((p) => p.id));
  if (!taken.has(kind)) return kind;
  for (let i = 2; ; i += 1) if (!taken.has(`${kind}${i}`)) return `${kind}${i}`;
}

/** 何も無くなったときの受け皿。**真っ白を返さない。** */
function fallback(layout) {
  const chat = layout.panels.find((p) => p.kind === 'conversation');
  if (chat) return { root: { type: 'panel', panel: chat.id }, panels: layout.panels };
  const spec = { id: 'chat', kind: 'conversation' };
  return { root: { type: 'panel', panel: spec.id }, panels: [...layout.panels, spec] };
}

/** 閉じる。使われなくなった板の控えも落とす。 */
export function closePanel(layout, id) {
  const next = clone(layout);
  const root = pluck(next.root, id);
  if (!root) {
    const back = fallback({ ...next, panels: next.panels.filter((p) => p.id !== id) });
    return { ...next, root: back.root, panels: back.panels };
  }
  const used = new Set(panelsInUse(root));
  return { ...next, root, panels: next.panels.filter((p) => used.has(p.id)) };
}

/**
 * 出す。
 *
 * 束ねてあるところがあれば、そこへ足す（画面がこれ以上細かく割れない）。
 * 無ければ右に 3 割で割って出す。**出したものが見えないのが、いちばん困る。**
 */
export function openPanel(layout, kind, title) {
  const next = clone(layout);
  const id = freshId(next, kind);
  next.panels.push({ id, kind, ...(title ? { title } : {}) });

  const tabs = findTabs(next.root);
  if (tabs) {
    tabs.panels.push(id);
    tabs.active = tabs.panels.length - 1;
    return next;
  }
  next.root = {
    type: 'split', direction: 'row', sizes: [0.7, 0.3],
    children: [next.root, { type: 'panel', panel: id }],
  };
  return next;
}

function findTabs(node) {
  if (!node) return undefined;
  if (node.type === 'tabs') return node;
  for (const c of node.children ?? []) {
    const got = findTabs(c);
    if (got) return got;
  }
  return undefined;
}

/** 置ける向き。 */
export const DROPS = ['left', 'right', 'top', 'bottom', 'tab'];

/**
 * 動かす。`where` は落とした先から見た向き。
 *
 * 自分自身の上に落としたときは何もしない（消えたように見えるため）。
 */
export function movePanel(layout, id, targetId, where) {
  if (id === targetId || !DROPS.includes(where)) return layout;
  const next = clone(layout);
  const target = holderOf(next.root, targetId);
  if (!target) return layout;
  // 束ねられている相手の中へ、その束の一枚を動かしても意味がない。
  if (target.type === 'tabs' && target.panels.includes(id) && where === 'tab') return layout;

  const pulled = pluck(next.root, id);
  if (!pulled) return layout;
  next.root = pulled;

  // 抜いたことで相手が畳まれていることがある。取り直す。
  const landing = holderOf(next.root, targetId);
  if (!landing) return layout;

  const made = where === 'tab'
    ? asTabs(landing, id)
    : {
        type: 'split',
        direction: where === 'left' || where === 'right' ? 'row' : 'column',
        sizes: [0.5, 0.5],
        children: where === 'left' || where === 'top'
          ? [{ type: 'panel', panel: id }, landing]
          : [landing, { type: 'panel', panel: id }],
      };

  next.root = swap(next.root, targetId, made);
  return next;
}

function asTabs(landing, id) {
  const list = landing.type === 'tabs' ? [...landing.panels, id] : [landing.panel, id];
  return { type: 'tabs', panels: list, active: list.length - 1 };
}
