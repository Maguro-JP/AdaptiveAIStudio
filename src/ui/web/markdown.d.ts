/** 画面側の素の JS に、型だけ添える。中身は markdown.js が持つ。 */
export type Block =
  | { type: 'code'; lang: string; text: string; closed: boolean }
  | { type: 'heading'; level: number; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'para'; text: string };
export type Inline = { type: 'text' | 'code' | 'bold'; text: string };
export function parseBlocks(text: string): Block[];
export function parseInline(text: string): Inline[];
export function renderMarkdown(text: string, doc: Document, opts?: { copy?: (s: string) => unknown }): DocumentFragment;
