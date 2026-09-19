/**
 * 画面の部品を Node で動かすための、最小の DOM。
 *
 * 画面の中身（panels.js）には検査が1件も無かった。
 * 本物のブラウザで確かめるのが理想だが、それだと
 * 「動かせる環境でしか確かめられない」ものになり、結局は誰も回さない。
 *
 * ここで用意するのは、板が使う分だけ。
 * 足りない機能を足すのは、それを使う板を書いたときでよい。
 */

export interface StubNode {
  tagName: string;
  className: string;
  textContent: string;
  title: string;
  disabled: boolean;
  hidden: boolean;
  type: string;
  rows: number;
  placeholder: string;
  dataset: Record<string, string>;
  children: StubNode[];
  nodeValue?: string;
  parentNode?: StubNode;
  parentElement?: StubNode;
  style: Record<string, string>;
  closest(selector: string): StubNode | undefined;
  replaceChild(next: StubNode, old: StubNode): StubNode;
  readonly childNodes: StubNode[];
  readonly firstChild: StubNode | undefined;
  removeChild(child: StubNode): StubNode;
  /**
   * 押されたときの受け手。
   *
   * **出来事を受け取る形も許す。**本物の onclick には event が渡る。
   * 引数なしだけを許していたので、`e.stopPropagation()` を呼ぶ受け手を
   * 押す試験が書けなかった（型で弾かれる）。
   */
  onclick?: (e?: unknown) => unknown;
  onchange?: (e: unknown) => unknown;
  /** 打たれたときの受け手。エディタは Ctrl+S / Ctrl+F / Enter をここで見る。 */
  onkeydown?: (e: unknown) => unknown;
  oninput?: (e?: unknown) => unknown;
  /** 打ち込む欄の中身。textarea / input を使うパネルのために持つ。 */
  value: string;
  spellcheck: boolean;
  selectionStart: number;
  selectionEnd: number;
  /** 本物の textarea と同じ置き換え（Tab の字下げがここを通る）。 */
  setRangeText(text: string, start?: number, end?: number, mode?: 'select' | 'start' | 'end' | 'preserve'): void;
  setSelectionRange(start: number, end: number): void;
  focus(): void;
  addEventListener(type: string, fn: (e: unknown) => unknown): void;
  /** 付けた相手（addEventListener）と、`on*` の両方を呼ぶ。 */
  fire(type: string, event?: unknown): void;
  /** 見た目の組。パネルは付け外しでしか使わない。 */
  classList: {
    add(...names: string[]): void;
    remove(...names: string[]): void;
    toggle(name: string, on?: boolean): void;
    contains(name: string): boolean;
  };
  /** 自分を親から外す。 */
  remove(): void;
  append(...nodes: StubNode[]): void;
  appendChild(node: StubNode): StubNode;
  replaceChildren(...nodes: StubNode[]): void;
  /** 中身の文字列を全部つなげたもの。検査で「出ているか」を見るのに使う。 */
  readonly text: string;
  /** 押せるものを全部集める。 */
  buttons(): StubNode[];
}

