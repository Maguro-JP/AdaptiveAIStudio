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
  onclick?: () => unknown;
  onchange?: (e: unknown) => unknown;
  append(...nodes: StubNode[]): void;
  appendChild(node: StubNode): StubNode;
  replaceChildren(...nodes: StubNode[]): void;
  /** 中身の文字列を全部つなげたもの。検査で「出ているか」を見るのに使う。 */
  readonly text: string;
  /** 押せるものを全部集める。 */
  buttons(): StubNode[];
}

export function createNode(tagName: string): StubNode {
  const node: StubNode = {
    tagName,
    className: '',
    textContent: '',
    title: '',
    disabled: false,
    hidden: false,
    type: '',
    rows: 0,
    placeholder: '',
    dataset: {},
    children: [],
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
      return [node.textContent, ...node.children.map((c) => c.text)].join(' ').trim();
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
}
