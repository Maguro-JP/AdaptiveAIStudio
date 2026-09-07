/** 画面側の素の JS に、型だけ添える。中身は doing.js が持つ。 */
export const TOOL_VERB: Record<string, string>;
/** いま何を触っているかの、一行。知らない名前はそのまま出す。 */
export function doingText(name: string, summary?: string): string;
