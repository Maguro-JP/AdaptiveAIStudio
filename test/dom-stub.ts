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
    append(...nodes) { node.children.push(...nodes); },
    appendChild(child) { node.children.push(child); return child; },
    replaceChildren(...nodes) { node.children = [...nodes]; },
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

/** panels.js を読み込む前に、document を用意する。 */
export function installDom(): void {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => createNode(tag),
  };
}
