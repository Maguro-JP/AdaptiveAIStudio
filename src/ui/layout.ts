/**
 * 画面の配置 — 見た目をコードではなくデータで持つ。
 *
 * 好みは人によって違う。会話だけ大きく出したい人もいれば、
 * 進行中の作業と記憶を常に見ていたい人もいる。
 * 作り手が一つの正解を決めてしまうと、そこで自由度が終わる。
 *
 * だから配置は JSON にする。理由は三つ。
 *
 *   1. **自分で書き換えられる**   ファイルを直せば配置が変わる
 *   2. **AIに頼んで変えられる**   AIが扱えるのは、コードよりデータ
 *   3. **壊しても戻る**           読めない配置は直して表示する。真っ白にしない
 *
 * 3 が特に効く。配置をAIに触らせる以上、壊れた配置は必ず来る。
 * そこで画面が真っ白になるなら、AIには触らせられない。
 * 「壊れても表示できる」ことが、「AIに任せられる」ことの前提になる。
 */

/** 置ける中身。増やすときはここに足す。 */
export const PANEL_KINDS = [
  'conversation',  // 会話
  'plan',          // 進行中の作業（分解された件と、その状態）
  'roster',        // 人員
  'memory',        // 記憶
  'proposals',     // 提案
  'duties',        // 日課
  'models',        // モデルと実測
  'changes',       // この対話で変わったファイルと、その差分
  'preview',       // 作っているものを、その場で見る（HTML/CSS）
  'log',           // 動いているものの流れ
  'checks',        // 点検（doctor・検査・片づけ）。cmd の窓でしかできなかったもの
  'note',          // 自由記述。壊れた配置の受け皿でもある
] as const;

export type PanelKind = typeof PANEL_KINDS[number];

export interface PanelSpec {
  id: string;
  kind: PanelKind;
  /** 省略すると種類ごとの既定名 */
  title?: string;
  options?: Record<string, unknown>;
}

/**
 * 配置の木。
 * 分割の入れ子で表すので、段組みでも三分割でも、好きな形になる。
 */
export type LayoutNode =
  | { type: 'panel'; panel: string }
  /** 同じ場所に重ねて、見出しで切り替える */
  | { type: 'tabs'; panels: string[]; active?: number }
  | { type: 'split'; direction: 'row' | 'column'; sizes: number[]; children: LayoutNode[] };

export interface Layout {
  id: string;
  name: string;
  root: LayoutNode;
  panels: PanelSpec[];
  theme?: 'dark' | 'light' | 'auto';
  density?: 'compact' | 'comfortable';
}

const panel = (id: string, kind: PanelKind, title?: string): PanelSpec => ({ id, kind, title });

/**
 * 用意しておく配置。
 * 好みが違う以上、一つでは足りない。ここから選んで、そこから直していく。
 */
export const PRESETS: Layout[] = [
  {
    id: 'focus',
    name: '集中 — 会話だけ',
    root: { type: 'panel', panel: 'chat' },
    panels: [panel('chat', 'conversation')],
    theme: 'auto',
    density: 'comfortable',
  },
  {
    id: 'command',
    name: '統制卓 — 会話と進行を並べる',
    root: {
      type: 'split', direction: 'row', sizes: [0.62, 0.38],
      children: [
        { type: 'panel', panel: 'chat' },
        {
          type: 'split', direction: 'column', sizes: [0.5, 0.5],
          children: [
            { type: 'panel', panel: 'plan' },
            { type: 'tabs', panels: ['changes', 'roster', 'memory', 'proposals', 'checks'] },
          ],
        },
      ],
    },
    panels: [
      panel('chat', 'conversation'),
      panel('plan', 'plan'),
      panel('roster', 'roster'),
      panel('memory', 'memory'),
      panel('proposals', 'proposals'),
      panel('changes', 'changes'),
      panel('checks', 'checks'),
    ],
    theme: 'auto',
    density: 'comfortable',
  },
  {
    id: 'watch',
    name: '監視 — 動いているものを全部見る',
    root: {
      type: 'split', direction: 'column', sizes: [0.55, 0.45],
      children: [
        {
          type: 'split', direction: 'row', sizes: [0.5, 0.5],
          children: [{ type: 'panel', panel: 'chat' }, { type: 'panel', panel: 'plan' }],
        },
        {
          type: 'split', direction: 'row', sizes: [0.34, 0.33, 0.33],
          children: [
            { type: 'panel', panel: 'log' },
            { type: 'panel', panel: 'models' },
            { type: 'panel', panel: 'duties' },
          ],
        },
      ],
    },
    panels: [
      panel('chat', 'conversation'),
      panel('plan', 'plan'),
      panel('log', 'log'),
      panel('models', 'models'),
      panel('duties', 'duties'),
    ],
    theme: 'auto',
    density: 'compact',
  },
];

