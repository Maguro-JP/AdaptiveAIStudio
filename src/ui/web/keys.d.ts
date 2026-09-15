/** 画面側の素の JS に、型だけ添える。中身は keys.js が持つ。 */
export interface KeyLike { key: string; shiftKey?: boolean; isComposing?: boolean; keyCode?: number }
export function isSendKey(e: KeyLike): boolean;
export function isPlainEnter(e: KeyLike): boolean;