export function createNode(tagName: string): StubNode {
  /** addEventListener で付いたもの。`on*` とは別に持つ（本物と同じ）。 */
  const listeners = new Map<string, Array<(e: unknown) => unknown>>();
  /** 自分が直に持つ文字。`textContent` の代入で入れ替わる。 */
  let own = '';
  /**
   * 欄の中身。
   *
   * **本物の欄は、入れた `\r\n` を `\n` に直して持つ**（Chromium で実測）。
   * ここを素の入れ物にしていると、CRLF のファイルを開いたときの振る舞いが
   * 本物と変わり、試験だけ通ってしまう。同じにそろえる。
   */
  let val = '';
  const node: StubNode = {
    tagName,
    className: '',
    /*
     * **本物と同じにする。**`textContent` への代入は、子を全部捨てて
     * 文字だけにする。ここを素の欄にしていたので、パネルが
     * `tray.textContent = ''` で並びを片づけても**子が残り**、
     * 「外したのに札が残っている」を試験が見られなかった。
     */
    get textContent() { return own; },
    set textContent(text: string) { own = text; node.children = []; },
    title: '',
    disabled: false,
    hidden: false,
    type: '',
    rows: 0,
    placeholder: '',
    dataset: {},
    children: [],
    get value() { return val; },
    set value(v: string) { val = tagName === 'textarea' ? String(v).replace(/\r\n/g, '\n') : String(v); },
    spellcheck: true,
    selectionStart: 0,
    selectionEnd: 0,
    /*
     * **本物と同じ置き換えを持たせる。**持っていなかったので、Tab の字下げは
     * 試験から一度も通っていなかった（呼べば落ちる）。動かない所ではなく、
     * **見ていない所**が在ることの方が困る。
     */
    setRangeText(text, start = node.selectionStart, end = node.selectionEnd, mode = 'preserve') {
      const before = node.value.slice(0, start);
      const after = node.value.slice(end);
      node.value = before + text + after;
      const stop = start + text.length;
      if (mode === 'end') { node.selectionStart = stop; node.selectionEnd = stop; }
      else if (mode === 'start') { node.selectionStart = start; node.selectionEnd = start; }
      else if (mode === 'select') { node.selectionStart = start; node.selectionEnd = stop; }
      else {
        // preserve: 置き換えた分だけずらす（本物と同じ）。
        const shift = text.length - (end - start);
        if (node.selectionStart > end) node.selectionStart += shift;
        else if (node.selectionStart > start) node.selectionStart = stop;
        if (node.selectionEnd > end) node.selectionEnd += shift;
        else if (node.selectionEnd > start) node.selectionEnd = stop;
      }
    },
    setSelectionRange(start, end) { node.selectionStart = start; node.selectionEnd = end; },
    focus() { /* 置く所が無いので、呼べることだけ */ },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type)!.push(fn);
    },
    fire(type, event) {
      const on = (node as unknown as Record<string, ((e: unknown) => unknown) | undefined>)[`on${type}`];
      if (typeof on === 'function') on(event ?? {});
      for (const fn of listeners.get(type) ?? []) fn(event ?? {});
    },
    append(...nodes) {
      node.children.push(...nodes);
      for (const c of nodes) { c.parentNode = node; c.parentElement = node; }
    },
    appendChild(child) {
      node.children.push(child);
      child.parentNode = node;
      child.parentElement = node;
      return child;
    },
    replaceChildren(...nodes) { node.children = [...nodes]; },
    // 本物では、文字だけの節は children に入らず childNodes にだけ入る。
    // 板は溜まりすぎたぶんを childNodes で数えて捨てるので、同じ名前を持たせる。
    get childNodes() { return node.children; },
    get firstChild() { return node.children[0]; },
    removeChild(child) {
      const at = node.children.indexOf(child);
      if (at >= 0) node.children.splice(at, 1);
      return child;
    },
    nodeValue: undefined,
    parentNode: undefined,
    parentElement: undefined,
    style: {},
    closest(selector: string) {
      const want = selector.split(',').map((x) => x.trim().replace(/^\./, ''));
      let at: StubNode | undefined = node;
      while (at) {
        if (want.some((c) => at!.className.split(/\s+/).includes(c))) return at;
        at = at.parentElement;
      }
      return undefined;
    },
    replaceChild(next, old) {
      const at = node.children.indexOf(old);
      if (at < 0) return old;
      // 本物のまとまりは、差し込むと中身がその場に展開される。
      const spread = next.tagName === '#fragment' ? next.children : [next];
      node.children.splice(at, 1, ...spread);
      for (const c of spread) { c.parentNode = node; c.parentElement = node; }
      return old;
    },
    get text() {
      return [own, ...node.children.map((c) => c.text)].join(' ').trim();
    },
    classList: {
      add(...names) {
        const has = new Set(node.className.split(/\s+/).filter(Boolean));
        for (const n of names) has.add(n);
        node.className = [...has].join(' ');
      },
      remove(...names) {
        const drop = new Set(names);
        node.className = node.className.split(/\s+/).filter((n) => n && !drop.has(n)).join(' ');
      },
      toggle(name, on) {
        const has = node.className.split(/\s+/).includes(name);
        const want = on ?? !has;
        if (want) node.classList.add(name); else node.classList.remove(name);
      },
      contains(name) { return node.className.split(/\s+/).includes(name); },
    },
    remove() {
      const parent = node.parentNode;
      if (parent) parent.removeChild(node);
    },
    buttons() {
      const out = node.tagName === 'button' ? [node] : [];
      for (const c of node.children) out.push(...c.buttons());
      return out;
    },
  };
  return node;
}

/**
 * 文字だけの節。板が append(document.createTextNode(...)) を使うため。
 * 見た目は持たないので、textContent だけ持てばよい。
 */
export function createText(text: string): StubNode {
  const node = createNode('#text');
  node.textContent = text;
  node.nodeValue = text;
  return node;
}

/**
 * まとまり。**本物では、差し込むと中身が展開されて空になる。**
 * そこまで真似ないと、差し込みの回数を数える試験が嘘になる。
 */
export function createFragment(): StubNode {
  return createNode('#fragment');
}

/** 文字だけの節を、上から順に拾う。色の見本を重ねるのに要る。 */
export function walkText(root: StubNode): StubNode[] {
  const out: StubNode[] = [];
  const walk = (n: StubNode) => {
    for (const c of n.children) {
      if (c.tagName === '#text') out.push(c);
      else walk(c);
    }
  };
  walk(root);
  return out;
}

/** panels.js を読み込む前に、document を用意する。 */
export function installDom(): void {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => createNode(tag),
    createTextNode: (text: string) => createText(text),
    createDocumentFragment: () => createFragment(),
    // 本物の TreeWalker は上から順に文字だけの節を返す。使うのはそれだけ。
    createTreeWalker: (root: StubNode) => {
      const nodes = walkText(root);
      let at = -1;
      return {
        currentNode: undefined as StubNode | undefined,
        nextNode(this: { currentNode?: StubNode }) {
          at += 1;
          this.currentNode = nodes[at];
          return this.currentNode;
        },
      };
    },
  };
  (globalThis as unknown as { NodeFilter: unknown }).NodeFilter = { SHOW_TEXT: 4 };
  /*
   * **覚えておく所（localStorage）。**
   *
   * 画面は、保存していない直しをここへ預ける（ブラウザを閉じても戻せるように）。
   * 本物と同じく、入れたものが文字で返るだけあればよい。
   */
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  };
}