export const DEFAULT_LAYOUT_ID = 'command';

export function preset(id: string): Layout {
  const found = PRESETS.find((p) => p.id === id) ?? PRESETS.find((p) => p.id === DEFAULT_LAYOUT_ID)!;
  // 用意した配置も、書かれた配置と同じ道を通す。
  // 特別扱いを作ると、そこだけ壊れ方が変わる。
  return repairLayout(structuredClone(found)).layout;
}

export interface LayoutRepair {
  /** 何を直したか。黙って直すと、次も同じ壊れ方をする。 */
  detail: string;
}

/**
 * 読めない配置を、表示できる配置に直す。
 *
 * ここでは決して例外を投げないし、空も返さない。
 * 配置が壊れているだけで何も見えなくなるなら、
 * 配置をAIに触らせるという前提が成り立たなくなる。
 */
export function repairLayout(raw: unknown, fallbackId = DEFAULT_LAYOUT_ID): {
  layout: Layout; repairs: LayoutRepair[];
} {
  const repairs: LayoutRepair[] = [];
  const note = (detail: string) => repairs.push({ detail });

  if (typeof raw !== 'object' || raw === null) {
    note('配置を読めなかったので、既定の配置に戻しました。');
    return { layout: preset(fallbackId), repairs };
  }
  const o = raw as Record<string, unknown>;

  // 中身の一覧を整える。ここが空だと何も置けない。
  const panels: PanelSpec[] = [];
  const seen = new Set<string>();
  for (const [i, entry] of (Array.isArray(o.panels) ? o.panels : []).entries()) {
    const e = (entry ?? {}) as Record<string, unknown>;
    const id = typeof e.id === 'string' && e.id.trim() ? e.id.trim() : `p${i + 1}`;
    if (seen.has(id)) { note(`中身の名前が重複していたので ${id} を一つにしました。`); continue; }
    seen.add(id);

    let kind = e.kind as PanelKind;
    if (!PANEL_KINDS.includes(kind)) {
      // 知らない種類でも消さない。何が置かれようとしたかを画面に出す。
      note(`知らない種類 ${String(e.kind)} は、そのままの名前で覚え書きとして出します。`);
      panels.push({
        id, kind: 'note', title: typeof e.title === 'string' ? e.title : String(e.kind),
        options: { text: `「${String(e.kind)}」という中身はまだありません。` },
      });
      continue;
    }
    // 空の項目を残さない。直した結果を読み直しても同じ形になるように。
    const spec: PanelSpec = { id, kind };
    if (typeof e.title === 'string') spec.title = e.title;
    if (typeof e.options === 'object' && e.options !== null) {
      spec.options = e.options as Record<string, unknown>;
    }
    panels.push(spec);
  }

  if (panels.length === 0) {
    note('置く中身が一つもなかったので、既定の配置に戻しました。');
    return { layout: preset(fallbackId), repairs };
  }

  const known = new Set(panels.map((p) => p.id));
  const used = new Set<string>();
  const root = repairNode(o.root, known, used, note);

  // どこにも置かれなかった中身は、最後に重ねて置く。捨てない。
  const orphans = panels.filter((p) => !used.has(p.id));
  let finalRoot = root;
  if (!finalRoot) {
    note('配置の形が読めなかったので、中身を重ねて並べました。');
    finalRoot = { type: 'tabs', panels: panels.map((p) => p.id), active: 0 };
  } else if (orphans.length > 0) {
    note(`置き場所の無い中身が ${orphans.length} 件あったので、右端に寄せました。`);
    finalRoot = {
      type: 'split', direction: 'row', sizes: [0.75, 0.25],
      children: [finalRoot, { type: 'tabs', panels: orphans.map((p) => p.id), active: 0 }],
    };
  }

  const theme = o.theme === 'dark' || o.theme === 'light' || o.theme === 'auto' ? o.theme : 'auto';
  const density = o.density === 'compact' || o.density === 'comfortable' ? o.density : 'comfortable';

  return {
    layout: {
      id: typeof o.id === 'string' && o.id.trim() ? o.id.trim() : 'custom',
      name: typeof o.name === 'string' && o.name.trim() ? o.name.trim() : '自分の配置',
      root: finalRoot,
      panels, theme, density,
    },
    repairs,
  };
}

function repairNode(
  raw: unknown,
  known: Set<string>,
  used: Set<string>,
  note: (d: string) => void,
): LayoutNode | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const n = raw as Record<string, unknown>;

  if (n.type === 'panel') {
    const id = typeof n.panel === 'string' ? n.panel : '';
    if (!known.has(id)) { note(`存在しない中身 ${id || '(名無し)'} が置かれていたので外しました。`); return undefined; }
    if (used.has(id)) { note(`${id} が二箇所に置かれていたので、後の方を外しました。`); return undefined; }
    used.add(id);
    return { type: 'panel', panel: id };
  }

  if (n.type === 'tabs') {
    const list = (Array.isArray(n.panels) ? n.panels : [])
      .filter((p): p is string => typeof p === 'string')
      .filter((p) => {
        if (!known.has(p)) { note(`存在しない中身 ${p} が重ねられていたので外しました。`); return false; }
        if (used.has(p)) { note(`${p} が二箇所に置かれていたので、後の方を外しました。`); return false; }
        used.add(p);
        return true;
      });
    if (list.length === 0) return undefined;
    const active = typeof n.active === 'number' && n.active >= 0 && n.active < list.length ? n.active : 0;
    return { type: 'tabs', panels: list, active };
  }

  if (n.type === 'split') {
    const direction = n.direction === 'row' || n.direction === 'column' ? n.direction : 'row';
    if (n.direction !== direction) note('分割の向きが読めなかったので横並びにしました。');

    const children = (Array.isArray(n.children) ? n.children : [])
      .map((c) => repairNode(c, known, used, note))
      .filter((c): c is LayoutNode => !!c);

    if (children.length === 0) return undefined;
    // 一つしか残らない分割は、分割の意味が無い。畳む。
    if (children.length === 1) return children[0];

    let sizes = (Array.isArray(n.sizes) ? n.sizes : [])
      .filter((s): s is number => typeof s === 'number' && Number.isFinite(s) && s > 0);
    if (sizes.length !== children.length) {
      if (sizes.length > 0) note('分割の幅の数が合わなかったので、均等に割り直しました。');
      sizes = new Array(children.length).fill(1 / children.length);
    }
    const total = sizes.reduce((a, b) => a + b, 0);
    sizes = sizes.map((s) => s / total);

    return { type: 'split', direction, sizes, children };
  }

  // type が無いが children がある、のような惜しい形は分割として拾う。
  if (Array.isArray(n.children)) {
    note('分割の指定が足りなかったので、横並びとして読みました。');
    return repairNode({ ...n, type: 'split' }, known, used, note);
  }
  if (typeof n.panel === 'string') {
    return repairNode({ type: 'panel', panel: n.panel }, known, used, note);
  }
  return undefined;
}

/** 配置に置かれている中身を、木の順に並べて返す。 */
export function panelsInOrder(node: LayoutNode): string[] {
  if (node.type === 'panel') return [node.panel];
  if (node.type === 'tabs') return [...node.panels];
  return node.children.flatMap(panelsInOrder);
}
